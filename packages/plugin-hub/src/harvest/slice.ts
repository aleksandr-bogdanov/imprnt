import { existsSync, readFileSync } from "node:fs";
import { chatLogPath, validLine, type BadRecord } from "../chatlog.ts";

/**
 * The slice: the lines of one chat between two instants that a
 * PERSON or an AGENT said, and nothing else.
 *
 * Two filters, and each is a rule rather than a hope. A machinery line is the
 * door speaking, and the probe measured the loop ignoring one once,
 * which is not the same as it never reading one. The demand phrase and the
 * recovery command are messages addressed to the machinery, and feeding them
 * back to the harvester as conversation would teach it that the household
 * talks to itself.
 */
export interface SliceLine {
  /** ISO, the line's own. An `in` line's clock is the platform's. */
  at: string;
  direction: string;
  from: string;
  text: string;
}

/** Matched trimmed and lowercased, EXACTLY, in either language. */
export const DEMAND_PHRASES: Record<"en" | "ru", string> = {
  en: "harvest this",
  ru: "сохрани важное",
};

/**
 * A chat the hub has never harvested reaches back this far and no
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

/**
 * A recovery command, `/recover <agent>` or `/восстановить <agent>`, the
 * way the door recognises one: the verb at the very start of the message, in
 * any case, followed by whitespace or by nothing. The door routes a message
 * that matches to the recovery control and never to the agent, and the slice
 * drops it for the same reason it drops a demand, so the two must be one rule.
 * Untrimmed on purpose, because the door does not trim either.
 */
export function isRecoveryCommand(text: string): boolean {
  return /^\/(recover|восстановить)(?:\s|$)/i.test(String(text ?? ""));
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
 * ONE DAMAGED LINE COSTS ONLY ITSELF. A complete record that will not parse, or
 * that parses into something other than a chat line, is left where it is,
 * collected into `bad` by its file and its own 1-based line, and the rest of the
 * slice is read. That is the rule the tail and the appender already apply, and
 * refusing the whole walk instead jammed the chat that held the line: a person's
 * harvest demand is read inside acceptance, so the refusal took the batch with
 * it and every message after it waited for a hand repair.
 *
 * A HALF-WRITTEN LAST LINE COSTS NOTHING AND IS NOT NAMED. The line a writer can
 * be in the middle of is the last one with bytes in the newest file, so that one
 * alone is skipped in silence when it will not parse: it is not on disk yet as
 * far as any reader is concerned, and it will be there on the next read.
 */
function walk(
  where: { stateDir: string; person: string; agent: string },
  fromMs: number,
  untilMs: number,
  bad?: BadRecord[],
): SliceLine[] {
  const files: string[] = [];
  for (let day = dayOf(fromMs) - DAY_MS; day <= dayOf(untilMs); day += DAY_MS) {
    const file = chatLogPath({ ...where, at: new Date(day) });
    if (existsSync(file)) files.push(file);
  }
  const out: SliceLine[] = [];
  files.forEach((file, nth) => {
    // The raw split, so a line is named by the place it really holds in the
    // file. A blank line above the damaged one would otherwise shift the number
    // and send whoever reads the report to the wrong record.
    const raws = readFileSync(file, "utf8").split("\n");
    let lastWithBytes = raws.length - 1;
    while (lastWithBytes >= 0 && raws[lastWithBytes].trim() === "") lastWithBytes -= 1;
    raws.forEach((raw, index) => {
      if (raw.trim() === "") return;
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        if (nth === files.length - 1 && index === lastWithBytes) return;
        bad?.push({ file, line: index + 1 });
        return;
      }
      if (!validLine(record)) {
        bad?.push({ file, line: index + 1 });
        return;
      }
      out.push(record as SliceLine);
    });
  });
  return out;
}

/**
 * Whose lines a harvest reads: this chat's two speakers and nobody else, less
 * the two messages a person addresses to the machinery rather than to anybody.
 */
function spoken(line: SliceLine, person: string, agent: string): boolean {
  return (line.from === person || line.from === agent) && !isDemand(line.text) &&
    !isRecoveryCommand(line.text);
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
  /** Told about each damaged record the walk stepped over, by file and line. */
  skipBad?(bad: BadRecord): void | Promise<void>;
}): Promise<SliceLine[]> {
  const untilMs = Date.parse(args.until);
  const fromMs =
    args.from === null ? untilMs - SLICE_MAX_DAYS * DAY_MS : Date.parse(args.from);
  const where = { stateDir: args.stateDir, person: args.person, agent: args.agent };
  const bad: BadRecord[] = [];
  const lines = walk(where, fromMs, untilMs, bad);
  for (const one of bad) await args.skipBad?.(one);
  return lines
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
  /** Told about each damaged record the walk stepped over, by file and line. */
  skipBad?(bad: BadRecord): void | Promise<void>;
}): Promise<SliceLine | null> {
  const nowMs = args.now.getTime();
  const where = { stateDir: args.stateDir, person: args.person, agent: args.agent };
  const bad: BadRecord[] = [];
  const walked = walk(where, nowMs - NEWEST_MAX_DAYS * DAY_MS, nowMs, bad);
  for (const one of bad) await args.skipBad?.(one);
  const lines = walked.filter(
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
