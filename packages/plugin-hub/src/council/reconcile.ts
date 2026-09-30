import { chooseHold } from "../recovery/holds.ts";
import { placeGate, requestStop, stopsOf } from "../store/controls.ts";
import type { StoreLike } from "../store/connect.ts";
import { UNRESOLVED } from "../store/conversations.ts";
import { allowFurtherRound, spendRound, type Allowance } from "./checkpoint.ts";
import { emitEvent, memberMissingBody, roundCompleteBody, roundStalledBody } from "./events.ts";
import { ownedAttemptOfJob } from "./fence.ts";
import { correctionContext, correctionTask, enqueueMemberJob } from "./jobs.ts";
import {
  TERMINAL, decisionsOf, membersOf, participantsOf, patchCouncil, patchMember, readCouncil,
  type CouncilRow, type MemberCause, type MemberRow, type ParticipantRow,
} from "./rows.ts";

/**
 * The one place a council's state moves from what the store actually holds.
 *
 * A MEMBER'S STATE IS READ OFF ITS JOB, NEVER GUESSED AND NEVER WRITTEN BY A CLOCK. Its report
 * exists (answered), its input has a hold (its attempt was interrupted, its ownership is
 * unknown, it was stopped), it was refused, or it failed before it was handed the input and the
 * runner gated it (missing, and the cause is the store's own fact), or none of those (still open:
 * queued, waiting for a machine or for capacity, or running, which `snapshot.ts` tells apart from
 * the job and its attempt and never writes). A worker that is quiet or slow is open. Nothing
 * here reruns, replaces or gives up on a member, and no answer of a member that is not answered
 * is invented.
 *
 * IT IS IDEMPOTENT AND SAFE TO CALL FROM ANYWHERE: a settle, a tool call and the door's own
 * wake all run it, each under the council's row lock, and the second finds nothing to do. The
 * events it writes are keyed by the condition they report, so a repeat writes none.
 *
 * WHAT IT DECIDES, FROM THOSE FACTS AND NOTHING ELSE:
 *   every required input answered at the current question revision   -> waiting_master, one event
 *   a required input missing (and not omitted by the owner's decision) -> waiting_owner, an event per member
 *   everything left is missing and nothing is running                -> also one round_stalled event
 *   a stop with no member waiting, no attempt of any of the council's jobs still owned
 *   and no job of it still claimable (`stopEvidence`, over ALL its work, not the roster) -> stopped
 * and what it never decides: synthesis (the master's, at its own attempt's settle), a further
 * round, a replacement, a retry, or that the owner chose anything.
 */

export interface Line { participant: ParticipantRow; member: MemberRow | undefined }

/** For each active participant that has an input in the council's current round, its newest one. */
export function currentInputs(council: Pick<CouncilRow, "current_round">, participants: readonly ParticipantRow[], members: readonly MemberRow[]): { participant: ParticipantRow; member: MemberRow }[] {
  const out: { participant: ParticipantRow; member: MemberRow }[] = [];
  for (const participant of participants) {
    if (participant.state !== "active") continue;
    const mine = members.filter(one => one.participant_id === participant.id && one.round === council.current_round);
    if (mine.length === 0) continue;
    out.push({ participant, member: mine.reduce((a, b) => (b.input_revision > a.input_revision ? b : a)) });
  }
  return out;
}

const UNSETTLED: readonly string[] = ["open", "superseding", "stopping"];

/** The participants the owner chose to do without for the current round (a recorded `use_available`). */
export async function omittedFor(store: StoreLike, council: Pick<CouncilRow, "id" | "current_round">): Promise<Set<string>> {
  const omitted = new Set<string>();
  for (const decision of await decisionsOf(store, council.id)) {
    if (decision.payload.round !== council.current_round) continue;
    if (decision.kind === "use_available") {
      for (const id of (decision.payload.omitted as string[] | undefined) ?? []) omitted.add(id);
    } else if (decision.kind === "retry" || decision.kind === "replace") {
      // The owner changed their mind about a participant they had left out: it is waited for again.
      for (const id of (decision.payload.affected as string[] | undefined) ?? []) omitted.delete(id);
    }
  }
  return omitted;
}

