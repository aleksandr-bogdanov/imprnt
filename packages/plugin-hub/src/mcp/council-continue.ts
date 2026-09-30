import { adoptPendingEvents, evidenceFor, replyOf } from "../council/access.ts";
import { allowFurtherRound, checkpointMinutes, checkpointReached, spendRound } from "../council/checkpoint.ts";
import { enqueueMemberJob, firstTask, furtherTask } from "../council/jobs.ts";
import { fenceCouncilWork } from "../council/fence.ts";
import { chainOf, currentInputs, omittedFor, reconcileInside, summarize, type CorrectionPlan } from "../council/reconcile.ts";
import { drift, resolveWorker } from "../council/roster.ts";
import {
  TERMINAL, conversationOfParticipant, createdAtOf, membersOf, participantOf, participantsOf, patchCouncil, patchMember, readCouncil, recordDecision,
  type CouncilRow, type MemberRow, type ParticipantRow,
} from "../council/rows.ts";
import { chooseHold } from "../recovery/holds.ts";
import type { StoreLike } from "../store/connect.ts";
import { HUB_COUNCIL, ToolError, type ToolReply } from "./contracts.ts";
import type { BriefItem, ContinueRequest } from "./council-contract.ts";
import type { McpBinding } from "./handlers.ts";
import { Undo, operationFor, refusal, requireMaster, runRequest, type Since } from "./requests.ts";
import type { Registry } from "../registry/load.ts";

/**
 * `hub_council continue`: what the master does with a council once it is running.
 *
 * THE KINDS AND WHAT EACH NEEDS
 *
 *   finalize        the master's disposition, called from the attempt whose reply is to be the result. It is tied to
 *                   THAT attempt (whatever put the master in it: the council's event or the owner's message that
 *                   chose), and the council is complete only when that attempt settles. A reply with no finalize is
 *                   not a result.
 *   owner_decision  the owner's choice about a missing participant (wait, retry, replace, use_available) or about
 *                   the checkpoint (extend). It cites the owner's messages, and is recorded with what they were.
 *   follow_up       the owner asks the same participants more, in the conversations they already have. It starts a
 *                   new authorization epoch, which is the only thing that does.
 *   debate_round    participants read and challenge one another, in the same conversations. Needs the owner's opt-in,
 *                   saved at the start or recorded now from fresh owner messages that ask for it; the same roster; a
 *                   completed round; and a checkpoint that allows a further round. There is no round count.
 *   correction      the owner changed the question. The master names the affected participants; theirs is the only work
 *                   that is interrupted, and nothing new is fed to a running attempt until it is shown to be over.
 *                   It is accepted, journaled and acted on (what had not started is disabled, what runs is asked to
 *                   end) at any time, before or after the checkpoint: the owner has said that work is outdated.
 *
 * A further round the checkpoint blocks (a debate round, a retry, a replacement) is NOT recorded and does not spend the
 * owner's message: the reply says the council is waiting for the owner, and how to record their answer. A correction is
 * the one exception, because stopping outdated work is not starting further work: the correction is recorded, the stop is
 * asked for, and only the corrected input waits, saved and shown as waiting, for the owner's extension.
 */

interface Ctx {
  binding: McpBinding;
  tx: StoreLike;
  council: CouncilRow;
  request: ContinueRequest;
  sender: string;
  registry: Registry;
  participants: ParticipantRow[];
  members: MemberRow[];
  operation: string;
  attempt: string | null;
  at: string;
  now: Date;
}

/**
 * A round the master may follow with another of its own, inside the period the owner authorized: a round has completed and the master has it.
 * A council that is complete or stopped is not one of these. Its only way back to work is the owner's own follow-up (`followUp`), which is
 * the explicit transition that starts a new period; a branch that produces work without going through it (a debate round with no new sources, a
 * retry or a replacement of a member that was left out) would open a terminal council again behind the owner's back.
 */
const SETTLED_ROUNDS: readonly CouncilRow["lifecycle"][] = ["waiting_master", "assessing"];
/** The states in which the owner's choice about a missing participant may start work: a council that is going on and is not being finalized or stopped. */
const WORKING: readonly CouncilRow["lifecycle"][] = ["running", "waiting_owner", "waiting_master", "assessing"];
const ACTIVE = (participants: readonly ParticipantRow[]) => participants.filter(one => one.state === "active");

const isTerminal = (council: Pick<CouncilRow, "lifecycle">): boolean => (TERMINAL as readonly string[]).includes(council.lifecycle);

/** The named way out of a terminal council: the owner's follow-up, which starts a new period in the same conversations. */
const FOLLOW_UP_WAY = `the owner's own follow-up (kind "follow_up", citing their message) is the one thing that opens a council again: it starts a new period in the same participants' conversations, and a debate can be asked for in it`;

