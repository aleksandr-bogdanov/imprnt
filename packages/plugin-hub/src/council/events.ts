import type { StoreLike } from "../store/connect.ts";
import { causeForMaster } from "./causes.ts";
import { answerOf } from "./jobs.ts";
import type { CouncilRow, EventRow, MemberRow, ParticipantRow } from "./rows.ts";

/**
 * The rows the master reads when a council needs it, and the words in them.
 *
 * ONE EVENT PER CONDITION, WRITTEN ONCE. Each has a `dedupe` key made from the condition
 * (a round completing at a question revision, a member turning missing, a round left waiting
 * on its owner), so a redelivered settle, a second reconciler and a restart write it once and
 * move its queue time never. The queue time is the moment the event is written, by the store's
 * function, and the time of the request that started the round is only carried as provenance.
 *
 * AN EVENT IS NOT THE OWNER. It is a `report` for the master to read, and what it says is
 * the hub's own account of the council: who answered, who is missing and why (from the store's
 * own facts), and what the master may do next. It asks the master to call the tool; it
 * does not do anything the tool is for, and an ordinary reply to it is not the council's result.
 */

export const EVENT_LIMIT_PER_ANSWER = 6000;

const short = (id: string): string => id.replace(/^council:/, "").slice(0, 12);

interface Line { participant: ParticipantRow; member: MemberRow | undefined }

function heading(council: CouncilRow, what: string): string {
  return `[Council ${short(council.id)} · round ${council.current_round} · revision ${council.revision}] ${what}`;
}

const TOOL_HINT = [
  "This is an event from the hub for you, not a message from the owner. Call hub_council inspect for the council's full state and its revision before you act.",
];

/** Every required participant of the round has answered. */
export async function roundCompleteBody(store: StoreLike, council: CouncilRow, lines: readonly Line[]): Promise<string> {
  const parts: string[] = [heading(council, "Every required participant has answered."), "", `Question (revision ${council.question_revision}):`, council.question];
  for (const { participant, member } of lines) {
    const answer = member ? await answerOf(store, member) : null;
    parts.push("", `Participant ${participant.ordinal} (${participant.worker_agent}):`,
      answer ? answer.text + (answer.truncated ? "\n[cut here: call hub_council inspect with this participant for the whole answer]" : "") : "(no answer text recorded)");
  }
  parts.push("", ...TOOL_HINT,
    "- To give the owner the result: call hub_council continue with kind \"finalize\" in THIS turn, then write your synthesis as your reply. Keep real disagreement visible and say who held which view.",
    "- To have the participants challenge each other: only if the owner opted into debate (inspect shows debate_opt_in). Use kind \"debate_round\" with a brief for each participant you choose. There is no set number of rounds: stop when another would add nothing.",
    "- If neither fits, ask the owner what they want.",
    "A reply that does not call finalize is not the council's result: the council stays waiting for you.");
  return parts.join("\n");
}

/** One member cannot be waited for. Said once per member per input, at the moment it becomes missing. */
export function memberMissingBody(council: CouncilRow, line: Line): string {
  return [
    heading(council, `Participant ${line.participant.ordinal} (${line.participant.worker_agent}) is missing.`),
    "", `Why: ${causeForMaster(line.member?.cause ?? null)}.`, "",
    "Answers already received are kept, and other participants may still be running. Nothing is rerun, replaced or left out unless the owner chooses it.",
    ...TOOL_HINT,
    "Tell the owner who is missing and why, suggest a next step (wait, retry that participant, replace it, use the available answers, or stop the council) and wait for their choice.",
    "Record what they choose with hub_council continue, kind \"owner_decision\", citing the owner's message ids. Do not synthesize a partial result on your own.",
  ].join("\n");
}

/** Everyone who can still answer has, and some are missing: the owner's decision is all that is left. */
export function roundStalledBody(council: CouncilRow, answered: readonly Line[], missing: readonly Line[]): string {
  return [
    heading(council, "Every participant that can still answer has answered, and some are missing."),
    "", `Answered: ${answered.map(one => `${one.participant.ordinal} (${one.participant.worker_agent})`).join(", ") || "none"}.`,
    ...missing.map(one => `Missing: ${one.participant.ordinal} (${one.participant.worker_agent}): ${causeForMaster(one.member?.cause ?? null)}.`),
    "", ...TOOL_HINT,
    "The council is waiting for the owner. Tell them what is here and what is missing, suggest a next step and record their choice with hub_council continue, kind \"owner_decision\". Do not synthesize a partial result on your own.",
  ].join("\n");
}

/**
 * Write one event, unless this condition already has one. Returns the event's row, or null when
 * it already existed and nothing was written. The numbering is taken under the council row lock
 * the caller holds, so it has no gap.
 */
export async function emitEvent(
  tx: StoreLike,
  council: CouncilRow,
  event: { kind: EventRow["kind"]; dedupe: string; body: string; provenance?: Record<string, unknown> },
): Promise<{ id: string; seq: number } | null> {
  const [seen] = (await tx.sql`select 1 as one from council_event where council_id = ${council.id} and dedupe_key = ${event.dedupe}`) as unknown as { one: number }[];
  if (seen) return null;
  const [next] = (await tx.sql`select coalesce(max(seq), 0) + 1 as n from council_event where council_id = ${council.id}`) as unknown as { n: number }[];
  const seq = Number(next.n);
  const id = `council-event:${council.id}:${seq}`;
  await tx.sql`select hub_council_event_put(${id}, ${council.id}, ${seq}::integer, ${event.kind}, ${event.dedupe}, ${council.agent},
    ${council.person}, ${event.body}, ${JSON.stringify(council.return_route)}::text::jsonb, ${JSON.stringify(event.provenance ?? {})}::text::jsonb)`;
  return { id, seq };
}