export interface Summary {
  inputs: { participant: ParticipantRow; member: MemberRow }[];
  open: { participant: ParticipantRow; member: MemberRow }[];
  missing: { participant: ParticipantRow; member: MemberRow }[];
  answered: { participant: ParticipantRow; member: MemberRow }[];
  stale: { participant: ParticipantRow; member: MemberRow }[];
  omitted: { participant: ParticipantRow; member: MemberRow }[];
}

export function summarize(council: Pick<CouncilRow, "current_round" | "question_revision">, participants: readonly ParticipantRow[], members: readonly MemberRow[], omitted: ReadonlySet<string>): Summary {
  const inputs = currentInputs(council, participants, members);
  const live = inputs.filter(one => !omitted.has(one.participant.id));
  return {
    inputs,
    open: live.filter(one => UNSETTLED.includes(one.member.state)),
    missing: live.filter(one => one.member.state === "missing"),
    answered: live.filter(one => one.member.state === "answered" && (one.member.valid_for_revision ?? 0) >= council.question_revision),
    stale: live.filter(one => one.member.state === "answered" && (one.member.valid_for_revision ?? 0) < council.question_revision),
    omitted: inputs.filter(one => omitted.has(one.participant.id)),
  };
}

// ---- what the store says about one job ---------------------------------------------------------------------

interface Hold { cause: string; state: string; revision: number; execution_id: string; continuation_id: string | null; evidence: Record<string, unknown> | null }
interface Facts {
  row: { state: string } | null;
  report: { id: string; reported_at: Date | null } | null;
  hold: Hold | null;
  gate: { detail: string | null } | null;
  refusal: string | null;
  /** What a refusal for a changed configuration said had changed, in words (never a value). */
  changed: string | null;
}

async function holdOf(store: StoreLike, job: string): Promise<Hold | null> {
  const [hold] = (await store.sql`select cause, state, revision, execution_id, continuation_id, evidence from replay_hold where inbound_id = ${job}`) as unknown as Hold[];
  return hold ?? null;
}

/**
 * The job, then the continuation the owner authorized after its attempt was interrupted, then the
 * continuation of that, and so on. The last is the input the member is waiting on now.
 */
export async function chainOf(store: StoreLike, root: string): Promise<string[]> {
  const jobs = [root];
  for (let step = 0; step < 20; step += 1) {
    const hold = await holdOf(store, jobs[jobs.length - 1]);
    if (!hold || hold.continuation_id === null || jobs.includes(hold.continuation_id)) break;
    jobs.push(hold.continuation_id);
  }
  return jobs;
}

async function factsOf(store: StoreLike, job: string): Promise<Facts> {
  const [row] = (await store.sql`select state from inbound where id = ${job}`) as unknown as { state: string }[];
  const [report] = (await store.sql`select id, reported_at from inbound where id = ${"report:" + job}`) as unknown as { id: string; reported_at: Date | null }[];
  const hold = await holdOf(store, job);
  const [gate] = (await store.sql`select evidence ->> 'cause' as detail from claim_gate
    where operation_id = ${"council-failed:" + job} and scope_kind = 'row' and scope_id = ${job} and state = 'open'`) as unknown as { detail: string | null }[];
  const [refusal] = row && (row.state === "answered" || row.state === "delivered") && !report
    ? (await store.sql`select detail ->> 'cause' as cause, detail ->> 'changed' as changed from ledger_event
        where subject = ${job} and kind in ('dispatch.refused', 'dispatch.abandoned') order by seq desc limit 1`) as unknown as { cause: string | null; changed: string | null }[]
    : [];
  return { row: row ?? null, report: report ?? null, hold, gate: gate ?? null, refusal: refusal?.cause ?? null, changed: refusal?.changed ?? null };
}

export interface Verdict {
  state: "open" | "answered" | "missing";
  /** The job the member is waiting on now: the input itself, or the last continuation of it. */
  job: string;
  cause?: MemberCause;
  report_id?: string;
  answered_at?: Date | null;
  /** True for an open member whose owner-authorized continuation is not queued yet. */
  awaiting_continuation?: boolean;
}

