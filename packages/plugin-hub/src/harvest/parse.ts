/**
 * The harvester's reply, read by CODE into exactly three answers.
 *
 * The envelope is what the prompt asks for and what three real runs of the real
 * loop produced byte for byte, so it is parsed by two markers and
 * nothing else. Nothing is salvaged from a half-formed block: that is code
 * guessing at meaning on the write side, which the vault contract itself
 * forbids, and a note the machinery guessed at is a note nobody wrote.
 */
export const NOTE_OPEN = "=== NOTE ===";
export const NOTE_CLOSE = "=== END ===";

/**
 * How much of an unreadable reply travels into the diary.
 *
 * `said` lands in a ledger detail a household reads, and a whole essay there is
 * a row nobody reads.
 */
export const SAID_CAP = 2000;

export type HarvestReply =
  | { kind: "nothing" }
  | { kind: "notes"; notes: string[] }
  | { kind: "unreadable"; said: string };

/**
 * Three answers and no fourth.
 *
 * `nothing` is honoured as a SINGLE WORD, trimmed and case-insensitive, because
 * that is what the probe measured the loop producing and what the prompt asks
 * for. "Nothing is a valid answer" is L19 rule 3's own words: it moves the
 * watermark, because the slice was read and judged and the filing that
 * was owed was none.
 *
 * Anything that is neither the word nor one or more well-formed blocks is
 * UNREADABLE, which refuses the turn: an open with no close, a close with no
 * open, an empty block, and a reply with no marker at all.
 */
export function parseHarvestReply(text: string): HarvestReply {
  const raw = String(text ?? "");
  if (raw.trim().toLowerCase() === "nothing") return { kind: "nothing" };
  const unreadable = (): HarvestReply => ({
    kind: "unreadable",
    said: raw.slice(0, SAID_CAP),
  });

  const notes: string[] = [];
  let at = 0;
  for (;;) {
    const open = raw.indexOf(NOTE_OPEN, at);
    if (open < 0) break;
    const from = open + NOTE_OPEN.length;
    const close = raw.indexOf(NOTE_CLOSE, from);
    // An open with no close is half a note, and half a note is not a note.
    if (close < 0) return unreadable();
    const note = raw.slice(from, close).trim();
    if (note === "") return unreadable();
    notes.push(note);
    at = close + NOTE_CLOSE.length;
  }
  // No marker at all, and a close with no open, are the same answer: nothing
  // in this reply is a block, so nothing in it is a note.
  if (notes.length === 0) return unreadable();
  return { kind: "notes", notes };
}
