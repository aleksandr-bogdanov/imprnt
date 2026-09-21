import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { indexLines, loadRegistry } from "./load.ts";

/**
 * The only place the registry is ever written.
 *
 * TWO FACTS SHAPED ALL OF IT. The file is hand-edited and hand-promoted by a
 * person, and this runtime has no TOML writer, so a parse-and-serialize round
 * trip would drop every comment and reorder every key in a file whose comments
 * are the only notes anybody has. Each primitive is therefore a LINE operation
 * over the bytes that are there, and every byte it does not mean to touch is
 * still there afterwards.
 *
 * And a load alone is not enough to accept a candidate. A text edit can produce
 * a file that loads perfectly and says something other than what was asked for,
 * so the candidate is loaded AND its whole parsed structure is compared against
 * the one intended change. Only then is it renamed into place.
 *
 * A refusal leaves the candidate on disk beside the registry, on purpose: it is
 * the only record of what the hub was about to write, and a person reads it and
 * deletes it. It is kept under ONE name that each refusal replaces, because a
 * board page on the tailnet can press the same refused edit as often as it
 * likes, and a file per press would fill the card. The live file is never half
 * written, because the only thing that ever touches it is a rename.
 */
export class RegistryEditRefused extends Error {
  /** Which step refused: `path`, `value`, `load`, `diff` or `concurrent`. */
  readonly step: string;
  /** The candidate left behind, when there is one. */
  readonly candidate: string | null;
  constructor(step: string, message: string, candidate: string | null = null) {
    super(message);
    this.name = "RegistryEditRefused";
    this.step = step;
    this.candidate = candidate;
  }
}

/**
 * Two moments a check can stand in, so a candidate that means something else
 * and a hand edit landing mid-write are staged deterministically rather than by
 * racing the disk. Both default to nothing at all.
 */
export interface RegistryEditSeam {
  beforeValidate?(candidate: string): void | Promise<void>;
  beforeRename?(candidate: string): void | Promise<void>;
}

export interface RegistryEditOptions {
  seam?: RegistryEditSeam;
}

export interface RegistryEditResult {
  /** False when the file already said this, and then nothing was written. */
  changed: boolean;
}

/** What a TOML scalar this writer will render looks like. */
export type EditValue = string | number | boolean | string[];

function render(value: EditValue, where: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RegistryEditRefused("value", `${where} is ${value}, and a registry holds numbers`);
    return String(value);
  }
  if (Array.isArray(value) && value.every(one => typeof one === "string")) {
    return `[${value.map(one => JSON.stringify(one)).join(", ")}]`;
  }
  throw new RegistryEditRefused("value", `${where} is a ${typeof value}, and this writer renders strings, numbers, booleans and lists of strings`);
}

const isComment = (line: string): boolean => line.trim().startsWith("#");
const isBlank = (line: string): boolean => line.trim() === "";
const isHeader = (line: string): boolean => line.trim().startsWith("[");

/** Every header line in the file, by line number, in the order they appear. */
function headers(lines: string[]): number[] {
  return lines.flatMap((line, at) => (isHeader(line) ? [at] : []));
}

/** The nth `[[table]]` header, which is the nth entry of that array of tables. */
function headerOf(lines: string[], table: string, nth: number): number {
  const wanted = new RegExp(`^\\s*\\[\\[\\s*${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]\\]`);
  let seen = -1;
  for (const [at, line] of lines.entries()) {
    if (!wanted.test(line)) continue;
    seen += 1;
    if (seen === nth) return at;
  }
  return -1;
}

/**
 * An entry named as `agents[p1-lair]` or `run[door-fake]`, which is always its
 * ID.
 *
 * NEVER A POSITION, and that holds for an id that is all digits. The hub and
 * the board both hand this function an id somebody typed, an agent id may be
 * `0`, and read as a position `agents[0]` is whichever entry is first in the
 * file, which can be the other person's. A position is also wrong the moment
 * somebody reorders the file by hand. The position this module works with
 * afterwards is the one the id was found at, and nothing a caller says.
 */
