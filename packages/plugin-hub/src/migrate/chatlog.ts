import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { appendChatLineOnce } from "../chatlog.ts";
import { absolute, digest, verifyInventory, version, writePrivate, within } from "./files.ts";

export interface LogManifest {
  version: number;
  batch_id: string;
  state_dir: string;
  timezone?: string;
  inventory: { path: string; sha256: string }[];
  sources: { root: string; person: string; agent: string; senders: Record<string, string> }[];
  reconciliation: { keep: { file: string; ordinal: number }; omit: { file: string; ordinal: number } }[];
}
export const historyInventoryPath = (state: string) => join(state, "migration-history.json");

function instant(day: string, clock: string, timezone: string): string {
  const target = `${day}T${clock}`;
  const utc = Date.parse(target + "Z");
  const format = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const candidates = new Set<number>();
  for (const shift of [-86400000, 0, 86400000]) {
    const probe = utc + shift;
    const wall = Date.parse(format.format(probe).replace(" ", "T") + "Z");
    const candidate = utc - (wall - probe);
    if (format.format(candidate).replace(" ", "T") === target) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new Error("ambiguous or invalid date");
  return new Date([...candidates][0]).toISOString();
}
export async function convertV2Chatlog(manifest: LogManifest) {
  version(manifest);
  absolute(manifest.state_dir);
  if (within(manifest.state_dir, resolve(import.meta.dir, "../../../.."))) throw new Error("private destination is inside checkout");
  verifyInventory(manifest.inventory);
  const known = new Set(manifest.inventory.map(i => i.path));
  const records: { file: string; ordinal: number; person: string; agent: string; format: string; line: { id: string; at: string; direction: "in" | "out"; from: string; text: string } }[] = [];
  for (const source of manifest.sources) {
    absolute(source.root);
    if (![source.person, source.agent].every(id => typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id))) throw new Error("invalid source identity");
    if (within(manifest.state_dir, source.root)) throw new Error("destination is inside source");
    for (const name of readdirSync(source.root).sort()) {
      if (!/\.(md|log)$/.test(name)) continue;
      const file = join(source.root, name);
      if (!known.has(file)) throw new Error(`source inventory missing: ${file}`);
      const match = /^(\d{4}-\d{2}-\d{2})\.(md|log)$/.exec(basename(file));
      if (!match) throw new Error(`ambiguous date: ${file}`);
      const [, day, format] = match;
      const lines = readFileSync(file, "utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (format === "md" && (!manifest.timezone || lines[1] !== `Date: ${day}` || lines[2] !== "" || !lines[0].startsWith("# "))) throw new Error(`timezone or date header missing: ${file}`);
      for (let n = format === "md" ? 3 : 0; n < lines.length; n++) {
        try {
          let at: string, sender: string, id: string, text: string;
          const ordinal = n - (format === "md" ? 3 : 0) + 1;
          if (format === "md") {
            const row = /^(\d{2}:\d{2}:\d{2})  ([^:]+): (.*)$/.exec(lines[n]);
            if (!row) throw new Error("malformed row");
            at = instant(day, row[1], manifest.timezone!); sender = row[2]; text = row[3].replaceAll("⏎", "\n");
            id = `v2-md:${digest(file)}:${ordinal}`;
          } else {
            const row = lines[n].split("\t");
            if (row.length !== 4 || !row[2] || !/^\d{4}-\d\d-\d\dT.*Z$/.test(row[0])) throw new Error("malformed row");
            at = new Date(row[0]).toISOString(); sender = row[1]; text = JSON.parse(row[3]);
            // An inbound id is already `<platform>:<chat>:<message>`, the id v3 gives the same
            // message, so a pending item the handoff carries dedupes against this line.
            id = /^(telegram|discord):/.test(row[2]) ? row[2] : `v2:${row[2]}`;
          }
          if (!Object.hasOwn(source.senders, sender)) throw new Error("unknown sender");
          if (typeof text !== "string") throw new Error("malformed text");
          const from = source.senders[sender];
          if (from !== source.person && from !== source.agent) throw new Error("unknown sender mapping");
          records.push({ file, ordinal, person: source.person, agent: source.agent, format, line: { id, at, direction: from === source.person ? "in" : "out", from, text } });
        } catch (error) { throw new Error(`${file}:${n + 1}: ${(error as Error).message}`); }
      }
    }
  }
  const omitted = new Set<string>();
  for (const decision of manifest.reconciliation ?? []) {
    for (const ref of [decision.keep, decision.omit]) if (!records.some(r => r.file === ref.file && r.ordinal === ref.ordinal)) throw new Error("reconciliation source missing");
    omitted.add(`${decision.omit.file}:${decision.omit.ordinal}`);
  }
  for (const a of records) for (const b of records) {
    if (a.format === b.format || a.agent !== b.agent || a.person !== b.person || a.line.at.slice(0, 10) !== b.line.at.slice(0, 10)) continue;
    if (!(manifest.reconciliation ?? []).some(d => [d.keep.file, d.omit.file].includes(a.file) && [d.keep.file, d.omit.file].includes(b.file))) throw new Error(`overlap requires reconciliation: ${a.file}`);
  }
  const path = historyInventoryPath(manifest.state_dir);
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { batches: {}, agents: {} };
  const fingerprint = digest(JSON.stringify(manifest));
  if (previous.batches[manifest.batch_id] && previous.batches[manifest.batch_id].digest !== fingerprint) throw new Error("changed source requires a new reviewed manifest batch");
  let count = 0, skipped = 0;
  for (const record of records.filter(r => !omitted.has(`${r.file}:${r.ordinal}`)).sort((a, b) => a.line.at.localeCompare(b.line.at))) {
    const fresh = await appendChatLineOnce({ stateDir: manifest.state_dir, person: record.person, agent: record.agent }, record.line);
    if (fresh) count++; else skipped++;
    const key = `${record.person}/${record.agent}`;
    const bounds = previous.agents[key] ?? { from: record.line.at, until: record.line.at };
    bounds.from = bounds.from < record.line.at ? bounds.from : record.line.at;
    bounds.until = bounds.until > record.line.at ? bounds.until : record.line.at;
    previous.agents[key] = bounds;
  }
  previous.batches[manifest.batch_id] = { digest: fingerprint, sources: manifest.inventory };
  writePrivate(path, JSON.stringify(previous) + "\n");
  return { count, skipped };
}
