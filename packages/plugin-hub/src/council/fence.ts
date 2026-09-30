import { chooseHold } from "../recovery/holds.ts";
import type { StoreLike } from "../store/connect.ts";
import { placeGate, requestStop, type StopRequest } from "../store/controls.ts";
import { UNRESOLVED } from "../store/conversations.ts";

/**
 * FENCE FIRST, THEN LOOK: how a council's stop and a correction find out what is still owned.
 *
 * A stop, or a correction that ends outdated work, has to decide, for every piece of work the council owns, one of
 * two things: nothing of it can run any more, or a process may still be running and is asked to end. That
 * answer is only true if it is read AFTER nothing new can start. The store gives that ordering (`store/controls.ts`, `hub_gate_place`,
 * `hub_gate_order`): placing a gate takes the agent's one short ordering lock, every opening of an attempt takes the
 * same lock before it reads the gates, so once the gate is placed in this transaction an attempt either already
 * exists (and the read that follows lists it) or its opening is refused when this transaction commits. The read that
 * used to come first (list what runs, gate what does not) had a window between the two in which a runner could
 * claim and open the attempt: the stop then called the member cancelled and the council stopped over a process that was
 * running.
 *
 * WHAT IS COUNTED AS THE COUNCIL'S WORK is read from the jobs' own provenance and not from any member's display state:
 * every job that names the council (`dispatch.council_round.council`, or a seat of the earlier design), of every
 * round, of a participant that was replaced or left out as well as the current ones, and every continuation of a held
 * job (which keeps the mark). A member that is `missing` because its ownership is unknown is exactly a member whose
 * process may be running.
 *
 * THE ORDER, which is the store's: gates in ascending agent order (then job id, so it is deterministic), placed before
 * the stop requests that go with them, and stop requests (which take a share lock on the attempt) before an owner's choice
 * on a hold (which locks the hold), the order `endAttempt` takes the same rows in (the attempt, then its hold). Nothing here
 * waits for a process: a stop request returns at once, frozen to the attempt it names.
 *
 * AN EARLIER, STILL PENDING CHOICE OF THE OWNER'S IS SUPERSEDED. A retry recorded while the process was not shown to be gone
 * (`continue_pending`) queues a continuation, with the OLD question's words, the moment the process is shown to be over
 * (`hub_hold_advance`, from `endAttempt`). A later stop or correction therefore cancels it with the store's own choice
 * (`keep_held`, at the revision that is current) and the result is CHECKED: `closed` means the continuation was queued first,
 * so that continuation is work of the council too, and the next pass finds it, gates it and stops its attempt. Both orders
 * of that race end the same way, because the two writers take turns on the hold's row and this reads it again after it.
 */

export interface CouncilJob { id: string; agent: string; state: string; participant: string | null }
export interface OwnedAttempt { execution: string; job: string; agent: string; state: string; participant: string | null }

/** Every job the council owns, by provenance, ordered by agent and id. */
export async function councilJobs(tx: StoreLike, council: string, options: { participants?: readonly string[] } = {}): Promise<CouncilJob[]> {
  const rows = (await tx.sql`select id, agent, state, source -> 'dispatch' -> 'council_round' ->> 'participant' as participant
    from inbound
    where kind = 'job'
      and (source -> 'dispatch' -> 'council_round' ->> 'council' = ${council} or source -> 'dispatch' -> 'council' ->> 'id' = ${council})
    order by agent, id`) as unknown as CouncilJob[];
  const only = options.participants === undefined ? null : new Set(options.participants);
  return only === null ? rows : rows.filter(one => one.participant !== null && only.has(one.participant));
}

const UNRESOLVED_LIST = UNRESOLVED.map(state => `'${state}'`).join(", ");

/** The attempts among these jobs whose process may be running or is not shown to be gone, newest first. */
export async function ownedAttempts(tx: StoreLike, jobs: readonly CouncilJob[]): Promise<OwnedAttempt[]> {
  if (jobs.length === 0) return [];
  const rows = (await tx.sql.unsafe(`select e.id as execution, e.inbound_id as job, e.agent, e.state from execution e
    where e.inbound_id in (select jsonb_array_elements_text($1::text::jsonb)) and e.state in (${UNRESOLVED_LIST})
    order by e.started_at desc, e.id`, [JSON.stringify(jobs.map(one => one.id))])) as unknown as { execution: string; job: string; agent: string; state: string }[];
  const by = new Map(jobs.map(one => [one.id, one.participant]));
  return rows.map(one => ({ ...one, participant: by.get(one.job) ?? null }));
}

/** Whether the job has a process that may be running, read the way the fence reads it. Newest attempt first. */
export async function ownedAttemptOfJob(tx: StoreLike, job: string): Promise<string | null> {
  const [found] = (await tx.sql.unsafe(`select id from execution where inbound_id = $1 and state in (${UNRESOLVED_LIST}) order by started_at desc, id limit 1`, [job])) as unknown as { id: string }[];
  return found?.id ?? null;
}

