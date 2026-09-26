import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validLine, type ChatLine } from "../chatlog.ts";

/**
 * The chat logs, as the board reads them: the FILES on this machine, never
 * the store.
 *
 * The door writes one dated file per agent under the state directory, newest
 * line last, and that is the record. A page over them issues no statement,
 * which the fence around what a page reads counts on. A machine whose door is
 * elsewhere has no such files and its chats page says so, honestly, rather
 * than reaching for the store.
 *
 * NOTHING HERE OPENS A FILE FOR WRITING. Directories are listed and files
 * are read, and a directory that is not there is a chat nobody has had yet.
 */

/** A dated file's name, which is the UTC day the door dated it. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** How many lines one page shows before it offers the older days. */
export const CHAT_PAGE_LINES = 200;

/** The newest line an agent's log holds, or null for an agent nobody has talked to. */
export interface ChatNewest {
  day: string;
  at: string;
  from: string;
  /** The first eighty characters, which is what a list can show. */
  text: string;
}

export interface ChatDayLines {
  day: string;
  /** Newest first. */
  lines: ChatLine[];
}

export interface ChatPage {
  /** Newest day first, newest line first inside a day. */
  days: ChatDayLines[];
  /** The day to ask for with `before` for the next page, or null at the end. */
  older: string | null;
  /** Whether the log directory exists at all. */
  exists: boolean;
}

function logDir(stateDir: string, person: string, agent: string): string {
  return join(stateDir, person, "chatlog", agent);
}

/** The dated files of one agent, newest day first, or null when there is no directory. */
function daysOf(dir: string): string[] | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  return names
    .map((name) => DAY_FILE.exec(name)?.[1] ?? "")
    .filter((day) => day !== "")
    .sort()
    .reverse();
}

/** One day's lines, oldest first as the file holds them, bad records left out. */
function linesOf(dir: string, day: string): ChatLine[] {
  let text: string;
  try {
    text = readFileSync(join(dir, `${day}.jsonl`), "utf8");
  } catch {
    return [];
  }
  const out: ChatLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    // A record that is not a chat line is left out here the way the tail
    // leaves it out: a page that threw on one would show nobody anything.
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (validLine(line)) out.push(line);
  }
  return out;
}

/** By the line's own time, latest first, because a file's order is the order the door wrote and not the order things were said. */
function newestFirst(lines: ChatLine[]): ChatLine[] {
  return [...lines].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The newest line of one agent's log, or null. */
export function readChatNewest(args: { stateDir: string; person: string; agent: string }): ChatNewest | null {
  const dir = logDir(args.stateDir, args.person, args.agent);
  for (const day of daysOf(dir) ?? []) {
    const lines = linesOf(dir, day);
    if (lines.length === 0) continue;
    const last = newestFirst(lines)[0];
    return { day, at: last.at, from: last.from, text: last.text.slice(0, 80) };
  }
  return null;
}

/**
 * One page of one agent's chat: whole days, newest first, until the page
 * holds `CHAT_PAGE_LINES` lines or more.
 *
 * A DAY IS NEVER SPLIT. The page boundary is a day because `before` names a
 * day, and a day cut in two would be a page whose older link skipped the rest
 * of it. So a day with more lines than the page holds is shown whole, and the
 * count is the point at which no further day is added.
 */
export function readChatPage(args: { stateDir: string; person: string; agent: string; before?: string | null }): ChatPage {
  const dir = logDir(args.stateDir, args.person, args.agent);
  const every = daysOf(dir);
  if (every === null) return { days: [], older: null, exists: false };
  const before = args.before && /^\d{4}-\d{2}-\d{2}$/.test(args.before) ? args.before : null;
  const candidates = before === null ? every : every.filter((day) => day < before);
  const days: ChatDayLines[] = [];
  let shown = 0;
  let taken = 0;
  for (const day of candidates) {
    if (shown >= CHAT_PAGE_LINES) break;
    taken += 1;
    const lines = linesOf(dir, day);
    if (lines.length === 0) continue;
    days.push({ day, lines: newestFirst(lines) });
    shown += lines.length;
  }
  const older = taken < candidates.length ? candidates[taken - 1] : null;
  return { days, older, exists: true };
}