function locate(data: Record<string, unknown>, path: string): { table: string; index: number } {
  const said = /^([A-Za-z0-9_-]+)\[([^\]]+)\]$/.exec(path.trim());
  if (!said) throw new RegistryEditRefused("path", `${path} is not an entry path, which reads agents[p1-lair] or run[door-fake]`);
  const [, table, which] = said;
  const list = data[table];
  if (!Array.isArray(list)) throw new RegistryEditRefused("path", `this registry has no ${table} entries at all`);
  const index = list.findIndex(one => (one as Record<string, unknown>)?.id === which);
  if (index < 0) throw new RegistryEditRefused("path", `this registry names no ${table} entry with the id ${which}`);
  return { table, index };
}

/**
 * The lines one entry owns: its own header, the notes directly above it, and
 * everything down to the next header.
 *
 * THE NOTE ABOVE THE HEADER BELONGS TO THE ENTRY and goes with it, because a
 * note left standing over the next entry would label that one wrongly. The
 * notes directly above the NEXT header belong to that one and stay where they
 * are, which is why the bound walks back over them. The bound is the next
 * header of ANY table, so removing the last agent of a file whose run entries
 * follow leaves every one of them alone.
 */
function blockOf(lines: string[], headerLine: number): { start: number; end: number } {
  let start = headerLine;
  while (start > 0 && isComment(lines[start - 1])) start -= 1;
  const next = headers(lines).find(at => at > headerLine);
  let end = next ?? lines.length;
  while (end - 1 > headerLine && isComment(lines[end - 1])) end -= 1;
  return { start, end };
}

/** The last line of an entry that is a key, which is where a new key goes after. */
function lastKeyLine(lines: string[], headerLine: number, end: number): number {
  for (let at = end - 1; at > headerLine; at -= 1) {
    if (!isBlank(lines[at]) && !isComment(lines[at])) return at;
  }
  return headerLine;
}

/** The same value twice, compared the way a person means it. */
function same(left: unknown, right: unknown): boolean {
  return Bun.deepEquals(JSON.parse(JSON.stringify(left ?? null)), JSON.parse(JSON.stringify(right ?? null)));
}

/**
 * Write the candidate, prove it, and rename it into place.
 *
 * `intend` is handed the structure the live file parsed to and returns what the
 * file must parse to afterwards. That comparison is the second half of the
 * validation and the one that catches an edit that landed on the wrong line.
 */