/** What the store says a member is, from its job. See the header for what each answer rests on. */
export async function classify(store: StoreLike, root: string): Promise<Verdict> {
  const jobs = await chainOf(store, root);
  const job = jobs[jobs.length - 1];
  const facts = await factsOf(store, job);
  if (facts.report) return { state: "answered", job, report_id: facts.report.id, answered_at: facts.report.reported_at };
  if (facts.hold && facts.hold.state !== "released") {
    if (facts.hold.state === "continue_pending" || facts.hold.state === "continuing") return { state: "open", job, awaiting_continuation: true };
    return { state: "missing", job, cause: { kind: facts.hold.cause, attempt: facts.hold.execution_id, hold_revision: facts.hold.revision } };
  }
  if (facts.gate) return { state: "missing", job, cause: { kind: "failed_before_start", detail: facts.gate.detail } };
  if (facts.row && (facts.row.state === "answered" || facts.row.state === "delivered")) {
    // A job the runner refused because the worker's configuration is no longer the one the owner approved is a named cause of its own,
    // and is a member the owner has to decide about (nothing was fed to the engine, nothing is retried or replaced on its own).
    if (facts.refusal === "configuration changed") return { state: "missing", job, cause: { kind: "configuration_changed", detail: facts.changed } };
    return { state: "missing", job, cause: { kind: "refused", detail: facts.refusal } };
  }
  if (!facts.row) return { state: "missing", job, cause: { kind: "job_missing" } };
  return { state: "open", job };
}

// ---- a correction waiting for a process to end --------------------------------------------------------------

/** What a correction that asked a running attempt to end keeps, so it can finish without asking anyone again. */
export interface CorrectionPlan {
  kind: "correction";
  /** The attempt asked to end, or null when there was none to stop (the input never started, or it already ended or answered). */
  execution: string | null;
  operation: string;
  brief: string;
  question_revision: number;
  by: string;
  sources: string[];
  /** The operation of the `correction` call that saved this plan, shared by every participant that call affected. */
  correction: string;
  /**
   * Whether the checkpoint let this correction's corrected inputs start. True from the start when the correction was
   * accepted with the checkpoint open, and set for every participant of the correction together the first time one of
   * them starts (the owner's scoped extension is what allowed it). Permission is one fact about the correction, read
   * once; a clock that runs out afterwards does not take it back.
   */
  cleared: boolean;
}

function planOf(member: Pick<MemberRow, "awaiting">): CorrectionPlan | null {
  const plan = member.awaiting as unknown as CorrectionPlan | null;
  return plan && plan.kind === "correction" ? plan : null;
}

/**
 * The inputs a saved correction is holding back because the checkpoint has passed and the owner has not extended it: their
 * running work was already asked to end (that is not held back), and what is held back is STARTING the corrected input.
 */
export function parkedCorrections<T extends { member: MemberRow }>(council: Pick<CouncilRow, "checkpoint_deadline" | "extension">, inputs: readonly T[], now: Date): T[] {
  if (allowFurtherRound(council, now).ok) return [];
  return inputs.filter(one => one.member.state === "superseding" && planOf(one.member)?.cleared !== true && planOf(one.member) !== null);
}

/**
 * A correction that stopped a running attempt continues only on evidence that the attempt is over, AND only when the
 * checkpoint lets further work start. The two are separate facts and neither stands in for the other: the stop was asked
 * for when the owner's correction was accepted and is not waited on the checkpoint; starting the corrected input is.
 *
 *   settled   the attempt finished with its own result before the stop landed. The result is kept as
 *             superseded, and the corrected input is a fresh input into the same conversation
 *   stopped   every process is shown gone. The interrupted input is held; the owner's continuation of it
 *             (the correction they asked for, carrying its words) is the existing recovery choice
 *   moot      the attempt was over by other means. Handled as `stopped` when it left a hold, and as
 *             never started when it did not
 *   requested, stopping, unknown   NOT evidence. Nothing is fed and the member waits, named, for as long as it takes
 *
 * With the checkpoint closed and no scoped extension the member stays `superseding`: its old hold is not released, its old
 * output is kept, nothing is fed, and the council says it is waiting for the owner to extend. The owner's extension runs this
 * again (the tool's `extend` reconciles in its own transaction) and, with the evidence, the correction starts then.
 */
