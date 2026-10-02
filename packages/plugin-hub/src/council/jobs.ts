import { taskDigest } from "../door/dispatch.ts";
import type { StoreLike } from "../store/connect.ts";
import type { DispatchEnvelope, JobSource } from "../store/inbound.ts";
import { conversationOfParticipant, type CouncilRow, type MemberRow, type ParticipantRow, type RoundRow } from "./rows.ts";

/**
 * The text a participant is given, and how a job for one member reaches the queue.
 *
 * A MEMBER'S INPUT IS AN ORDINARY JOB. It is the same row the dispatch command writes,
 * approved by the owner it names, for an agent that takes jobs alone, and its report is
 * recorded and never fed to anybody (the council reads answers through its own event). What
 * makes it a council's is only `dispatch.council_round`, which the store reads to tell a
 * member's answer from any other report. A LATER ROUND IS THE SAME CONVERSATION: the job names the
 * participant's worker conversation (`dispatch.conversation`), so it is put into what the worker
 * already knows, and the runner refuses it by name when that conversation cannot be honoured
 * rather than turning it into a new one.
 *
 * The words below are the hub's framing only. The master writes each brief, and it is put
 * in verbatim, under its own heading, so the owner can read exactly what a participant was told.
 */

/** What every participant is told above the question. It says nothing that would make a seat hedge toward the others. */
export const PARTICIPANT_INSTRUCTION =
  "You are one participant in a council convened for the owner. Give your own position and your reasons, " +
  "and say what you are unsure of. No preamble. Other participants are answering the same question " +
  "separately, so do not try to agree with anyone.";

export const ANSWER_CAP = 6000;

/** The first round's input for one participant: the question, the shared context and that participant's brief. */
export function firstTask(council: Pick<CouncilRow, "question" | "question_revision" | "context">, brief: string): string {
  const context = council.context.length === 0 ? [] : [
    "Context:", ...council.context.map((one, at) => `${at + 1}. ${one.text}`), "",
  ];
  return [
    PARTICIPANT_INSTRUCTION, "",
    `Question (revision ${council.question_revision}):`, council.question, "",
    ...context,
    "Your brief:", brief,
  ].join("\n");
}

/** What a further round's input carries beyond the brief: other participants' answers, verbatim and by number. */
export interface Evidence { participant: number; round: number; text: string; truncated: boolean }

export function evidenceText(evidence: readonly Evidence[]): string {
  if (evidence.length === 0) return "";
  return ["", "What the other participants answered, verbatim:", ...evidence.flatMap(one =>
    ["", `Participant ${one.participant}, round ${one.round}:`, one.text + (one.truncated ? "\n[cut here: the full answer is longer]" : "")])].join("\n");
}

/** A further round's input: debate and follow-up. The council's question is repeated so the conversation is self-contained. */
export function furtherTask(
  council: Pick<CouncilRow, "question" | "question_revision">,
  round: { number: number; kind: RoundRow["kind"] },
  brief: string,
  evidence: readonly Evidence[],
): string {
  const heading = round.kind === "debate"
    ? `The council continues with a debate round (round ${round.number}). Read what the others said, challenge what you disagree with, and change your view only for a reason.`
    : `The owner asked the council to continue (round ${round.number}).`;
  return [heading, "", `Question (revision ${council.question_revision}):`, council.question, evidenceText(evidence), "", "Your brief for this round:", brief]
    .filter((line, at, all) => !(line === "" && all[at - 1] === "")).join("\n");
}

/**
 * A corrected input for a participant whose earlier input could not be carried on: the
 * earlier one never started, or it finished before the stop landed. What it produced, if
 * anything, is kept as superseded and does not answer this.
 */
export function correctionTask(council: Pick<CouncilRow, "question" | "question_revision">, brief: string, hadOutput: boolean): string {
  return [
    "The owner corrected this council's question. Your earlier input is superseded" +
      (hadOutput ? ", and what you answered to it is kept only as a record: it does not answer this." : "."),
    "", `Question (revision ${council.question_revision}):`, council.question, "", "What changed for you:", brief,
  ].join("\n");
}

