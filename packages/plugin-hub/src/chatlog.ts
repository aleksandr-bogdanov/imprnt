import { dlopen, FFIType } from "bun:ffi";
import { appendFileSync, closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The chat log is the record. The door appends every message in both directions
 * to one dated file per agent, before sending, one line per message. A loop's
 * own session is a cache and may vanish at any time, so this is what a spawned
 * session is fed from.
 */
export interface ChatLine {
  id?: string;
  at: string;
  direction: "in" | "out";
  from: string;
  text: string;
}

/** What a spawned session is told the tail is, so it cannot read it as a human. */
export const TAIL_PREAMBLE =
  "[hub] chat log tail, for context only. Do not answer it. The message to answer arrives next.";

/** An estimate by construction, and the defaults it serves are until measured. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DAY_MS = 86_400_000;

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Dated from the line's own time in UTC, never from the clock of the writer. */
export function chatLogPath(args: {
  stateDir: string;
  person: string;
  agent: string;
  at: Date;
}): string {
  return join(
    args.stateDir,
    args.person,
    "chatlog",
    args.agent,
    `${day(args.at)}.jsonl`,
  );
}

export async function appendChatLine(
  args: { stateDir: string; person: string; agent: string },
  line: ChatLine,
): Promise<void> {
  const file = chatLogPath({ ...args, at: new Date(line.at) });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
}

/**
 * The tail a spawned session is fed: the newest lines inside `hours` that fit
 * `tokens`, oldest first, under the preamble. The budget counts the preamble,
 * and a line is kept or dropped whole, because half a message is a message
 * nobody sent. Empty when the log holds nothing in the window.
 */
export async function readTail(args: {
  stateDir: string;
  person: string;
  agent: string;
  now: Date;
  hours: number;
  tokens: number;
}): Promise<string> {
  const from = args.now.getTime() - args.hours * 3_600_000;
  const lines: ChatLine[] = [];
  // Only the dated files that can hold a line inside the window, so a year of
  // log is not read to feed a day of it. The walk starts at the UTC midnight of
  // the window's first day, so it steps onto the day the window ends in even
  // when the window is shorter than a day and crosses midnight.
  for (let at = Math.floor(from / DAY_MS) * DAY_MS; at <= args.now.getTime(); at += DAY_MS) {
    const file = chatLogPath({ ...args, at: new Date(at) });
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      // IMP-160. A record that is not a chat line is left out of the tail, the
      // way the door leaves it out of the log it appends to and names it by
      // file and line. Throwing here failed every spawn of this agent for good.
      let line: unknown;
      try { line = JSON.parse(raw); } catch { continue; }
      if (!validLine(line)) continue;
      if (Date.parse(line.at) >= from) lines.push(line);
    }
  }

  lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const rendered = lines.map((line) => `${line.at} ${line.from}: ${line.text}`);
  while (
    rendered.length > 0 &&
    estimateTokens([TAIL_PREAMBLE, ...rendered].join("\n")) > args.tokens
  ) {
    rendered.shift();
  }
  return rendered.length === 0 ? "" : [TAIL_PREAMBLE, ...rendered].join("\n");
}

const fileLocks = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/**
 * A record that is a chat line, which is what every reader of the log checks
 * before it reads a field. Exported so the harvest's own walk applies the same
 * rule as the tail and the appender rather than a second copy of it.
 */
export function validLine(value: unknown): value is ChatLine {
  if (!value || typeof value !== "object") return false;
  const line = value as ChatLine;
  return typeof line.at === "string" && Number.isFinite(Date.parse(line.at)) &&
    (line.direction === "in" || line.direction === "out") &&
    typeof line.from === "string" && typeof line.text === "string" &&
    (line.id === undefined || (typeof line.id === "string" && line.id !== ""));
}

/** A complete record that is not a chat line, by its file and 1-based line. */
export interface BadRecord { file: string; line: number }

/**
 * A kernel lock dies with its owner, including a writer killed before fsync.
 *
 * D-172 repairs only an incomplete LAST record, a write that never finished,
 * by truncating it. A complete record that is not a chat line is history and
 * is never truncated. By default it refuses the append, naming the file and the
 * line. A caller that passes `skipBad` (the door, IMP-160) instead leaves those
 * bytes where they are, does not count them as the record being appended, and
 * is told the file and line once the lock is released, so one bad line cannot
 * stop every message after it.
 */
export async function appendChatLineOnce(
  args: { stateDir: string; person: string; agent: string },
  line: ChatLine & { id: string },
  options: { skipBad?(bad: BadRecord): void | Promise<void> } = {},
): Promise<boolean> {
  if (!validLine(line) || !line.id) throw new Error("invalid chat log record");
  const file = chatLogPath({ ...args, at: new Date(line.at) });
  mkdirSync(dirname(file), { recursive: true });
  const skipped: BadRecord[] = [];
  const fd = openSync(file, "a+", 0o600);
  let fresh: boolean;
  try {
    const deadline = Date.now() + 10000;
    while (fileLocks.symbols.flock(fd, 2 | 4) !== 0) {
      if (Date.now() >= deadline) throw new Error("chat log lock timed out");
      await Bun.sleep(10);
    }
    const bytes = readFileSync(file, "utf8");
    const records = bytes.split("\n");
    let offset = 0;
    let truncate: number | null = null;
    let found = false;
    const refuse = (what: string, index: number): void => {
      if (!options.skipBad) throw new Error(`${what} complete chat log record at ${file}:${index + 1}`);
      skipped.push({ file, line: index + 1 });
    };
    for (const [index, raw] of records.entries()) {
      const last = index === records.length - 1;
      if (last && raw === "") break;
      let record: unknown;
      let parsed = true;
      try { record = JSON.parse(raw); }
      catch {
        if (last) {
          truncate = offset;
          break;
        }
        parsed = false;
        refuse("malformed", index);
      }
      if (parsed) {
        if (!validLine(record)) refuse("invalid", index);
        else if (record.id === line.id) found = true;
      }
      offset += Buffer.byteLength(raw) + 1;
    }
    if (truncate !== null) ftruncateSync(fd, truncate);
    const end = truncate === null ? bytes : Buffer.from(bytes).subarray(0, truncate).toString();
    if (end !== "" && !end.endsWith("\n")) writeSync(fd, "\n");
    if (!found) writeSync(fd, JSON.stringify(line) + "\n");
    fsyncSync(fd);
    // Persist newly created ancestors too, before readiness can expose the row.
    const root = resolve(args.stateDir);
    for (let path = resolve(dirname(file)); ; path = dirname(path)) {
      const directory = openSync(path, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      if (path === root || dirname(path) === path) break;
    }
    fresh = !found;
  } finally { closeSync(fd); }
  for (const bad of skipped) await options.skipBad!(bad);
  return fresh;
}
