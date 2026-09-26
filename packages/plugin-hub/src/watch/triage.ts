import type { Listing, WatchSpec } from "./evaluate.ts";
import { field } from "./record.ts";

/**
 * The one message a hunt hands its triage master, and the one shape it reads
 * back.
 *
 * The master has no tools, so the whole of what it can do is answer this text
 * with lines in the shape below. Its answer is untrusted (SPEC section 5): a
 * `tell` reaches the person as one capped line, an `ignore` and a `draft` are
 * stored on the listing's row and printed in the audit, and no line of it is
 * ever an instruction to anything with hands. A line that is not in the shape
 * is a verdict of `unreadable`, never a guess.
 */

export type VerdictWord = "tell" | "ignore" | "draft" | "unreadable";

export interface TriageVerdict {
  verdict: VerdictWord;
  text: string;
}

/** How long a verdict's own words may be, on the way into a row or a line. */
export const VERDICT_TEXT_MAX = 400;

export const TRIAGE_INSTRUCTION = [
  "You are a triage master with no tools. Above are listings a watch found, each under its id, with the owner's own notes on what they want.",
  "Answer with exactly one line per listing id, in one of these three shapes and nothing else:",
  "<id> | tell | <one line: why the owner should look at this one>",
  "<id> | ignore | <one line: why not>",
  "<id> | draft | <the one-line message you would send to the seller, which nobody sends without the owner>",
  "Every id above gets exactly one line. Write no other text before, between or after the lines.",
].join("\n");

/**
 * The batch as the master reads it: one block per listing with what the page
 * said and what the spec's owner wrote, then the fixed instruction.
 */
export function triageBody(items: { listing: Listing; spec: WatchSpec; from?: number | null; reason: string }[]): string {
  const blocks = items.map(({ listing, spec, from, reason }) => {
    const price = listing.price === null ? "no price" : `${listing.price} ${listing.currency ?? "EUR"}`;
    const lines = [
      `id: ${listing.id}`,
      `watch: ${spec.id}`,
      `title: ${listing.title}`,
      `price: ${price}${from == null ? "" : ` (was ${from})`}`,
      `seller: ${listing.seller_text === "" ? "-" : listing.seller_text}`,
      `url: ${listing.url === "" ? "-" : listing.url}`,
      `why here: ${reason}`,
    ];
    for (const soft of spec.soft ?? []) lines.push(`owner says: ${soft}`);
    if (spec.note) lines.push(`owner's note: ${spec.note}`);
    return lines.join("\n");
  });
  return `${blocks.join("\n\n")}\n\n${TRIAGE_INSTRUCTION}`;
}

const LINE = /^\s*(\S+)\s*\|\s*(tell|ignore|draft)\s*\|\s*(.*?)\s*$/i;

/**
 * The master's report as one verdict per listing id. The first well-formed
 * line for an id wins, a line about an id that was not in the batch is
 * ignored, and an id with no well-formed line is `unreadable`.
 */
export function parseVerdicts(report: string, ids: string[]): Map<string, TriageVerdict> {
  const out = new Map<string, TriageVerdict>();
  const wanted = new Set(ids);
  for (const raw of String(report ?? "").split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const id = m[1];
    if (!wanted.has(id) || out.has(id)) continue;
    out.set(id, { verdict: m[2].toLowerCase() as VerdictWord, text: field(m[3], VERDICT_TEXT_MAX) });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { verdict: "unreadable", text: "the report carries no line for this id" });
  return out;
}
