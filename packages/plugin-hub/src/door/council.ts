/**
 * A council: one question typed in a chat, answered by every council seat of
 * that person in parallel, merged ONCE by the agent whose chat it was typed
 * in. The seats' answers never reach the chat, only the merge does.
 *
 * What is here is the pure half: the fixed words each seat and the merger are
 * given, the ids, the sheet row and the merge body. The door writes the seats'
 * jobs (`requestCouncil`), the runner's settle marks each seat answered and
 * writes the merge row when the last one lands.
 */

/** The state sheet holding one row per open council, removed when its merge lands. */
export const COUNCIL_SHEET = "council";

/**
 * What every seat is told above the question. It says nothing about other
 * seats, because a seat that knows it is one of several starts hedging toward
 * the others instead of answering.
 */
export const SEAT_INSTRUCTION =
  "Answer the question below on your own. State your position and your reasons, " +
  "and name what you are unsure of. No preamble.";

/** What the merger is told under the seats' answers. */
export const MERGE_INSTRUCTION =
  "Write ONE answer to the question for the person: merge what the seats agree on, " +
  "and state each disagreement as a disagreement in one or two lines. No seat names, " +
  "no transcript, no preamble.";

/** The task a seat is fed: the instruction, then the question verbatim. */
export function seatTask(question: string): string {
  return `${SEAT_INSTRUCTION}\n\n${question}`;
}

/** The council's id, from the platform message's own id, so a replay lands nothing. */
export function councilIdOf(base: string): string {
  return `council:${base}`;
}

/** A seat's job id, under the council's. */
export function seatJobId(council: string, seat: string): string {
  return `${council}:${seat}`;
}

/** The merge row's id, under the council's. */
export function mergeIdOf(council: string): string {
  return `merge:${council}`;
}

/**
 * One open council, as the sheet holds it. `answered` maps a seat to its
 * report text, or to null for a seat that was refused or given up on, so a
 * dead seat closes rather than holds the council open. `late` is set by the
 * door once it has said the council is late, so a restarted door says it no
 * second time.
 */
export interface CouncilRow {
  person: string;
  agent: string;
  door: string;
  chat: string;
  task: string;
  seats: string[];
  at: string;
  answered: Record<string, string | null>;
  late?: string;
}

/** The seats the council is still waiting on. */
export function openSeatsOf(row: Pick<CouncilRow, "seats" | "answered">): string[] {
  return row.seats.filter((seat) => !Object.hasOwn(row.answered, seat));
}

/**
 * What the merger is fed: the question, each seat's answer under a numbered
 * heading, then the instruction. Seats are numbered and never named, so the
 * merge cannot carry a registry id into the chat.
 */
export function mergeBody(row: Pick<CouncilRow, "task" | "seats" | "answered">): string {
  const parts = [`Question:\n${row.task}`];
  row.seats.forEach((seat, at) => {
    const answer = row.answered[seat];
    parts.push(`Seat ${at + 1}:\n${typeof answer === "string" && answer !== "" ? answer : "no answer"}`);
  });
  parts.push(MERGE_INSTRUCTION);
  return parts.join("\n\n");
}