async function advanceCorrection(tx: StoreLike, council: CouncilRow, participant: ParticipantRow, member: MemberRow): Promise<boolean> {
  // The plan as it stands now: a sibling of the same correction that started earlier in this pass has already cleared it.
  const [current] = (await tx.sql`select awaiting from round_member
    where council_id = ${council.id} and round = ${member.round} and participant_id = ${member.participant_id} and input_revision = ${member.input_revision}`) as unknown as
    { awaiting: Record<string, unknown> | null }[];
  const plan = current ? planOf(current) : null;
  if (!plan || member.inbound_id === null) return false;
  const stop = plan.execution === null ? null : (await stopsOf(tx, plan.operation)).find(one => one.execution === plan.execution) ?? null;
  if (plan.execution !== null && (!stop || ["requested", "stopping", "unknown"].includes(stop.state))) return false;
  // Evidence is in (or none was needed). Whether the corrected input may START is the checkpoint's, read from the council as it is now.
  const live = (await readCouncil(tx, council.id))!;
  const permit: Allowance = plan.cleared === true ? { ok: true, spends: false } : allowFurtherRound(live, new Date());
  if (!permit.ok) return false;
  let cleared = plan.cleared === true;
  /** The first start of a correction clears it for every participant of it together, and spends the owner's allowance once for all of them. */
  const commit = async (): Promise<void> => {
    if (cleared) return;
    cleared = true;
    await tx.sql`update round_member set awaiting = awaiting || ${JSON.stringify({ cleared: true })}::text::jsonb, updated_at = now()
      where council_id = ${council.id} and state = 'superseding' and awaiting ->> 'correction' = ${plan.correction}`;
    if (permit.spends) await spendRound(tx, live);
  };
  const key = { council: council.id, round: member.round, participant: member.participant_id, input_revision: member.input_revision };
  const at = new Date().toISOString();
  const next = async (task: string, hadOutput: boolean) => {
    await commit();
    return await enqueueMemberJob(tx, {
      council, participant, round: member.round, inputRevision: member.input_revision + 1, questionRevision: plan.question_revision,
      task: task || correctionTask(council, plan.brief, hadOutput), approvedBy: plan.by, at }, member.input_revision);
  };

  if (stop?.state === "settled") {
    await next("", true);
    await patchMember(tx, key, { state: "superseded", cause: { kind: "superseded", detail: "it finished before the stop landed; its answer is kept and does not answer the corrected input" }, awaiting: null });
    return true;
  }
  const chain = await chainOf(tx, member.inbound_id);
  const end = chain[chain.length - 1];
  let hold = await holdOf(tx, end);
  if (hold && hold.state !== "released") {
    // ONLY A CONTINUATION THIS CORRECTION MADE MAY BECOME THE CORRECTED INPUT. An owner's retry that was still waiting for the process to
    // be shown over (`continue_pending`) carries the OLD question's words: the correction that got here first cancelled it, and if one
    // is still there anyway it is cancelled now and never relabelled as the corrected work. If the store says it was queued first
    // (`closed`), the continuation is a job of its own that the next pass finds as the end of the chain, fences and asks again.
    if (hold.state === "continue_pending" && hold.evidence?.correction !== plan.correction) {
      const cancelled = await chooseHold(tx, { attempt: hold.execution_id, agent: participant.worker_agent, revision: hold.revision, choice: "keep_held", by: plan.by,
        evidence: { source: "council", council: council.id, superseded_by: "correction", correction: plan.correction, messages: plan.sources, superseded_choice: "continue" } });
      if (cancelled !== "keep_held") return false;
      hold = await holdOf(tx, end);
    }
    if (hold && (hold.state === "held" || hold.state === "keep_held")) {
      await commit();
      await chooseHold(tx, { attempt: hold.execution_id, agent: participant.worker_agent, revision: hold.revision, choice: "continue", by: plan.by,
        evidence: { source: "council", council: council.id, correction: plan.correction, question_revision: plan.question_revision, messages: plan.sources },
        context: correctionContext(council, plan.brief) });
    }
    const after = await holdOf(tx, end);
    if (!after || after.continuation_id === null || after.evidence?.correction !== plan.correction) return false;
    await tx.sql`insert into round_member (council_id, round, participant_id, input_revision, question_revision, inbound_id, supersedes)
      values (${council.id}, ${member.round}, ${member.participant_id}, ${member.input_revision + 1}, ${plan.question_revision}, ${after.continuation_id}, ${member.input_revision})`;
    await patchMember(tx, key, { state: "superseded", cause: { kind: "superseded", detail: "ended on purpose for the owner's correction; what it wrote before it ended is unfinished" }, awaiting: null });
    return true;
  }
  // No hold: the attempt left nothing held, so its input was never handed to the engine (or it is over and reported). A report means the
  // first branch; without one the input is disabled and asked afresh. THE ABSENCE OF A HOLD IS NOT EVIDENCE OF NO LIVE ATTEMPT, so it is
  // asked, positively, under the fence: the row is gated first (nothing can open an attempt for it after that), and then what is owned is read.
  // A process that may still be running is asked to end and waited for, and nothing corrected is queued beside it.
  const facts = await factsOf(tx, end);
  if (facts.report === null) {
    await placeGate(tx, { operation: `council-correct:${end}`, scope: { kind: "row", id: end }, cause: "council", evidence: { council: council.id, correction: plan.correction } });
    const owned = await ownedAttemptOfJob(tx, end);
    if (owned !== null) {
      await requestStop(tx, { operation: plan.operation, target: { execution: owned }, by: plan.by, evidence: { council: council.id, correction: plan.correction, messages: plan.sources } });
      await patchMember(tx, key, { awaiting: { ...plan, execution: owned } as unknown as Record<string, unknown> });
      return false;
    }
  }
  await next("", facts.report !== null);
  await patchMember(tx, key, { state: "superseded", cause: { kind: "superseded", detail: "it had not started; its input was disabled and asked again with the correction" }, awaiting: null });
  return true;
}