function blockedByCheckpoint(x: Ctx): Undo {
  const minutes = checkpointMinutes(x.registry);
  return new Undo(replyOf(x.council, { status: "waiting_owner", stage: "checkpoint", cause: "checkpoint",
    message: `The ${minutes}-minute checkpoint passed at ${new Date(x.council.checkpoint_deadline).toISOString()} and this would start further work, so nothing was started and nothing was recorded. ` +
      `A round in progress may finish and you may synthesize. Ask the owner whether to go on and how far (another interval of minutes, or a number of further rounds). ` +
      `Record their answer with kind "owner_decision", decision {choice: "extend", extension_scope: {minutes: n} or {rounds: n}}, citing their message. A follow-up the owner asks for starts a new period by itself.` }));
}

function refuseNow(x: Ctx, cause: string, message: string): never {
  throw new Undo(refusal(x.council.id, cause, message));
}

/** Members the current round has, keyed by participant, newest input. */
const inputsOf = (x: Ctx) => currentInputs(x.council, x.participants, x.members);

// ---- finalize -------------------------------------------------------------------------------------------------

async function attemptEnded(tx: StoreLike, attempt: string): Promise<boolean> {
  const [row] = (await tx.sql`select state from execution where id = ${attempt}`) as unknown as { state: string }[];
  return !row || ["interrupted", "stopped", "failed"].includes(row.state);
}

async function finalize(x: Ctx): Promise<ToolReply> {
  const { council, tx } = x;
  if (x.attempt === null) refuseNow(x, "closed", "finalize is called from a turn of yours: the reply that turn ends with becomes the result, and there is no turn here");
  const open = council.lifecycle === "waiting_master" || council.lifecycle === "assessing"
    || (council.lifecycle === "preparing_result" && council.finalize !== null && council.finalize.attempt !== x.attempt && await attemptEnded(tx, council.finalize.attempt));
  if (!open) refuseNow(x, "closed", `the council is ${council.lifecycle.replaceAll("_", " ")}, so it cannot be finalized now`);
  const omitted = await omittedFor(tx, council);
  const sum = summarize(council, x.participants, x.members, omitted);
  if (sum.open.length > 0 || sum.missing.length > 0 || sum.stale.length > 0 || sum.answered.length === 0) {
    refuseNow(x, "closed", "not every required participant has an answer at the current question revision, and the owner has not recorded that the available answers will do");
  }
  // A participant left out by the owner's choice that answered after all is used: it is no longer missing.
  const stillOmitted = [...omitted].filter(id => sum.omitted.some(one => one.participant.id === id && one.member.state !== "answered"));
  const [attempt] = (await tx.sql`select inbound_id from execution where id = ${x.attempt}`) as unknown as { inbound_id: string | null }[];
  await adoptPendingEvents(tx, council, x.attempt);
  await recordDecision(tx, { council: council.id, kind: "finalize", conversation: x.binding.conversation, request_key: x.request.request_key, operation: x.operation,
    sources: [], by: null, attempt: x.attempt, payload: { mode: stillOmitted.length > 0 ? "use_available" : "all", omitted: stillOmitted, note: x.request.message ?? null } });
  await patchCouncil(tx, council.id, { lifecycle: "preparing_result", waiting: null,
    finalize: { attempt: x.attempt, inbound: attempt?.inbound_id ?? null, at: x.at, mode: stillOmitted.length > 0 ? "use_available" : "all", omitted: stillOmitted } });
  const now = (await readCouncil(tx, council.id))!;
  return replyOf(now, { operation: x.operation, stage: "preparing_result",
    message: "Recorded. Write the council's synthesis as the reply of THIS turn: it becomes the result when the turn ends, and it is delivered to the owner as your reply. Keep real disagreement visible and say who held which view." +
      (stillOmitted.length > 0 ? " The owner chose to go without some participants; say so." : "") });
}

// ---- owner decisions ------------------------------------------------------------------------------------------

function missingIds(x: Ctx, ids: readonly string[]): { participant: ParticipantRow; member: MemberRow }[] {
  const omitted = new Set<string>();
  const sum = summarize(x.council, x.participants, x.members, omitted);
  return ids.map((id) => {
    const found = sum.missing.find(one => one.participant.id === id);
    if (!found) throw new ToolError("invalid_arguments", `${id} is not a participant that is missing from this round: only a missing participant can be waited for, retried, replaced or left out`);
    return found;
  });
}