async function apply(file: string, text: string, intend: (before: Record<string, unknown>) => Record<string, unknown>,
  options: RegistryEditOptions): Promise<RegistryEditResult> {
  const before = readFileSync(file, "utf8");
  const live = loadRegistry(file);
  const wanted = intend(live.data as Record<string, unknown>);
  if (text === before) return { changed: false };
  // Beside the registry, with a name of its own per attempt, so two refusals do
  // not erase each other's evidence.
  const candidate = join(dirname(file), `.${basename(file)}.candidate-${crypto.randomUUID().slice(0, 8)}`);
  // The registry's OWN mode, because the file the hub renames into place is the
  // file a person reads and promotes, and a candidate written at the default
  // would widen it.
  const mode = statSync(file).mode & 0o777;
  writeFileSync(candidate, text, { encoding: "utf8", mode });
  try {
    await options.seam?.beforeValidate?.(candidate);
    let parsed: Record<string, unknown>;
    try {
      parsed = loadRegistry(candidate).data as Record<string, unknown>;
    } catch (error) {
      throw new RegistryEditRefused("load", `this edit makes a file the loader refuses: ${(error as Error).message}`, candidate);
    }
    if (!same(parsed, wanted)) {
      throw new RegistryEditRefused("diff",
        `this edit would have said something other than what was asked for, so ${file} was left alone`, candidate);
    }
    await options.seam?.beforeRename?.(candidate);
    // READ AGAIN, at the last moment. Somebody editing the file in an editor
    // while the hub applies a command from a phone is the case that loses work.
    if (readFileSync(file, "utf8") !== before) {
      throw new RegistryEditRefused("concurrent",
        `${file} changed while this edit was being prepared, so the edit was dropped rather than written over it`, candidate);
    }
    const handle = openSync(candidate, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(candidate, file);
  } catch (error) {
    throw keep(file, candidate, error);
  }
  const directory = openSync(dirname(file), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return { changed: true };
}

/**
 * What a failed edit leaves beside the registry: the refused candidate under
 * the one name each refusal replaces, so a person can read the last thing the
 * hub was refused and there is never more than one of them. Anything that is
 * not a refusal (a machine going away, a rename the filesystem refused) says
 * nothing a person needs, and its candidate is removed.
 */
function keep(file: string, candidate: string, error: unknown): unknown {
  if (!(error instanceof RegistryEditRefused)) {
    rmSync(candidate, { force: true });
    return error;
  }
  const refused = join(dirname(file), `.${basename(file)}.refused`);
  try {
    renameSync(candidate, refused);
  } catch {
    rmSync(candidate, { force: true });
    return new RegistryEditRefused(error.step, error.message, null);
  }
  return new RegistryEditRefused(error.step, error.message, refused);
}

/**
 * One array-of-tables block at the END of the file, which is where a new agent
 * goes: appending is the one edit that can never move a line somebody wrote.
 */
export async function appendEntry(file: string, table: string, block: Record<string, EditValue>,
  options: RegistryEditOptions = {}): Promise<RegistryEditResult> {
  const before = readFileSync(file, "utf8");
  const rendered = [`[[${table}]]`, ...Object.entries(block).map(([key, value]) => `${key} = ${render(value, `${table}.${key}`)}`)];
  const trailing = before.endsWith("\n");
  // The file ends the way its person left it, with or without a last newline.
  const body = trailing ? before.replace(/\n+$/, "\n") : before + "\n";
  const text = body + "\n" + rendered.join("\n") + (trailing ? "\n" : "");
  return await apply(file, text, before2 => {
    const list = Array.isArray(before2[table]) ? [...(before2[table] as unknown[])] : [];
    return { ...before2, [table]: [...list, block] };
  }, options);
}

/**
 * One key's line inside one entry, replaced where it is, or written as a new
 * line at the end of that entry's own keys when the file does not carry it yet.
 */
export async function setKey(file: string, entryPath: string, key: string, value: EditValue,
  options: RegistryEditOptions = {}): Promise<RegistryEditResult> {
  const before = readFileSync(file, "utf8");
  const lines = before.split("\n");
  const data = loadRegistry(file).data as Record<string, unknown>;
  const { table, index } = locate(data, entryPath);
  const headerLine = headerOf(lines, table, index);
  if (headerLine < 0) throw new RegistryEditRefused("path", `${entryPath} names an entry this file has no [[${table}]] header for`);
  const block = blockOf(lines, headerLine);
  const rendered = `${key} = ${render(value, `${entryPath}.${key}`)}`;
  // The loader's own index, so the line an edit changes and the line a refusal
  // points a person at are the same line.
  const known = indexLines(before).get(`${table}[${index}].${key}`);
  const at = known === undefined ? -1 : known - 1;
  const next = [...lines];
  if (at >= 0) {
    if (at <= headerLine || at >= block.end) {
      throw new RegistryEditRefused("path", `${entryPath}.${key} is on line ${at + 1}, which is outside that entry`);
    }
    // The indentation a person used is theirs, and only the value changes.
    next[at] = lines[at].slice(0, lines[at].length - lines[at].trimStart().length) + rendered;
  } else {
    next.splice(lastKeyLine(lines, headerLine, block.end) + 1, 0, rendered);
  }
  return await apply(file, next.join("\n"), before2 => {
    const list = [...(before2[table] as Record<string, unknown>[])];
    list[index] = { ...list[index], [key]: value };
    return { ...before2, [table]: list };
  }, options);
}

/** One entry's whole block, and nothing that belongs to the entry after it. */
export async function removeEntry(file: string, entryPath: string,
  options: RegistryEditOptions = {}): Promise<RegistryEditResult> {
  const before = readFileSync(file, "utf8");
  const lines = before.split("\n");
  const data = loadRegistry(file).data as Record<string, unknown>;
  const { table, index } = locate(data, entryPath);
  const headerLine = headerOf(lines, table, index);
  if (headerLine < 0) throw new RegistryEditRefused("path", `${entryPath} names an entry this file has no [[${table}]] header for`);
  const block = blockOf(lines, headerLine);
  const next = [...lines];
  next.splice(block.start, block.end - block.start);
  return await apply(file, next.join("\n"), before2 => {
    const list = [...(before2[table] as unknown[])];
    list.splice(index, 1);
    return { ...before2, [table]: list };
  }, options);
}
