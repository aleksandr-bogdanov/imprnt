import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { indexLines, loadRegistry, RegistryRefused, type Registry } from "./load.ts";

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
 *
 * ONE WRITER AT A TIME, ACROSS PROCESSES. The hub applying a command and the
 * board setting a key are two processes on one machine, and two edits that
 * both read the file before either renames would each pass every check, and
 * the later rename would throw the earlier edit away while both callers were
 * told it applied. So every edit holds a kernel lock from its one read to its
 * rename. The lock is on the registry's DIRECTORY, because the file itself is
 * replaced by every rename and a lock on it would be a lock on a file that is
 * gone, and a lock file of its own would be one more file a person finds
 * beside the registry. The kernel drops the lock when its holder dies, so a
 * crashed writer never leaves the file locked.
 *
 * The file a person keeps may be a symbolic link to where it really lives, and
 * it may belong to a group other processes read it through. The edit goes to
 * the file the link points at, the link stays a link, and the new file gets the
 * old one's owner, group and mode, or the edit is refused rather than hand the
 * registry to somebody else.
 */
export class RegistryEditRefused extends Error {
  /**
   * Which step refused: `path`, `value`, `load`, `diff`, `concurrent`, `owner`, `locked` or `precondition`, and for a
   * whole-file replacement also `authority`, `stale` and `backup`.
   */
  readonly step: string;
  /** The candidate left behind, when there is one. */
  readonly candidate: string | null;
  /** Where the loader refused a candidate, by line and key, for a caller that must not repeat the loader's own sentence (it can echo a value). */
  readonly line: number | undefined;
  readonly key: string | undefined;
  constructor(step: string, message: string, candidate: string | null = null, where: { line?: number; key?: string } = {}) {
    super(message);
    this.name = "RegistryEditRefused";
    this.step = step;
    this.candidate = candidate;
    this.line = where.line;
    this.key = where.key;
  }
}

/**
 * Two moments a check can stand in, so a candidate that means something else
 * and a hand edit landing mid-write are staged deterministically rather than by
 * racing the disk. Both default to nothing at all.
 */
export interface RegistryEditSeam {
  /** Right after an edit has read the file it is about to change. */
  afterRead?(file: string): void | Promise<void>;
  beforeValidate?(candidate: string): void | Promise<void>;
  beforeRename?(candidate: string): void | Promise<void>;
  /** After the last read-back found the file unchanged, and before the rename. */
  afterCheck?(candidate: string): void | Promise<void>;
}

/**
 * A judgment on the registry an edit is ABOUT to change, made inside the writer's lock from
 * the very bytes the edit is built from. A caller that loaded the registry earlier, and then
 * waited on a database or on the lock, is judging a file that may have changed since; this is
 * judged against the file the edit is really about to replace.
 *
 * `ok` lets the edit go on. `ok` with `present` says the file already says what the edit
 * would have written, so nothing is written and the edit reports `changed: false`. Not `ok`
 * refuses the edit with `reason`, before a candidate exists, and the file is left as it is.
 */
export type RegistryPrecondition = (registry: Registry) => { ok: true; present?: boolean } | { ok: false; reason: string };

export interface RegistryEditOptions {
  seam?: RegistryEditSeam;
  /**
   * Asked by `appendEntry` (the one edit that has to know what it is appending to) and by `setKey` (a key whose old value decides whether
   * the new one may be written, like the runner a moved agent is bound to). Judged inside the writer's lock, on the bytes the edit is built from.
   */
  precondition?: RegistryPrecondition;
}

export interface RegistryEditResult {
  /** False when the file already said this, and then nothing was written. */
  changed: boolean;
}

const fileLocks = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const LOCK_EX = 2;
const LOCK_NB = 4;
/** How long an edit waits for another one to finish, which is a few renames' worth and more. */
const LOCK_WAIT_MS = 15_000;

/**
 * Run one edit while holding the registry's lock, handing it the path of the
 * file itself: where the link points when the path a person gave is a symbolic
 * link, and that path, spelled as they spelled it, when it is not.
 */
