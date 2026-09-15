import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The chat log is the record. The door appends every message in both directions
 * to one dated file per agent, before sending, one line per message. A loop's
 * own session is a cache and may vanish at any time, so this is what a spawned
 * session is fed from.
 */
export interface ChatLine {
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
  // log is not read to feed a day of it.
  for (let at = from - DAY_MS; at <= args.now.getTime(); at += DAY_MS) {
    const file = chatLogPath({ ...args, at: new Date(at) });
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      const line = JSON.parse(raw) as ChatLine;
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