/**
 * The context an owner's continuation of an interrupted attempt carries when the interruption
 * was a correction. The old attempt was ended on purpose, so the words say that, and say what
 * output before the end is to be treated as: unfinished.
 */
export function correctionContext(council: Pick<CouncilRow, "question" | "question_revision">, brief: string): string {
  return [
    `Your earlier attempt was ended on purpose because the owner corrected this council's question. Whatever you wrote before it ended is unfinished and superseded.`,
    `The question is now (revision ${council.question_revision}):`, council.question, "", "What changed for you:", brief,
  ].join("\n");
}

export function jobIdOf(participant: Pick<ParticipantRow, "id">, round: number, inputRevision: number): string {
  return `${participant.id}:r${round}:i${inputRevision}`;
}

export interface MemberJob {
  council: CouncilRow;
  participant: ParticipantRow;
  round: number;
  inputRevision: number;
  questionRevision: number;
  task: string;
  /** The owner whose request or approval this rests on. */
  approvedBy: string;
  at: string;
}

/**
 * Put one member's input on the queue and record it as an input of its round, together. The
 * job goes through the store's function (the runner has no insert on the queue), which refuses
 * a job that names no council of this person, and a replay lands nothing twice.
 */
export async function enqueueMemberJob(tx: StoreLike, job: MemberJob, supersedes: number | null = null): Promise<string> {
  const id = jobIdOf(job.participant, job.round, job.inputRevision);
  const conversation = await conversationOfParticipant(tx, job.participant);
  const envelope: DispatchEnvelope = {
    dispatcher: job.council.agent,
    target: job.participant.worker_agent,
    approved: { by: job.approvedBy, at: job.at, digest: taskDigest(job.task), source: "council" },
    return: { agent: job.council.return_route.agent, door: job.council.return_route.door, chat: job.council.return_route.chat },
    council_round: { council: job.council.id, round: job.round, participant: job.participant.id, revision: job.inputRevision },
    ...(conversation ? { conversation } : {}),
  };
  const source: JobSource = { log_id: id, at: job.at, from: "council", text: job.task, dispatch: envelope, origin: "council" };
  await tx.sql`insert into round_member (council_id, round, participant_id, input_revision, question_revision, inbound_id, supersedes)
    values (${job.council.id}, ${job.round}, ${job.participant.id}, ${job.inputRevision}, ${job.questionRevision}, ${id}, ${supersedes})`;
  await tx.sql`select hub_council_job(${id}, ${job.council.person}, ${job.participant.worker_agent}, ${job.task}, ${JSON.stringify(source)}::text::jsonb)`;
  await tx.sql`update council_participant set first_inbound = ${id} where id = ${job.participant.id} and first_inbound is null`;
  return id;
}

/** The answer a member gave: the text of its report, cut to `ANSWER_CAP` and saying so. Null when nothing was reported. */
export async function answerOf(store: StoreLike, member: Pick<MemberRow, "inbound_id" | "report_id">): Promise<{ text: string; truncated: boolean } | null> {
  const id = member.report_id ?? (member.inbound_id ? `report:${member.inbound_id}` : null);
  if (id === null) return null;
  const [row] = (await store.sql`select body from inbound where id = ${id}`) as unknown as { body: string }[];
  if (!row) return null;
  if (row.body.length <= ANSWER_CAP) return { text: row.body, truncated: false };
  // Keep a whole UTF-16 pair: quoted answers become jsonb, which rejects a lone surrogate.
  const end = /[\uD800-\uDBFF]/.test(row.body[ANSWER_CAP - 1]) && /[\uDC00-\uDFFF]/.test(row.body[ANSWER_CAP])
    ? ANSWER_CAP - 1 : ANSWER_CAP;
  return { text: row.body.slice(0, end), truncated: true };
}