async function retryMember(x: Ctx, one: { participant: ParticipantRow; member: MemberRow }): Promise<string> {
  const { tx, council } = x;
  const { participant, member } = one;
  if (member.inbound_id !== null) {
    const chain = await chainOf(tx, member.inbound_id);
    const [hold] = (await tx.sql`select cause, state, revision, execution_id from replay_hold where inbound_id = ${chain[chain.length - 1]}`) as unknown as
      { cause: string; state: string; revision: number; execution_id: string }[];
    if (hold && (hold.state === "held" || hold.state === "keep_held")) {
      // The recovery choice the store already has, made by the owner: a linked new attempt with what is known about the
      // old one, queued once the old one is shown to be over. The interrupted input itself is never fed again.
      const outcome = await chooseHold(tx, { attempt: hold.execution_id, agent: participant.worker_agent, revision: hold.revision, choice: "continue", by: x.sender,
        evidence: { source: "council", council: council.id, decision: "retry", messages: x.request.source_message_ids ?? [] }, context: x.request.message });
      if (outcome === "stale-revision" || outcome === "unknown-attempt" || outcome === "closed" || outcome === "invalid-choice") {
        throw new ToolError("stale_revision", "what is known about that participant's interrupted attempt changed: inspect the council again and ask the owner again");
      }
      return `${participant.id}: the owner's choice to continue its interrupted attempt is recorded (${outcome === "continuing" ? "queued" : "waiting for its process to be shown gone"})`;
    }
  }
  if (member.inbound_id === null) {
    const why = drift(x.registry, council.person, [council.agent], { worker_ref: participant.worker_agent, preset_ref: participant.preset_name ?? "", preset_id: participant.preset_id ?? "", machine: participant.machine ?? "",
      profile: participant.profile, profile_id: participant.profile_id });
    if (why !== null) throw new ToolError("invalid_roster", `${participant.worker_agent} is still not what was approved (${why}): replace it instead`);
  }
  const revisions = x.members.filter(m => m.participant_id === participant.id && m.round === member.round).map(m => m.input_revision);
  const conversation = await conversationOfParticipant(tx, participant);
  const task = conversation === null ? firstTask(council, participant.brief)
    : furtherTask(council, { number: member.round, kind: "follow_up" }, participant.brief, []);
  await enqueueMemberJob(tx, { council, participant, round: member.round, inputRevision: Math.max(...revisions) + 1, questionRevision: council.question_revision,
    task, approvedBy: x.sender, at: x.at }, member.input_revision);
  await patchMember(tx, { council: council.id, round: member.round, participant: participant.id, input_revision: member.input_revision },
    { state: "superseded", cause: { ...(member.cause ?? { kind: "unknown" }), detail: "the owner chose to try this participant again with a new input" } });
  return `${participant.id}: a new input was queued for it, by the owner's choice`;
}