/** What a council stop waits for per member, and the words it gives an answer that landed anyway. */
export interface StopPlan { kind: "stop"; execution: string | null; operation: string }

async function advanceStop(tx: StoreLike, council: CouncilRow, member: MemberRow): Promise<boolean> {
  const plan = member.awaiting as unknown as StopPlan | null;
  if (!plan || plan.kind !== "stop") return false;
  const key = { council: council.id, round: member.round, participant: member.participant_id, input_revision: member.input_revision };
  if (plan.execution !== null) {
    const stop = (await stopsOf(tx, plan.operation)).find(one => one.execution === plan.execution);
    if (!stop || ["requested", "stopping", "unknown"].includes(stop.state)) return false;
    if (stop.state === "settled" && member.inbound_id !== null) {
      const verdict = await classify(tx, member.inbound_id);
      if (verdict.state === "answered") {
        await patchMember(tx, key, { state: "answered", report_id: verdict.report_id ?? null, answered_at: verdict.answered_at ?? null,
          valid_for_revision: member.question_revision, awaiting: null });
        return true;
      }
    }
  }
  await patchMember(tx, key, { state: "stopped", awaiting: null });
  return true;
}

/**
 * What the store shows of ALL of a council's work when it is asked whether the council has stopped, read from the jobs' own provenance
 * (`fence.ts`): how many of its attempts are still owned (a process that may be running or is not shown to be gone) and how many of its
 * jobs could still be claimed (not answered, and neither held by a hold or an attempt nor gated). Both are zero for a council that is stopped.
 */
export async function stopEvidence(tx: StoreLike, council: string): Promise<{ owned: number; runnable: number }> {
  const mine = `(i.source -> 'dispatch' -> 'council_round' ->> 'council' = $1 or i.source -> 'dispatch' -> 'council' ->> 'id' = $1)`;
  const [row] = (await tx.sql.unsafe(`select
      (select count(*)::int from execution e join inbound i on i.id = e.inbound_id
        where ${mine} and e.state in (${UNRESOLVED.map(one => `'${one}'`).join(", ")})) as owned,
      (select count(*)::int from inbound i where i.kind = 'job' and ${mine} and i.state not in ('answered', 'delivered') and not hub_row_held(i.id)) as runnable`,
    [council])) as unknown as { owned: number; runnable: number }[];
  return { owned: Number(row?.owned ?? 0), runnable: Number(row?.runnable ?? 0) };
}

// ---- the whole step ---------------------------------------------------------------------------------------

/** `skipped` is a step that gave up because somebody else held the council (`skipLocked`), and looked at nothing. */
export interface ReconcileResult { changed: boolean; events: string[]; skipped?: boolean }

const NOTHING: ReconcileResult = { changed: false, events: [] };

/**
 * Run the step inside a transaction the caller owns. Takes the council's row lock (`skipLocked`
 * gives up instead of waiting for it, for a caller that holds locks a lock holder might wait
 * for: the runner's settle, which must never wait on a council).
 */