export interface FenceOptions {
  council: string;
  /** Only the work of these participants (a correction), or all of it (a stop). */
  participants?: readonly string[];
  /** The gate for one job that is not answered: its operation and the evidence it carries. */
  gate(job: CouncilJob): { operation: string; evidence: Record<string, unknown> };
  /** The stop request for one owned attempt: its operation (with the target, the request's identity), who asked and why. */
  stop(owned: OwnedAttempt): { operation: string; by: string; evidence: Record<string, unknown> };
  /** Who supersedes a pending owner's choice, and the evidence that says by what. */
  supersede: { by: string; evidence: Record<string, unknown> };
}

export interface Fenced {
  /** Every job of the scope, after the last pass. */
  jobs: CouncilJob[];
  /** Every attempt that may still be running, and the stop request made for it. */
  owned: { attempt: OwnedAttempt; stop: StopRequest }[];
  /** The pending owner's choices that were cancelled, by the job they were about. */
  superseded: string[];
  /** Continuations the earlier choice had already queued (the store's answer was `closed`): fenced like any other job. */
  continuations: string[];
}

const PASSES = 6;

const isDone = (job: CouncilJob) => job.state === "answered" || job.state === "delivered";

/**
 * Fence the scope, read what is owned, request the stops and cancel what is pending: repeated until a pass finds nothing new. The
 * caller's transaction owns all of it, so what it decides after this sees exactly what this saw.
 */
export async function fenceCouncilWork(tx: StoreLike, options: FenceOptions): Promise<Fenced> {
  const gated = new Set<string>();
  const stops = new Map<string, { attempt: OwnedAttempt; stop: StopRequest }>();
  const superseded: string[] = [];
  const continuations: string[] = [];
  let jobs: CouncilJob[] = [];
  for (let pass = 0; pass < PASSES; pass += 1) {
    jobs = await councilJobs(tx, options.council, { participants: options.participants });
    // 1. The gates, first, in ascending agent order (the list is ordered by agent and id): nothing that is not answered can be opened after them.
    const fresh = jobs.filter(one => !gated.has(one.id));
    for (const job of fresh) {
      gated.add(job.id);
      if (isDone(job)) continue;
      const gate = options.gate(job);
      await placeGate(tx, { operation: gate.operation, scope: { kind: "row", id: job.id }, cause: "council", evidence: gate.evidence });
    }
    // 2. Then what is owned, read after them, and each attempt asked to end by its own frozen request.
    for (const attempt of await ownedAttempts(tx, jobs)) {
      if (stops.has(attempt.execution)) continue;
      const ask = options.stop(attempt);
      stops.set(attempt.execution, { attempt, stop: await requestStop(tx, { operation: ask.operation, target: { execution: attempt.execution }, by: ask.by, evidence: ask.evidence }) });
    }
    // 3. Then a choice of the owner's that is still waiting for a process to be shown over: it is superseded, by the store's own choice.
    const pending = jobs.length === 0 ? [] : (await tx.sql.unsafe(`select h.inbound_id, h.execution_id, h.revision, e.agent
      from replay_hold h join execution e on e.id = h.execution_id
      where h.inbound_id in (select jsonb_array_elements_text($1::text::jsonb)) and h.state = 'continue_pending'
      order by e.agent, h.inbound_id`, [JSON.stringify(jobs.map(one => one.id))])) as unknown as { inbound_id: string; execution_id: string; revision: number; agent: string }[];
    let moved = false;
    for (const hold of pending) {
      const outcome = await chooseHold(tx, { attempt: hold.execution_id, agent: hold.agent, revision: hold.revision, choice: "keep_held", by: options.supersede.by,
        evidence: { ...options.supersede.evidence, superseded_choice: "continue", job: hold.inbound_id } });
      if (outcome === "keep_held") { superseded.push(hold.inbound_id); continue; }
      // Not cancelled: the continuation was queued first (`closed`), or what is known moved under it. Either way there is
      // more of the council's work than this pass saw, and the next pass reads it. A choice that is not one of those is not understood.
      if (outcome !== "closed" && outcome !== "stale-revision") throw new Error(`the owner's pending choice on ${hold.inbound_id} could not be superseded (${outcome})`);
      const [after] = (await tx.sql`select continuation_id from replay_hold where inbound_id = ${hold.inbound_id}`) as unknown as { continuation_id: string | null }[];
      if (after?.continuation_id) continuations.push(after.continuation_id);
      moved = true;
    }
    if (fresh.length === 0 && !moved) return { jobs, owned: [...stops.values()], superseded, continuations };
  }
  throw new Error("the council's work kept changing while it was being fenced: nothing was done, ask again");
}