async function decide(x: Ctx): Promise<ToolReply> {
  const { tx, council } = x;
  const d = x.request.decision!;
  const sources = x.request.source_message_ids ?? [];
  const record = (kind: string, payload: Record<string, unknown>) =>
    recordDecision(tx, { council: council.id, kind, conversation: x.binding.conversation, request_key: x.request.request_key, operation: x.operation,
      sources, by: x.sender, attempt: x.attempt, payload: { round: council.current_round, ...payload, note: x.request.message ?? null } });
  const saw: string[] = [];
  let stage = "recorded";
  let said = "Recorded.";

  // A COUNCIL THAT IS COMPLETE OR STOPPED HAS NO MISSING PARTICIPANT TO DECIDE ABOUT. One finalized with `use_available` still has members that never answered,
  // and one that was stopped still has members that were missing: a retry or a replacement recorded in them would queue jobs into a council whose
  // lifecycle stays terminal, work nobody's epoch authorizes and no reconcile ever completes. The decision that produces work is refused unless the council is
  // going on and is not being finalized or stopped; the rest of the decisions (wait, use_available, extend) are refused in a terminal council or one that is stopping,
  // where they change nothing. What reopens a council is the owner's follow-up, and the refusal says so.
  if (isTerminal(council) || council.lifecycle === "stopping") {
    refuseNow(x, "closed", `the council is ${council.lifecycle}, so nothing in it can be decided any more (${d.choice} is refused): ${FOLLOW_UP_WAY}.`);
  }
  if ((d.choice === "retry" || d.choice === "replace") && !WORKING.includes(council.lifecycle)) {
    refuseNow(x, "closed", `the council is ${council.lifecycle.replaceAll("_", " ")}, so a ${d.choice} cannot start work in it now`);
  }

  if (d.choice === "extend") {
    const scope = d.extension_scope;
    if ("minutes" in scope) {
      const from = checkpointReached(council, x.now) ? x.now : new Date(council.checkpoint_deadline);
      await patchCouncil(tx, council.id, { checkpoint_deadline: new Date(from.getTime() + scope.minutes * 60_000),
        extension: { kind: "minutes", at: x.at, source_message_ids: [...sources], minutes: scope.minutes } });
      said = `Recorded: the owner extended the checkpoint by ${scope.minutes} minutes.`;
    } else {
      const left = (council.extension?.kind === "rounds" ? council.extension.rounds_left ?? 0 : 0) + scope.rounds;
      await patchCouncil(tx, council.id, { extension: { kind: "rounds", at: x.at, source_message_ids: [...sources], rounds_left: left } });
      said = `Recorded: the owner allowed ${scope.rounds} further round${scope.rounds === 1 ? "" : "s"} past the checkpoint (${left} in all).`;
    }
    await record("extend", { scope });
    stage = "checkpoint_extended";
  } else if (d.choice === "wait") {
    const found = missingIds(x, d.affected_ids);
    await patchCouncil(tx, council.id, { waiting: { ...(council.waiting ?? { kind: "members_missing", members: found.map(one => one.participant.id) }), owner_choice: "wait", at: x.at } });
    await record("wait", { affected: d.affected_ids });
    said = "Recorded: the owner chose to wait. Nothing changes; these participants stay as they are and the council stays waiting for them.";
    stage = "waiting";
  } else if (d.choice === "use_available") {
    missingIds(x, d.affected_ids);
    await record("use_available", { affected: d.affected_ids, omitted: d.affected_ids });
    stage = "using_available";
    said = "Recorded: the owner chose to go on without these participants. They are named as left out; you may finalize with the answers that are in, and you should say who was left out.";
  } else if (d.choice === "retry") {
    const found = missingIds(x, d.affected_ids);
    const allowance = allowFurtherRound(council, x.now);
    if (!allowance.ok) throw blockedByCheckpoint(x);
    for (const one of found) saw.push(await retryMember(x, one));
    if (allowance.spends) await spendRound(tx, council);
    await record("retry", { affected: d.affected_ids });
    stage = "retrying";
    said = "Recorded: the owner chose to try these participants again. Nothing else was rerun.";
  } else if (d.choice === "replace") {
    const [target] = missingIds(x, d.affected_ids);
    const allowance = allowFurtherRound(council, x.now);
    if (!allowance.ok) throw blockedByCheckpoint(x);
    const spec = d.replacement_spec;
    const others = ACTIVE(x.participants).filter(one => one.id !== target.participant.id).map(one => one.worker_agent);
    const resolved = resolveWorker(x.registry, council.person, [council.agent, ...others], spec);
    const ordinal = Math.max(...x.participants.map(one => one.ordinal)) + 1;
    const id = `${council.id}:p${ordinal}`;
    const revision = council.roster_revision + 1;
    await tx.sql`insert into council_participant (id, council_id, ordinal, worker_agent, preset_name, preset_id, preset_snapshot, machine, runner, brief, replaces, roster_revision, profile, profile_id)
      values (${id}, ${council.id}, ${ordinal}, ${resolved.worker_ref}, ${resolved.preset_ref}, ${resolved.preset_id}, ${JSON.stringify(resolved.preset_snapshot)}::text::jsonb,
              ${resolved.machine}, ${resolved.runner}, ${resolved.brief}, ${target.participant.id}, ${revision}, ${JSON.stringify(resolved.profile ?? {})}::text::jsonb, ${resolved.profile_id ?? null})`;
    await tx.sql`update council_participant set state = 'replaced' where id = ${target.participant.id}`;
    const fresh = (await participantOf(tx, id))!;
    await enqueueMemberJob(tx, { council, participant: fresh, round: council.current_round, inputRevision: 1, questionRevision: council.question_revision,
      task: firstTask(council, resolved.brief), approvedBy: x.sender, at: x.at });
    await tx.sql`update council_round set evidence = evidence || ${JSON.stringify({ roster_revision: revision })}::text::jsonb where council_id = ${council.id} and round = ${council.current_round}`;
    await patchCouncil(tx, council.id, { roster_revision: revision });
    if (allowance.spends) await spendRound(tx, council);
    await record("replace", { affected: d.affected_ids, replacement: { participant: id, worker: resolved.worker_ref, preset: resolved.preset_id, machine: resolved.machine } });
    saw.push(`${id}: joins the round in place of ${target.participant.id}, with a conversation of its own`);
    stage = "replaced";
    said = "Recorded: the owner chose to replace that participant. The replacement is a new participant linked to the old one, which keeps its identity and whatever it produced.";
  }
  await reconcileInside(tx, council.id);
  await adoptPendingEvents(tx, (await readCouncil(tx, council.id))!, x.attempt);
  const now = (await readCouncil(tx, council.id))!;
  return replyOf(now, { operation: x.operation, stage, message: said, extra: saw.length > 0 ? { evidence: saw } : {} });
}

