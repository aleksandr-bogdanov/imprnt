import { existsSync, readFileSync } from "node:fs";
import { chatLogPath } from "../chatlog.ts";

/**
 * D-145, D-146. The slice: the lines of one chat between two instants that a
 * PERSON or an AGENT said, and nothing else.
 *
 * Two filters, and each is a rule rather than a hope. A machinery line is the
 * door speaking (D-129), and the probe measured the loop ignoring one once,
 * which is not the same as it never reading one. The demand phrase is a message
 * addressed to the machinery, and feeding it back to the harvester as
 * conversation would teach it that the household talks to itself.
 */
export interface SliceLine {
  /** ISO, the line's own. An `in` line's clock is the platform's. */
  at: string;
  direction: string;
  from: string;
  text: string;
}

/** D-146. Matched trimmed and lowercased, EXACTLY, in either language. */
export const DEMAND_PHRASES: Record<"en" | "ru", string> = {
  en: "harvest this",
  ru: "сохрани важное",
};

/**
 * D-145. A chat the hub has never harvested reaches back this far and no
 * further.
 *
 * The residue is stated rather than hidden: the rest of a longer log is on disk
 * and unharvested, and a one-off catch-up over it is a human's. The alternative
 * is a years-long log fed to a model in one message, which is worse.
 */
export const SLICE_MAX_DAYS = 30;

/** How far back `newestLine` walks looking for a line at all. */
export const NEWEST_MAX_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * EXACT, and never a prefix or a substring. A message that merely mentions the
 * phrase is a message, and a household whose ordinary sentences were eaten as
 * commands would have no way to tell that from a hub that had stopped reading.
 */
export function isDemand(text: string): boolean {
  const said = String(text ?? "").trim().toLowerCase();
  if (said === "") return false;
  return Object.values(DEMAND_PHRASES).some((phrase) => said === phrase);
}

/** The UTC day a line's own time falls in, as a millisecond anchor. */
function dayOf(at: number): number {
  const on = new Date(at);
  return Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate());
}

/**
 * Every line of every dated file that can hold one inside these two instants,
 * oldest file first, with the walk `readTail` already does and a lower bound
 * instead of a window.
 *
 * A HALF-WRITTEN LAST LINE IS TOLERATED AND NOTHING ELSE IS. The line a writer
 * can be in the middle of is the last line of the file it is appending to, so
 * that one is skipped when it will not parse. A corrupt line anywhere else is a
 * real defect and throwing is what makes it visible, which is the rule the
 * fixture's own reader already applies.
 */
function walk(
  where: { stateDir: string; person: string; agent: string },
  fromMs: number,
  untilMs: number,
): SliceLine[] {
  const files: string[] = [];
  for (let day = dayOf(fromMs) - DAY_MS; day <= dayOf(untilMs); day += DAY_MS) {
    const file = chatLogPath({ ...where, at: new Date(day) });
    if (existsSync(file)) files.push(file);
  }
  const out: SliceLine[] = [];
  files.forEach((file, nth) => {
    const lines = readFileSync(file, "utf8").split("\n").filter((raw) => raw.trim() !== "");
    lines.forEach((raw, at) => {
      try {
        out.push(JSON.parse(raw) as SliceLine);
      } catch (error) {
        if (nth !== files.length - 1 || at !== lines.length - 1) throw error;
        // A line an appender has not finished. It is not on disk yet as far as
        // any reader is concerned, and it will be on the next read.
      }
    });
  });
  return out;
}

/** Whose lines a harvest reads: this chat's two speakers and nobody else. */
function spoken(line: SliceLine, person: string, agent: string): boolean {
  return (line.from === person || line.from === agent) && !isDemand(line.text);
}

/**
 * The slice, oldest first. `from` is EXCLUSIVE and `until` is INCLUSIVE, which
 * is what stops a line being harvested twice at its own edge: the watermark
 * carries the last harvested line's own time, so that line must fall outside
 * the next slice and the one after it must fall inside.
 */
export async function readSlice(args: {
  stateDir: string;
  person: string;
  agent: string;
  /** The watermark's `at`, exclusive. Null reaches back `SLICE_MAX_DAYS`. */
  from: string | null;
  until: string;
  includeFrom?: boolean;
}): Promise<SliceLine[]> {
  const untilMs = Date.parse(args.until);
  const fromMs =
    args.from === null ? untilMs - SLICE_MAX_DAYS * DAY_MS : Date.parse(args.from);
  const where = { stateDir: args.stateDir, person: args.person, agent: args.agent };
  return walk(where, fromMs, untilMs)
    .filter((line) => {
      const at = Date.parse(line.at);
      return (at > fromMs || (args.includeFrom && at === fromMs)) && at <= untilMs && spoken(line, args.person, args.agent);
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The newest line of this chat a PERSON or an AGENT said, or null when nothing
 * inside `NEWEST_MAX_DAYS` was said at all.
 *
 * It is what the quiet clock measures from, so a machinery line the door wrote
 * never extends a quiet period and an agent's own reply always does: a chat the
 * agent is still talking in is a chat that is not over.
 */
export async function newestLine(args: {
  stateDir: string;
  person: string;
  agent: string;
  now: Date;
}): Promise<SliceLine | null> {
  const nowMs = args.now.getTime();
  const where = { stateDir: args.stateDir, person: args.person, agent: args.agent };
  const lines = walk(where, nowMs - NEWEST_MAX_DAYS * DAY_MS, nowMs).filter(
    (line) =>
      Date.parse(line.at) >= nowMs - NEWEST_MAX_DAYS * DAY_MS &&
      (line.from === args.person || line.from === args.agent),
  );
  if (lines.length === 0) return null;
  return lines.reduce((newest, line) =>
    Date.parse(line.at) > Date.parse(newest.at) ? line : newest,
  );
}

/**
 * What the model is shown: one line per message, oldest first, exactly as
 * `readTail` renders the tail. No preamble, because a harvester is fed ONE
 * message that is the prompt plus this, and `TAIL_PREAMBLE` exists to tell a
 * session that what follows is context it must not answer.
 */
export function renderSlice(lines: SliceLine[]): string {
  return lines.map((line) => `${line.at} ${line.from}: ${line.text}`).join("\n");
}