export async function reconcileInside(tx: StoreLike, id: string, options: { skipLocked?: boolean } = {}): Promise<ReconcileResult> {
  if (options.skipLocked) {
    const [free] = (await tx.sql`select id from council where id = ${id} for update skip locked`) as unknown as { id: string }[];
    if (!free) {
      const [exists] = (await tx.sql`select 1 as one from council where id = ${id}`) as unknown as { one: number }[];
      return exists ? { ...NOTHING, skipped: true } : NOTHING;
    }
  }
  const council = await readCouncil(tx, id, { lock: !options.skipLocked });
  if (!council) return NOTHING;
  const participants = await participantsOf(tx, id);
  let members = await membersOf(tx, id);
  const legacy = council.origin_kind === "legacy";
  // A council that is stopping or over starts nothing: a saved correction does not queue its corrected input into it.
  const closing = council.lifecycle === "stopping" || (TERMINAL as readonly string[]).includes(council.lifecycle);
  let changed = false;
  const newlyMissing: MemberRow[] = [];

  // 1. Inputs that are not settled or that were missing: what does the store say now?
  for (const member of members) {
    if (member.inbound_id === null) continue;
    const key = { council: id, round: member.round, participant: member.participant_id, input_revision: member.input_revision };
    if (member.state === "open" || member.state === "missing") {
      const verdict = await classify(tx, member.inbound_id);
      if (verdict.state === "answered") {
        await patchMember(tx, key, { state: "answered", cause: null, report_id: verdict.report_id ?? null, answered_at: verdict.answered_at ?? null,
          // What a correction's explicit "not affected" list said was still valid is kept, and never lowered.
          valid_for_revision: Math.max(member.valid_for_revision ?? 0, member.question_revision) });
        changed = true;
      } else if (verdict.state === "missing" && member.state === "open") {
        await patchMember(tx, key, { state: "missing", cause: verdict.cause ?? null });
        newlyMissing.push({ ...member, state: "missing", cause: verdict.cause ?? null });
        changed = true;
      } else if (verdict.state === "open" && member.state === "missing") {
        // The owner chose to continue this attempt (with the recovery command, or with a retry recorded on the council):
        // the member is waited for again, by their choice. Nothing else turns a missing member back into an open one.
        await patchMember(tx, key, { state: "open", cause: null });
        changed = true;
      } else if (verdict.state === "missing" && member.state === "missing"
                 && JSON.stringify(verdict.cause ?? null) !== JSON.stringify(member.cause ?? null)) {
        await patchMember(tx, key, { cause: verdict.cause ?? null });
        changed = true;
      }
    } else if (member.state === "superseding") {
      const participant = participants.find(one => one.id === member.participant_id);
      if (participant && !closing && await advanceCorrection(tx, council, participant, member)) changed = true;
    } else if (member.state === "stopping") {
      if (await advanceStop(tx, council, member)) changed = true;
    }
  }
  if (changed) members = await membersOf(tx, id);

  // 2. The council: what those inputs say it is.
  const omitted = await omittedFor(tx, council);
  const sum = summarize(council, participants, members, omitted);
  const patch: Record<string, unknown> = {};
  const events: string[] = [];
  const lines = (list: { participant: ParticipantRow; member: MemberRow }[]): Line[] => list.map(one => ({ participant: one.participant, member: one.member }));
  const at = council.lifecycle;

  if (at === "stopping") {
    // STOPPED IS SAID ONLY OF WHAT THE STORE SHOWS, and for the whole council, not for the members its roster counts now: no member of any
    // round or of a participant that was replaced or left out is still waiting for a process, no attempt of any job the council owns is
    // owned (its process is not shown to be gone), and no job of it could still be claimed (it is answered, held or gated).
    const evidence = members.some(one => UNSETTLED.includes(one.state)) ? null : await stopEvidence(tx, id);
    if (evidence !== null && evidence.owned === 0 && evidence.runnable === 0) {
      patch.lifecycle = "stopped";
      patch.waiting = null;
      patch.completed_at = new Date();
      await tx.sql`update council_round set state = 'stopped', completed_at = now() where council_id = ${id} and round = ${council.current_round} and state = 'running'`;
    }
  } else if (legacy) {
    if (at !== "complete") {
      const next = sum.missing.length > 0 ? "waiting_owner" : sum.open.length > 0 ? "running" : "waiting_owner";
      const waiting = sum.missing.length > 0
        ? { kind: "members_missing", legacy: true, members: sum.missing.map(one => one.participant.id) }
        : sum.open.length > 0 ? null : { kind: "legacy_unmerged", legacy: true };
      if (next !== at || JSON.stringify(waiting) !== JSON.stringify(council.waiting ?? null)) { patch.lifecycle = next; patch.waiting = waiting; }
    }
  } else if (at === "running" || at === "waiting_owner") {
    // A saved correction whose corrected input the checkpoint is holding back is a thing only the owner can move: the council
    // names it, beside whatever else it waits for. (Keys are written in the order jsonb keeps them, shortest first, so the
    // comparison below is between like and like.)
    const parked = parkedCorrections(council, sum.inputs, new Date()).map(one => one.participant.id);
    const also = parked.length > 0 ? { correction_parked: parked } : {};
    if (parked.length === 0 && sum.open.length === 0 && sum.missing.length === 0 && sum.stale.length === 0 && sum.answered.length > 0) {
      const signature = sum.answered.map(one => `${one.participant.ordinal}.${one.member.input_revision}`).join(",");
      patch.lifecycle = "waiting_master";
      patch.waiting = null;
      await tx.sql`update council_round set state = 'complete', completed_at = now() where council_id = ${id} and round = ${council.current_round}`;
      const made = await emitEvent(tx, council, { kind: "round_complete",
        dedupe: `round-complete:${council.current_round}:q${council.question_revision}:${signature}`,
        body: await roundCompleteBody(tx, { ...council, revision: council.revision + 1 }, lines(sum.answered.slice().sort((a, b) => a.participant.ordinal - b.participant.ordinal))),
        provenance: { round: council.current_round, question_revision: council.question_revision, request_at: council.origin.request_at ?? null } });
      if (made) events.push(made.id);
    } else if (sum.missing.length > 0 || sum.stale.length > 0 || parked.length > 0) {
      const waiting = sum.missing.length > 0
        ? { kind: "members_missing", members: sum.missing.map(one => one.participant.id), ...also }
        : sum.stale.length > 0
          ? { kind: "stale_answers", members: sum.stale.map(one => one.participant.id), ...also }
          : { kind: "checkpoint", members: parked, correction: true };
      if (at !== "waiting_owner" || JSON.stringify(waiting) !== JSON.stringify(council.waiting ?? null)) { patch.lifecycle = "waiting_owner"; patch.waiting = waiting; }
      const view = { ...council, revision: council.revision + 1 };
      for (const gone of newlyMissing) {
        const line = sum.missing.find(one => one.member.participant_id === gone.participant_id && one.member.input_revision === gone.input_revision);
        if (!line) continue;
        const made = await emitEvent(tx, council, { kind: "member_missing",
          dedupe: `missing:${line.participant.id}:r${gone.round}:i${gone.input_revision}:${String(gone.cause?.kind ?? "")}`,
          body: memberMissingBody(view, { participant: line.participant, member: line.member }),
          provenance: { participant: line.participant.id, round: gone.round } });
        if (made) events.push(made.id);
      }
      if (sum.open.length === 0 && sum.missing.length > 0) {
        const made = await emitEvent(tx, council, { kind: "round_stalled",
          dedupe: `stalled:${council.current_round}:${sum.missing.map(one => `${one.participant.ordinal}.${one.member.input_revision}`).join(",")}:${sum.answered.map(one => `${one.participant.ordinal}.${one.member.input_revision}`).join(",")}`,
          body: roundStalledBody(view, lines(sum.answered), lines(sum.missing)),
          provenance: { round: council.current_round } });
        if (made) events.push(made.id);
      }
    } else if (at === "waiting_owner") {
      patch.lifecycle = "running";
      patch.waiting = null;
    }
  }
  if (changed || Object.keys(patch).length > 0) {
    await patchCouncil(tx, id, patch);
    return { changed: true, events };
  }
  return { changed: false, events };
}

/** Run the step in a transaction of its own. */
export async function reconcileCouncil(store: StoreLike, id: string): Promise<ReconcileResult> {
  return await store.sql.begin(async (sql) => await reconcileInside({ ...store, sql: sql as unknown as StoreLike["sql"] }, id));
}