// ---- further rounds -------------------------------------------------------------------------------------------

/** The participants a further round is for, each with the brief written for it, checked against the council. */
async function chosenFor(x: Ctx, kind: "debate" | "follow_up"): Promise<{ participant: ParticipantRow; brief: BriefItem }[]> {
  const ids = x.request.participants ?? [];
  const briefs = x.request.briefs ?? [];
  const active = ACTIVE(x.participants);
  for (const id of ids) if (!active.some(one => one.id === id)) throw new ToolError("unknown_participant", `${id} is not an active participant of this council`);
  if (new Set(briefs.map(one => one.participant_id)).size !== briefs.length || briefs.length !== ids.length || briefs.some(one => !ids.includes(one.participant_id))) {
    throw new ToolError("invalid_arguments", "there is exactly one brief for each participant chosen, and none for anyone else");
  }
  const out: { participant: ParticipantRow; brief: BriefItem }[] = [];
  for (const id of ids) {
    const participant = active.find(one => one.id === id)!;
    if (await conversationOfParticipant(x.tx, participant) === null) {
      throw new ToolError("invalid_arguments", `participant ${participant.ordinal} never started, so there is no conversation of its own to continue for a ${kind === "debate" ? "debate round" : "follow-up"}: retry or replace it first`);
    }
    out.push({ participant, brief: briefs.find(one => one.participant_id === id)! });
  }
  return out;
}

async function openFurther(x: Ctx, kind: "debate" | "follow_up", patch: Record<string, unknown>): Promise<{ round: number; queued: string[] }> {
  const { tx, council } = x;
  const chosen = await chosenFor(x, kind === "debate" ? "debate" : "follow_up");
  const round = council.current_round + 1;
  const epoch = typeof patch.epoch === "number" ? patch.epoch : council.epoch;
  await tx.sql`insert into council_round (council_id, round, kind, question_revision, epoch, evidence)
    values (${council.id}, ${round}, ${kind}, ${council.question_revision}, ${epoch},
            ${JSON.stringify({ source_message_ids: x.request.source_message_ids ?? [], roster_revision: council.roster_revision })}::text::jsonb)`;
  const queued: string[] = [];
  for (const { participant, brief } of chosen) {
    const evidence = await evidenceFor(tx, x.participants, x.members, brief.evidence_refs);
    queued.push(await enqueueMemberJob(tx, { council, participant, round, inputRevision: 1, questionRevision: council.question_revision,
      task: furtherTask(council, { number: round, kind: kind === "debate" ? "debate" : "follow_up" }, brief.text, evidence), approvedBy: x.sender, at: x.at }));
  }
  await patchCouncil(tx, council.id, { current_round: round, lifecycle: "running", waiting: null, finalize: null, completed_at: null, ...patch });
  return { round, queued };
}

async function debateRound(x: Ctx): Promise<ToolReply> {
  const { tx, council } = x;
  if (isTerminal(council)) {
    refuseNow(x, "closed", `the council is ${council.lifecycle}: a debate round is the master's own next step inside a period the owner authorized, and this one is over, so nothing was queued (${FOLLOW_UP_WAY}).`);
  }
  if (!SETTLED_ROUNDS.includes(council.lifecycle)) refuseNow(x, "closed", `the council is ${council.lifecycle.replaceAll("_", " ")}: a debate round starts only after a round has completed`);
  const [last] = (await tx.sql`select round, state, evidence from council_round where council_id = ${council.id} order by round desc limit 1`) as unknown as
    { round: number; state: string; evidence: { roster_revision?: number } }[];
  const omitted = await omittedFor(tx, council);
  const sum = summarize(council, x.participants, x.members, omitted);
  if (!last || last.state !== "complete" || sum.open.length > 0 || sum.missing.length > 0 || sum.stale.length > 0) refuseNow(x, "closed", "the latest round is not a completed comparison of every required participant");
  if ((last.evidence.roster_revision ?? 1) !== council.roster_revision) refuseNow(x, "closed", "the roster changed since the latest completed round, so a debate would not be among the same participants: run the changed roster through a round first");
  let optIn = council.debate_opt_in;
  if (optIn === null) {
    if (!x.request.source_message_ids) refuseNow(x, "debate_not_opted_in", "debate is opt-in and the owner has not asked for it. Ask them; if they say yes, call again with source_message_ids citing the message in which they asked for a debate. Nothing else can turn it on.");
    optIn = { kind: "later", source_message_ids: [...x.request.source_message_ids], at: x.at };
  }
  if (x.sender === "") refuseNow(x, "closed", "no owner is on record for this council, so a debate round cannot be approved: ask the owner and cite their message in source_message_ids");
  const allowance = allowFurtherRound(council, x.now);
  if (!allowance.ok) throw blockedByCheckpoint(x);
  const opened = await openFurther(x, "debate", { debate_opt_in: optIn });
  if (allowance.spends) await spendRound(tx, council);
  if (council.debate_opt_in === null) {
    await recordDecision(tx, { council: council.id, kind: "debate_opt_in", conversation: x.binding.conversation, request_key: x.request.request_key, operation: x.operation,
      sources: x.request.source_message_ids ?? [], by: x.sender, attempt: x.attempt, payload: { kind: "later" } });
  }
  await recordDecision(tx, { council: council.id, kind: "debate_round", conversation: x.binding.conversation, request_key: x.request.request_key, operation: x.operation,
    sources: x.request.source_message_ids ?? [], by: x.sender, attempt: x.attempt, payload: { round: opened.round, participants: x.request.participants, note: x.request.message ?? null } });
  await adoptPendingEvents(tx, (await readCouncil(tx, council.id))!, x.attempt);
  const now = (await readCouncil(tx, council.id))!;
  return replyOf(now, { operation: x.operation, stage: "debate_round",
    message: `Debate round ${opened.round} started in the participants' own conversations. Its answers will come back to you as one event. There is no set number of rounds: decide when another would add nothing.`,
    extra: { round: opened.round, queued: opened.queued } });
}