async function locked<T>(file: string, edit: (live: string) => Promise<T>): Promise<T> {
  const live = lstatSync(file).isSymbolicLink() ? realpathSync(file) : file;
  const directory = openSync(dirname(live), "r");
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (fileLocks.symbols.flock(directory, LOCK_EX | LOCK_NB) !== 0) {
      if (Date.now() >= deadline) {
        throw new RegistryEditRefused("locked",
          `${file} was being edited by another process for longer than ${LOCK_WAIT_MS / 1000} s, so this edit was not made`);
      }
      await Bun.sleep(10);
    }
    return await edit(live);
  } finally {
    // Closing the descriptor is what releases the lock.
    closeSync(directory);
  }
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
async function apply(file: string, live: string, read: { before: string; data: Record<string, unknown> }, text: string,
  intend: (before: Record<string, unknown>) => Record<string, unknown>, options: RegistryEditOptions): Promise<RegistryEditResult> {
  // THE BYTES THE EDIT WAS BUILT FROM, never a second read. A hand edit that
  // landed between two reads would be what the last check below compares
  // against, and the candidate, built from the first, would be renamed over it.
  const { before, data } = read;
  const wanted = intend(data);
  if (text === before) return { changed: false };
  // Beside the file itself, so the rename stays on one filesystem and replaces
  // the file rather than a symbolic link to it.
  const candidate = join(dirname(live), `.${basename(live)}.candidate-${crypto.randomUUID().slice(0, 8)}`);
  // The registry's OWN mode, because the file the hub renames into place is the
  // file a person reads and promotes, and a candidate written at the default
  // would widen it. Set again after the write, which the umask narrows.
  const was = statSync(live);
  const mode = was.mode & 0o777;
  writeFileSync(candidate, text, { encoding: "utf8", mode });
  try {
    chmodSync(candidate, mode);
    const made = statSync(candidate);
    if (made.uid !== was.uid || made.gid !== was.gid) {
      try {
        chownSync(candidate, was.uid, was.gid);
      } catch {
        throw new RegistryEditRefused("owner",
          `${file} belongs to user ${was.uid} and group ${was.gid}, and this process cannot give a new file that ` +
          `owner, so the edit was not made rather than hand the registry to somebody else`, candidate);
      }
    }
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
    // takes no lock, and a person editing by hand while the hub applies a
    // command from a phone is the case that loses work.
    if (readFileSync(live, "utf8") !== before) {
      throw new RegistryEditRefused("concurrent",
        `${file} changed while this edit was being prepared, so the edit was dropped rather than written over it`, candidate);
    }
    await options.seam?.afterCheck?.(candidate);
    const handle = openSync(candidate, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(candidate, live);
  } catch (error) {
    throw keep(live, candidate, error);
  }
  const directory = openSync(dirname(live), "r");
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
  const where = { line: error.line, key: error.key };
  try {
    renameSync(candidate, refused);
  } catch {
    rmSync(candidate, { force: true });
    return new RegistryEditRefused(error.step, error.message, null, where);
  }
  return new RegistryEditRefused(error.step, error.message, refused, where);
}

/**
 * One array-of-tables block at the END of the file, which is where a new agent
 * goes: appending is the one edit that can never move a line somebody wrote.
 */
export async function appendEntry(file: string, table: string, block: Record<string, EditValue>,
  options: RegistryEditOptions = {}): Promise<RegistryEditResult> {
  return await locked(file, async live => {
    const read = readLive(live);
    // Judged on the bytes this edit is built from, under the lock, before anything is prepared.
    const verdict = options.precondition?.(read.registry);
    if (verdict && !verdict.ok) throw new RegistryEditRefused("precondition", verdict.reason);
    if (verdict?.ok && verdict.present) return { changed: false };
    await options.seam?.afterRead?.(file);
    const { before } = read;
    const rendered = [`[[${table}]]`, ...Object.entries(block).map(([key, value]) => `${key} = ${render(value, `${table}.${key}`)}`)];
    const trailing = before.endsWith("\n");
    // The file ends the way its person left it, with or without a last newline.
    const body = trailing ? before.replace(/\n+$/, "\n") : before + "\n";
    const text = body + "\n" + rendered.join("\n") + (trailing ? "\n" : "");
    return await apply(file, live, read, text, before2 => {
      const list = Array.isArray(before2[table]) ? [...(before2[table] as unknown[])] : [];
      return { ...before2, [table]: [...list, block] };
    }, options);
  });
}

/** The one read an edit is built from: the bytes, and what they parse to. */
function readLive(live: string): { before: string; data: Record<string, unknown>; registry: Registry } {
  const before = readFileSync(live, "utf8");
  const registry = loadRegistry(live);
  return { before, data: registry.data as Record<string, unknown>, registry };
}

/**
 * One key's line inside one entry, replaced where it is, or written as a new
 * line at the end of that entry's own keys when the file does not carry it yet.
 */
export async function setKey(file: string, entryPath: string, key: string, value: EditValue,
  options: RegistryEditOptions = {}): Promise<RegistryEditResult> {
  return await locked(file, async live => {
    const read = readLive(live);
    // Judged on the bytes this edit is built from, under the lock, before anything is prepared (the same contract as `appendEntry`).
    const verdict = options.precondition?.(read.registry);
    if (verdict && !verdict.ok) throw new RegistryEditRefused("precondition", verdict.reason);
    if (verdict?.ok && verdict.present) return { changed: false };
    const { before, data } = read;
    const lines = before.split("\n");
    await options.seam?.afterRead?.(file);
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
    return await apply(file, live, read, next.join("\n"), before2 => {
      const list = [...(before2[table] as Record<string, unknown>[])];
      list[index] = { ...list[index], [key]: value };
      return { ...before2, [table]: list };
    }, options);
  });
}

/** One entry's whole block, and nothing that belongs to the entry after it. */
export async function removeEntry(file: string, entryPath: string,
  options: RegistryEditOptions = {}): Promise<RegistryEditResult> {
  return await locked(file, async live => {
    const read = readLive(live);
    const { before, data } = read;
    const lines = before.split("\n");
    await options.seam?.afterRead?.(file);
    const { table, index } = locate(data, entryPath);
    const headerLine = headerOf(lines, table, index);
    if (headerLine < 0) throw new RegistryEditRefused("path", `${entryPath} names an entry this file has no [[${table}]] header for`);
    const block = blockOf(lines, headerLine);
    const next = [...lines];
    next.splice(block.start, block.end - block.start);
    return await apply(file, live, read, next.join("\n"), before2 => {
      const list = [...(before2[table] as unknown[])];
      list.splice(index, 1);
      return { ...before2, [table]: list };
    }, options);
  });
}

/**
 * The whole file written again from what it parses to, saying exactly what it
 * said before.
 *
 * This is the one edit that is not a line operation, and it exists for a file
 * no person wrote: a converter's output that carries every table on one line,
 * which the three primitives above cannot locate an entry in. The proof is the
 * same as theirs, a load and a structure diff, and here the intended structure
 * is the file's own, so a render that changed one value is refused. A file
 * holding a note is refused before anything is rendered, because a person's
 * notes are the one thing a render from the parse cannot carry.
 */
export async function rewriteRegistry(file: string, render: (data: Record<string, unknown>) => string,
  options: RegistryEditOptions = {}): Promise<RegistryEditResult> {
  return await locked(file, async live => {
    // A note anywhere on a line, at its end as much as on its own, outside a
    // quoted value: `# ` inside a string is a value and stays. Asked of the
    // bytes before they are parsed, so the answer is about the note and not
    // about whether the file loads.
    const text = readFileSync(live, "utf8");
    // A multiline string can hold a note on its closing line that a scan by
    // line cannot tell from text. Neither the converter nor the editor ever
    // writes one, so a file holding one was written by hand and is theirs.
    if (text.includes('"""') || text.includes("'''")) {
      throw new RegistryEditRefused("multiline",
        `${file} carries a multiline string, which this rewrite does not carry, so the file was left alone`);
    }
    const noted = text.split("\n").findIndex(line => /^(?:[^"'#]|"(?:[^"\\]|\\.)*"|'[^']*')*#/.test(line));
    if (noted >= 0) {
      throw new RegistryEditRefused("notes",
        `${file} carries a note on line ${noted + 1}, and a rewrite from the parse would drop it, so the file was left alone`);
    }
    const read = readLive(live);
    await options.seam?.afterRead?.(file);
    return await apply(file, live, read, render(read.data), before => before, options);
  });
}

export interface RegistryReplaceOptions {
  /**
   * The sha256 of the bytes the live file must hold. Judged INSIDE the lock, on the bytes that are about to be replaced, and again at the
   * last moment before the rename, so a copy that was looked at outside the lock and then edited is never written over.
   */
  expect: string;
  /** The machine the candidate is loaded for: it is judged as the machine that will read it reads it. */
  machine?: string;
  seam?: RegistryEditSeam;
  /** Asked of the registry the candidate loads as, inside the lock: a reason refuses the replacement (step `authority`). It must not carry a value out of the file. */
  accept?: (registry: Registry) => string | null;
  /**
   * Asked inside the lock, after every other check and just before the last read-back: whether what authorised this replacement still stands
   * (the caller's own store, so a newer state published while this waited for the lock is not written over by an older one). False refuses (step `stale`).
   */
  fresh?: () => Promise<boolean>;
  /**
   * Handed the exact bytes about to be replaced (read inside the lock) and the path of the file that holds them, before the rename. A throw refuses
   * the replacement (step `backup`) and nothing is replaced: the caller that keeps a copy of what it overwrites is held to keeping it.
   */
  preserve?: (previous: Buffer, live: string) => void | Promise<void>;
}

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Steps whose candidate says nothing a person needs, so it is removed rather than kept beside the registry. */
const NOTHING_TO_KEEP = new Set(["concurrent", "stale", "backup", "precondition"]);

/**
 * The whole file replaced by exactly these bytes, and nothing else changed about it: the one edit that is not about a line. It is how a copy of
 * the registry is delivered to a machine that reads a copy.
 *
 * THE PROOF IS BYTE IDENTITY. The candidate is loaded for the machine that will read it (a file that does not load THERE, a placement file
 * that is missing on that machine, is refused and kept as `.refused`, exactly as an edit's candidate is), and the bytes read back from the
 * candidate must hash to the bytes asked for. There is no structure to compare, because the intended file IS the bytes.
 *
 * COMPARE-AND-SWAP ON THE LIVE BYTES. The replacement is made only when the live file still holds the bytes `expect` names, checked under the
 * lock before a candidate exists and read again at the last moment before the rename. A hand edit lands in between and is refused as
 * `concurrent`, and the edit survives. Bytes already equal to the wanted ones are `changed: false`.
 *
 * Nothing in a refusal repeats the loader's sentence, which can quote a value from the file: a refusal carries the line and the key.
 */
export async function replaceRegistry(file: string, bytes: Buffer, options: RegistryReplaceOptions): Promise<RegistryEditResult> {
  return await locked(file, async live => {
    const previous = readFileSync(live);
    const wanted = sha256Of(bytes);
    const was = sha256Of(previous);
    if (was === wanted) return { changed: false };
    if (was !== options.expect) {
      throw new RegistryEditRefused("precondition", `${file} is not the file this replacement was asked about, so it was left alone`);
    }
    await options.seam?.afterRead?.(file);
    const candidate = join(dirname(live), `.${basename(live)}.candidate-${crypto.randomUUID().slice(0, 8)}`);
    const had = statSync(live);
    const mode = had.mode & 0o777;
    writeFileSync(candidate, bytes, { mode });
    try {
      chmodSync(candidate, mode);
      const made = statSync(candidate);
      if (made.uid !== had.uid || made.gid !== had.gid) {
        try {
          chownSync(candidate, had.uid, had.gid);
        } catch {
          throw new RegistryEditRefused("owner",
            `${file} belongs to user ${had.uid} and group ${had.gid}, and this process cannot give a new file that ` +
            `owner, so the replacement was not made rather than hand the registry to somebody else`, candidate);
        }
      }
      await options.seam?.beforeValidate?.(candidate);
      let loaded: Registry;
      try {
        loaded = loadRegistry(candidate, { machine: options.machine });
      } catch (error) {
        const at = error instanceof RegistryRefused ? { line: error.line, key: error.key } : {};
        throw new RegistryEditRefused("load",
          `the registry this would put in place does not load here${"line" in at ? ` (line ${at.line})` : ""}`, candidate, at);
      }
      const why = options.accept?.(loaded) ?? null;
      if (why !== null) throw new RegistryEditRefused("authority", why, candidate);
      if (sha256Of(readFileSync(candidate)) !== wanted) {
        throw new RegistryEditRefused("diff", `the candidate is not the bytes that were asked for, so ${file} was left alone`, candidate);
      }
      await options.seam?.beforeRename?.(candidate);
      if (options.preserve) {
        try {
          await options.preserve(previous, live);
        } catch {
          throw new RegistryEditRefused("backup", `the bytes of ${file} could not be kept, so it was not replaced`, candidate);
        }
      }
      if (options.fresh && !(await options.fresh())) {
        throw new RegistryEditRefused("stale", `what authorised replacing ${file} no longer stands, so it was left alone`, candidate);
      }
      // READ AGAIN, at the last moment: after the backup and after the caller's own freshness question, which are the two things that wait.
      if (sha256Of(readFileSync(live)) !== was) {
        throw new RegistryEditRefused("concurrent",
          `${file} changed while it was being replaced, so the replacement was dropped rather than written over it`, candidate);
      }
      await options.seam?.afterCheck?.(candidate);
      const handle = openSync(candidate, "r+");
      try { fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(candidate, live);
    } catch (error) {
      if (error instanceof RegistryEditRefused && NOTHING_TO_KEEP.has(error.step)) {
        rmSync(candidate, { force: true });
        throw new RegistryEditRefused(error.step, error.message, null, { line: error.line, key: error.key });
      }
      throw keep(live, candidate, error);
    }
    const directory = openSync(dirname(live), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return { changed: true };
  });
}
