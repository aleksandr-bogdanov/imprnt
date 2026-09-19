import { readFileSync } from "node:fs";
import { absolute, digest, verifyInventory, version } from "./files.ts";
import { loadRegistry, readSetting } from "../registry/load.ts";
import { getPreset, presetId } from "../registry/presets.ts";
import { openStore } from "../store/connect.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { enqueueInbound, inboundId } from "../store/inbound.ts";
import { projectInbound } from "../chatlog/project.ts";
import { settleTurn } from "../runner/settle.ts";
import { writeCursor } from "../door/cursor.ts";
import { putRow } from "../records/statesheet.ts";
import { prepareReply } from "../door/reply.ts";
import { languageOf } from "../registry/entries.ts";

export async function prepareHandoff(manifest: any) {
  version(manifest);
  verifyInventory(manifest.sources);
  if (!manifest.batch_id || !Number.isFinite(Date.parse(manifest.freeze_at))) throw new Error("invalid handoff batch");
  const keys = new Set<string>();
  for (const item of manifest.items) {
    const key = `${item.door}/${item.chat}/${item.source_id}`;
    if (keys.has(key)) throw new Error("duplicate source inventory item");
    keys.add(key);
    if (!manifest.agents.includes(item.agent) || !["completed", "pending-input", "reply-owed"].includes(item.state)) throw new Error("invalid source inventory");
    if (!Number.isFinite(Date.parse(item.at)) || Date.parse(item.at) > Date.parse(manifest.freeze_at)) throw new Error("source time exceeds freeze");
    const cursor = manifest.cursors.find((c: any) => c.door === item.door && c.chat === item.chat);
    if (!cursor) throw new Error("source cursor missing");
    if (/^\d+$/.test(item.source_id) && /^\d+$/.test(cursor.cursor) && BigInt(cursor.cursor) < BigInt(item.source_id)) throw new Error("cursor precedes frozen source");
    for (const media of item.media ?? []) if (digest(readFileSync(absolute(media.path))) !== media.sha256) throw new Error("saved media digest changed");
    if (item.state === "reply-owed") {
      if (!Array.isArray(item.parts) || !item.parts.length) throw new Error("owed reply inventory missing");
      for (const [n, part] of item.parts.entries()) {
        if (part.seq !== n + 1 || typeof part.text !== "string") throw new Error("invalid reply parts");
        if (part.receipt && (part.receipt.outcome !== "delivered" || !part.receipt.id || !Number.isFinite(Date.parse(part.receipt.at)))) throw new Error("unknown delivery receipt");
      }
    }
  }
  const actual = manifest.items.map((i: any) => ({ source_id: i.source_id, state: i.state }));
  const order = (items: any[]) => JSON.stringify(items.slice().sort((a, b) => a.source_id.localeCompare(b.source_id)));
  if (order(actual) !== order(manifest.source_inventory)) throw new Error("source inventory omitted open item");
  return structuredClone(manifest);
}

export async function applyHandoff(input: any, options: { registryFile: string }) {
  const manifest = await prepareHandoff(input);
  const registry = loadRegistry(options.registryFile);
  if ((registry.data.hub as any).cutover_batch !== manifest.batch_id) throw new Error("cutover batch mismatch");
  for (const item of manifest.items.filter((i: any) => i.state !== "completed")) {
    if (!registry.agents.some(a => a.id === item.agent && a.person === item.person && a.door === item.door && a.chat === item.chat)) throw new Error("source agent route missing");
  }
  const door = await openStore({ url: storeUrlFor(registry, "hub_door") });
  const runner = await openStore({ url: storeUrlFor(registry, "hub_runner") });
  const stateDir = String(readSetting(registry, "hub.state_dir"));
  const lock = await door.sql.reserve();
  let locked = false;
  const fingerprint = digest(JSON.stringify(manifest));
  try {
    const [held] = await lock`select pg_try_advisory_lock(hashtext(${`handoff:${manifest.batch_id}`})) as held`;
    if (!held.held) throw new Error("handoff batch already running");
    locked = true;
    const gate = (await door.sql`select data from state_row where sheet='cutover' and id=${manifest.batch_id}`)[0];
    if (gate) {
      if (gate.data.digest !== fingerprint) throw new Error("changed handoff source manifest");
      if (gate.data.complete) return;
    }
    await putRow(door, "cutover", manifest.batch_id, { complete: false, digest: fingerprint });
    for (const item of manifest.items) {
      if (item.state === "completed") continue;
      const platform = item.platform ?? (registry.run.find(r => r.id === item.door) as any)?.platform ?? "telegram";
      const id = inboundId(platform, item.chat, item.source_id);
      const text = [item.text, ...(item.media ?? []).map((m: any) => `(${m.kind} ${m.path})`)].filter(Boolean).join("\n");
      const source = { log_id: id, at: item.at, door: item.door, chat: item.chat, sender_id: item.person, text, media: item.media ?? [] };
      const existing = (await door.sql`select person, agent, body, source from inbound where id=${id}`)[0];
      if (existing && (existing.person !== item.person || existing.agent !== item.agent || existing.body !== text || existing.source?.at !== item.at)) throw new Error("source identity conflicts with existing work");
      await door.sql.begin(async tx => { await enqueueInbound({ ...door, sql: tx as any }, { id, person: item.person, agent: item.agent, body: text, kind: item.kind, source, log_ready: false }); });
      await projectInbound(door, { stateDir, inboundId: id });
      if (item.state !== "reply-owed") continue;
      const agent = registry.agents.find(a => a.id === item.agent)!;
      const preset = getPreset(registry, agent.preset);
      const chunks: string[] = [], receipts: any[] = [];
      for (const part of item.parts) {
        const prepared = prepareReply(part.text, platform, languageOf(registry, item.person));
        for (const body of prepared) { chunks.push(body); receipts.push(part.receipt); }
      }
      await settleTurn(runner, { inboundId: id, chunks, receipts, imported: { batch: manifest.batch_id, source_id: item.source_id, at: item.at, parts: item.parts }, turn: {
        agent: agent.id, runner: agent.runner, preset: agent.preset, preset_id: presetId(preset), preset_settings: { ...preset }, input_tokens: null, cached_input_tokens: null, output_tokens: null,
        price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: ["imported", "resolved_model"], tail: false,
      } });
    }
    await door.sql.begin(async tx => {
      const inside = { ...door, sql: tx as any };
      for (const cursor of manifest.cursors) await writeCursor(inside, cursor.door, cursor.chat, cursor.cursor);
      await putRow(inside, "cutover", manifest.batch_id, { complete: true, digest: fingerprint, freeze_at: manifest.freeze_at, sources: manifest.sources, source_inventory: manifest.source_inventory });
    });
  } finally { if (locked) await lock`select pg_advisory_unlock_all()`; lock.release(); await runner.close(); await door.close(); }
}