async function followUp(x: Ctx): Promise<ToolReply> {
  const { tx, council } = x;
  if (!(["complete", "stopped", "waiting_master", "assessing"] as const).includes(council.lifecycle as never)) {
    refuseNow(x, "closed", `the council is ${council.lifecycle.replaceAll("_", " ")}: finish or resolve the round in progress first`);
  }
  if (council.lifecycle === "stopped" && x.members.some(one => one.round === council.current_round && ["stopping", "superseding"].includes(one.state))) {
    refuseNow(x, "closed", "the stop has not finished for every participant");
  }
  const minutes = checkpointMinutes(x.registry);
  const next = council.epoch + 1;
  const opened = await openFurther(x, "follow_up", { epoch: next, epoch_started_at: x.now, checkpoint_deadline: new Date(x.now.getTime() + minutes * 60_000), extension: null,
    epoch_authority: { source_message_ids: [...(x.request.source_message_ids ?? [])], at: x.at } });
  await recordDecision(tx, { council: council.id, kind: "follow_up", conversation: x.binding.conversation, request_key: x.request.request_key, operation: x.operation,
    sources: x.request.source_message_ids ?? [], by: x.sender, attempt: x.attempt, payload: { round: opened.round, epoch: next, participants: x.request.participants, note: x.request.message ?? null } });
  await adoptPendingEvents(tx, (await readCouncil(tx, council.id))!, x.attempt);
  const now = (await readCouncil(tx, council.id))!;
  return replyOf(now, { operation: x.operation, stage: "follow_up",
    message: `Round ${opened.round} started in the same conversations. The owner's request opened a new period of ${minutes} minutes; the earlier answers were not rerun.`,
    extra: { round: opened.round, epoch: next, queued: opened.queued } });
}

// ---- correction -------------------------------------------------------------------------------------------------

async function correction(x: Ctx): Promise<ToolReply> {
  const { tx, council } = x;
  if (!(["running", "waiting_owner", "waiting_master", "assessing"] as const).includes(council.lifecycle as never)) {
    refuseNow(x, "closed", council.lifecycle === "complete" || council.lifecycle === "stopped"
      ? `the council is ${council.lifecycle}: to ask its participants more, use a follow_up`
      : `the council is ${council.lifecycle.replaceAll("_", " ")}, so a correction cannot be applied now`);
  }
  const ids = x.request.participants ?? [];
  const briefs = x.request.briefs ?? [];
  const inputs = inputsOf(x);
  for (const id of ids) if (!inputs.some(one => one.participant.id === id)) throw new ToolError("unknown_participant", `${id} has no input in the council's current round, so there is nothing of it to correct`);
  if (new Set(briefs.map(one => one.participant_id)).size !== briefs.length || briefs.length !== ids.length || briefs.some(one => !ids.includes(one.participant_id))) {
    throw new ToolError("invalid_arguments", "there is exactly one brief for each affected participant, and none for anyone else");
  }
  // THE CHECKPOINT DOES NOT DECIDE WHETHER THE OWNER'S CORRECTION IS ACCEPTED, only whether the corrected input may START. The owner has
  // said the work on the old question is outdated: it is recorded and journaled, what had not started is disabled and what is running is
  // asked to end now, however long the council has been going. Whether a further input may be given to the participants is then the
  // checkpoint's, and with it closed the correction is saved, shown as waiting for the owner's extension, and starts (once the process is
  // shown to be over) when they extend. Nothing here resets the period or extends the deadline.
  const allowance = allowFurtherRound(council, x.now);
  const permitted = allowance.ok;
  const revision = council.question_revision + 1;
  const affected = inputs.filter(one => ids.includes(one.participant.id));
  const unaffected = inputs.filter(one => !ids.includes(one.participant.id));

  // 1. THE FENCE FIRST (`council/fence.ts`, the same one a stop uses): every job of the affected participants that is not answered is gated (ascending
  // agent order, before anything is read), THEN what is owned is read and each running attempt is asked to end, and an earlier choice of the owner's that
  // was still waiting for a process to be shown over (a retry) is superseded by this correction with the store's own choice, its result checked. Read
  // in that order, "nothing of this participant is running" is a fact and not a moment that passed between a read and a gate; and a continuation the
  // earlier choice had already queued is found here, gated and asked to end like any other job, and is never taken for the corrected input.
  const messages = x.request.source_message_ids ?? [];
  const operationOf = (participant: string) => `${x.operation}:${participant}`;
  const fence = await fenceCouncilWork(tx, {
    council: council.id, participants: ids,
    gate: job => ({ operation: `council-correct:${job.id}`, evidence: { council: council.id, correction: revision } }),
    stop: owned => ({ operation: operationOf(owned.participant ?? ""), by: x.sender, evidence: { council: council.id, correction: revision, messages } }),
    supersede: { by: x.sender, evidence: { source: "council", council: council.id, superseded_by: "correction", correction: x.operation, messages } },
  });
  const evidence: { participant: string; input: string; message: string }[] = [];
  for (const one of affected) {
    const { participant, member } = one;
    // The chain AFTER the fence: a continuation that was queued before the correction got here is its end, and it is what the member waits on.
    const chain = member.inbound_id ? await chainOf(tx, member.inbound_id) : [];
    const end = chain.length > 0 ? chain[chain.length - 1] : null;
    const owned = fence.owned.find(found => end !== null && found.attempt.job === end) ?? fence.owned.find(found => chain.includes(found.attempt.job)) ?? null;
    const brief = briefs.find(one => one.participant_id === participant.id)!;
    const evidenceRefs = await evidenceFor(tx, x.participants, x.members, brief.evidence_refs);
    const words = brief.text + (evidenceRefs.length > 0 ? `\n${evidenceRefs.map(one => `Participant ${one.participant}, round ${one.round}:\n${one.text}`).join("\n\n")}` : "");
    const awaiting: CorrectionPlan = { kind: "correction", execution: owned === null ? null : owned.attempt.execution, operation: operationOf(participant.id), brief: words,
      question_revision: revision, by: x.sender, sources: [...messages], correction: x.operation, cleared: permitted };
    await patchMember(tx, { council: council.id, round: member.round, participant: participant.id, input_revision: member.input_revision }, { state: "superseding", awaiting: awaiting as unknown as Record<string, unknown> });
    if (owned !== null) evidence.push({ participant: participant.id, input: "running", message: "its process was asked to end; the corrected input waits until it is shown to be over" });
    else evidence.push({ participant: participant.id, input: member.state, message: member.state === "answered" ? "its earlier answer is kept as superseded; it is asked again" : "it had not started; its input was disabled and it is asked again" });
  }
  // 2. The participants the master said the correction does not touch keep their answers, for the new revision, by that explicit statement.
  for (const one of unaffected) {
    await tx.sql`update round_member set valid_for_revision = ${revision}, updated_at = now()
      where council_id = ${council.id} and round = ${one.member.round} and participant_id = ${one.participant.id} and input_revision = ${one.member.input_revision}`;
  }
  await patchCouncil(tx, council.id, { question_revision: revision, ...(x.request.message ? { question: x.request.message } : {}), lifecycle: "running", waiting: null, finalize: null, completed_at: null });
  await tx.sql`update council_round set state = 'running', completed_at = null where council_id = ${council.id} and round = ${council.current_round}`;
  // An allowance the owner gave is spent now when the correction may start now; a correction the checkpoint held back spends it when it starts.
  if (allowance.ok && allowance.spends) await spendRound(tx, council);
  await recordDecision(tx, { council: council.id, kind: "correction", conversation: x.binding.conversation, request_key: x.request.request_key, operation: x.operation,
    sources: x.request.source_message_ids ?? [], by: x.sender, attempt: x.attempt,
    payload: { question_revision: revision, affected: ids, unaffected: unaffected.map(one => one.participant.id), question_changed: x.request.message !== undefined,
      waiting_for_extension: !permitted } });
  // 3. What can move now moves now (an input that had not started, an answer that is being asked again), as far as the checkpoint allows.
  await reconcileInside(tx, council.id);
  await adoptPendingEvents(tx, (await readCouncil(tx, council.id))!, x.attempt);
  const now = (await readCouncil(tx, council.id))!;
  if (!permitted) {
    const minutes = checkpointMinutes(x.registry);
    return replyOf(now, { operation: x.operation, status: "waiting_owner", stage: "correction_waiting_checkpoint", cause: "checkpoint",
      message: `Recorded as revision ${revision}. The ${minutes}-minute checkpoint has passed, so two things follow. Already done: what the correction affects was taken off the old question (work that had not started was disabled, and every running participant among them was asked to end now). ` +
        `Not done: nothing corrected is started, and nothing is fed to anyone, until the owner extends the checkpoint. Ask them whether to go on and how far, and record their answer with kind "owner_decision", ` +
        `decision {choice: "extend", extension_scope: {minutes: n} or {rounds: n}}, citing their message. Each affected participant then gets the correction as soon as its process is shown to be over. What it wrote before then is unfinished and does not answer the corrected question.`,
      extra: { question_revision: revision, affected: evidence, unaffected: unaffected.map(one => one.participant.id) } });
  }
  return replyOf(now, { operation: x.operation, stage: "correcting",
    message: `Recorded as revision ${revision}. Only the affected participants' work was touched. A running participant is asked to end and is fed the correction only once it is shown to be over; what it wrote before then is unfinished and does not answer the corrected question.`,
    extra: { question_revision: revision, affected: evidence, unaffected: unaffected.map(one => one.participant.id) } });
}

// ---- the entry --------------------------------------------------------------------------------------------------

/**
 * The owner a council rests on when a call cites no message of theirs (a debate round the owner already opted into
 * at the start): the one who asked for it, or who approved the proposal. The jobs it queues are approved by them, and
 * the runner still checks that the person allows them when it takes each job.
 */
function standingOwner(council: CouncilRow): string {
  const approved = (council.origin.confirmation as { approved_by?: unknown } | undefined)?.approved_by;
  return String(council.origin.sender ?? approved ?? "");
}

export async function councilContinue(binding: McpBinding, request: ContinueRequest): Promise<ToolReply> {
  requireMaster(binding, "continue a council");
  return await runRequest<ContinueRequest, CouncilRow>(binding, {
    tool: HUB_COUNCIL, request, object: request.council_id,
    async open(tx) {
      await reconcileInside(tx, request.council_id);
      const council = await readCouncil(tx, request.council_id, { lock: true });
      if (!council || council.agent !== binding.agent || council.person !== binding.person) {
        throw new Undo(refusal(request.council_id, "unknown_council", "no council of this owner has that id"));
      }
      if (council.origin_kind === "legacy") {
        throw new Undo(refusal(council.id, "closed", "a council of the earlier design can be inspected and stopped but not continued: start a new council with the participants the owner names"));
      }
      if (council.revision !== request.expected_revision) {
        throw new Undo({ ...refusal(council.id, "stale_revision", "the council changed since you looked: inspect it again and act on what it says now"), revision: council.revision });
      }
      // Evidence must be newer than the council, and a choice about a missing participant newer than the news of it.
      // Both moments are read as text, microseconds included, and compared by the database against the message's own time.
      let after: Since = { at: await createdAtOf(tx, council.id), what: "the council" };
      if (request.kind === "owner_decision" && request.decision && request.decision.choice !== "extend") {
        const [news] = (await tx.sql`select max(ready_at)::text as at from council_event where council_id = ${council.id} and kind in ('member_missing', 'round_stalled')`) as unknown as { at: string | null }[];
        if (news?.at) after = { at: news.at, what: "the news that a participant is missing" };
      }
      return { context: council, since: after };
    },
    async apply(tx, council, owner) {
      const x: Ctx = {
        binding, tx, council, request, sender: owner.sender !== "" ? owner.sender : standingOwner(council), registry: binding.registry(),
        participants: await participantsOf(tx, council.id), members: await membersOf(tx, council.id),
        operation: operationFor(binding, request), attempt: binding.attempt(), at: new Date().toISOString(), now: new Date(),
      };
      switch (request.kind) {
        case "finalize": return await finalize(x);
        case "owner_decision": return await decide(x);
        case "debate_round": return await debateRound(x);
        case "follow_up": return await followUp(x);
        default: return await correction(x);
      }
    },
  });
}
