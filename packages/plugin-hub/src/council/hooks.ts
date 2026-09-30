import { safeValue } from "../door/lines.ts";
import type { StoreLike } from "../store/connect.ts";
import { placeGate } from "../store/controls.ts";
import { UNRESOLVED } from "../store/conversations.ts";
import type { DispatchEnvelope, InboundSource } from "../store/inbound.ts";
import { guarded } from "./guard.ts";
import { councilOfJob } from "./provenance.ts";
import { reconcileInside } from "./reconcile.ts";

export { councilOfJob };

/**
 * The few points where the runner's own transactions tell a council that something happened, and what each
 * one does. They live here, in the council's code, so `runner/` carries a call and no council logic.
 *
 * TWO KINDS OF HOOK, AND THE DIFFERENCE IS WHAT A FAILURE COSTS.
 *
 *   OPTIONAL (`noteJobSettled`, `noteJobRefused`, `noteJobFailed`): a reconcile of a council from rows that are
 *   already committed in the same transaction. It runs in a savepoint (`guard.ts`), a failure is rolled back
 *   alone and said on stderr, and the door's next reconcile (it runs one on every change) derives the same
 *   thing again, so a missed one delays a card and cannot lose or invent anything. Nothing that decides whether
 *   work may run again is here.
 *
 *   MANDATORY (`afterMasterSettle`, the consumption of an event in `feed.ts`, the fence a member's failure
 *   before its input leaves behind, in `runner/execution.ts`, and the fence of a claim a loop left behind,
 *   `fenceAbandonedClaims` below): what ties a council's state to ONE attempt, or keeps its input from being
 *   tried again without its owner. They are
 *   ordinary statements of the transaction they belong to, so a failure fails that transaction and leaves
 *   nothing half done. A settle that cannot record the council's result is not committed at all: the runner
 *   keeps the journaled answer and settles it again without giving the engine anything (`settleStored`), and
 *   a feed intent that cannot record what the master was handed is not committed either, so nothing is fed.
 *
 * A HOOK NEVER WAITS FOR A COUNCIL that somebody else is reconciling: the optional ones take the council's
 * row lock with `skip locked` and only wake the door at the commit, because the runner's settle holds rows
 * those callers may need and waiting on a council could deadlock with them.
 */

/** A council's job settled: its report exists now. Reconcile, or wake the door to. */
export async function noteJobSettled(store: StoreLike, source: { dispatch?: DispatchEnvelope } | null | undefined): Promise<void> {
  await reconcileOrWake(store, "settle", source);
}

/** A council's job was refused before it ran: what the refusal recorded is what the council reads. */
export async function noteJobRefused(store: StoreLike, source: { dispatch?: DispatchEnvelope } | null | undefined): Promise<void> {
  await reconcileOrWake(store, "refusal", source);
}

async function reconcileOrWake(store: StoreLike, what: string, source: { dispatch?: DispatchEnvelope } | null | undefined): Promise<void> {
  const council = councilOfJob(source);
  if (council === null) return;
  await guarded(store, what, async (inner) => {
    const outcome = await reconcileInside(inner, council, { skipLocked: true });
    if (outcome.skipped) {
      const door = source?.dispatch?.return?.door;
      if (door) await inner.sql`select pg_notify('hub_project', ${"council:" + door})`;
    }
  });
}

/**
 * The same fence, for the one case `endAttempt` cannot cover: a council member's job whose processing failed before any attempt existed for it (it was
 * claimed and something between the claim and the opening of the attempt threw), so there is no attempt to end. It is MANDATORY and belongs in the
 * transaction that releases the claim: the caller writes it first, and a failure of it fails that transaction, so the claim is not released by a
 * path that did not fence the row. Idempotent, like the gate `endAttempt` writes (same operation, same scope). Callers find the jobs to fence with
 * `fenceAbandonedClaims`, from the store, and not from a loop's memory of what it was doing.
 */
export async function fenceUnstartedMember(
  store: StoreLike,
  failure: { job: string; source: { dispatch?: DispatchEnvelope } | null | undefined; cause: string },
): Promise<void> {
  const council = councilOfJob(failure.source);
  if (council === null) return;
  await placeGate(store, { operation: `council-failed:${failure.job}`, scope: { kind: "row", id: failure.job }, cause: "council",
    evidence: { council, cause: safeValue(failure.cause).slice(0, 200) } });
}

/** A council's job that a runner still holds the claim of and owns nothing about: no attempt of it that may be running, and no hold. */
export interface AbandonedClaim { id: string; source: InboundSource | null }

const OWNED = UNRESOLVED.map(state => `'${state}'`).join(", ");

async function abandonedClaims(store: StoreLike, who: { runner: string; agent: string }): Promise<AbandonedClaim[]> {
  const rows = (await store.sql.unsafe(`select i.id, i.source from inbound i
      where i.agent = $1 and i.claimed_by = $2 and i.kind = 'job' and i.state not in ('answered', 'delivered')
        and not exists (select 1 from execution e where e.inbound_id = i.id and e.state in (${OWNED}))
        and not exists (select 1 from replay_hold h where h.inbound_id = i.id and h.state <> 'released')
      order by i.id`, [who.agent, who.runner])) as unknown as AbandonedClaim[];
  return rows.filter(one => councilOfJob(one.source) !== null);
}

/**
 * A CLAIM IS NOT A RETRY BARRIER, AND A COUNCIL MEMBER'S INPUT IS NEVER TRIED AGAIN WITHOUT ITS OWNER. A runner claims a job long before it opens an
 * attempt for it (the profile is checked, the conversation chosen, the engine's capabilities and the held context read), and a claim its own runner
 * holds is exactly what that runner's next loop takes again (`claimNext`), a lease that lapsed is what anybody's next claim takes, and the failure
 * path releases whatever it holds onto a retry time. So any failure between the claim and the attempt, with no way to write the fence that says so
 * (the store is what failed), used to end in the same claimed row being fed to an engine by the next loop, the next incarnation, or the retry delay.
 *
 * This is the fence for that, written from what the STORE shows and not from what a loop remembers: every council job this runner still holds for
 * this agent, that is not answered, that has no attempt that may be running and no hold, is a job whose launch did not finish. It is gated with the
 * same failure fence `endAttempt` writes for an attempt that failed (`council-failed:<job>`, so the council reads it as a member that failed before
 * its input, and the owner's retry, replacement or leaving it out are the ways on) and its claim is released, in the caller's transaction, the
 * fence first. It is MANDATORY: if the fence cannot be written the transaction fails and the claim is not released, and the loop that asks for this
 * first (`runner/run.ts`: the failure path, and the start of every loop before its first claim) does not go on to claim anything.
 *
 * Nothing that was fed is touched: a job with an attempt that may be running, or with a hold, is owned and is somebody else's rule. Nothing but a
 * council's job is looked at, so no ordinary work is gated. Who is blocked is exactly what was left behind, and it is visible: a member that failed
 * before its input, waiting for its owner.
 */
export async function fenceAbandonedClaims(
  store: StoreLike,
  who: { runner: string; agent: string; cause: string },
): Promise<AbandonedClaim[]> {
  const found = await abandonedClaims(store, who);
  for (const one of found) {
    await fenceUnstartedMember(store, { job: one.id, source: one.source, cause: who.cause });
    await store.sql`update inbound set claimed_by = null, claim_deadline = null where id = ${one.id} and claimed_by = ${who.runner}`;
  }
  return found;
}

/**
 * `fenceAbandonedClaims` in a transaction of its own, for the start of a loop: the claims a loop that ended, or a process that died, left behind are fenced
 * before this loop claims anything. It costs one read while there is nothing to fence. The council is only shown afterwards (optional), in the same transaction.
 */
export async function sweepAbandonedClaims(
  store: StoreLike,
  who: { runner: string; agent: string; cause: string },
): Promise<AbandonedClaim[]> {
  if ((await abandonedClaims(store, who)).length === 0) return [];
  return await store.sql.begin(async (tx) => {
    const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
    const fenced = await fenceAbandonedClaims(inside, who);
    for (const one of fenced) await noteJobFailed(inside, { job: one.id, source: one.source });
    return fenced;
  });
}

/**
 * A member's attempt ended BEFORE the engine was handed its input, so its job would be tried again by the
 * runner as any job's is. A council member is not: the failure is the owner's to decide (retry it, replace it,
 * do without it), so the job is gated where it stands, with the failure as the gate's evidence, and the council
 * reads it as a missing member with that named cause. Nothing is stamped answered.
 *
 * THE GATE IS NOT WRITTEN HERE. It is written by `endAttempt`, in the very transaction that makes the attempt
 * `failed` and releases the claim (`runner/execution.ts`), or by `fenceAbandonedClaims` (through `fenceUnstartedMember`) when there was no
 * attempt, because the gate is what keeps the row from being eligible again the moment its claim is released: a gate written after that,
 * in another transaction that may fail, leaves a window (and, when the write fails, a row that is tried again on the next
 * admission, at the retry deadline, or after a restart). What is left to do here is only to let the council see it, which is the
 * optional part: the reconcile, or a wake for the door. Returns whether the job is a council member's.
 */
export async function noteJobFailed(
  store: StoreLike,
  failure: { job: string; source: { dispatch?: DispatchEnvelope } | null | undefined },
): Promise<boolean> {
  const council = councilOfJob(failure.source);
  if (council === null) return false;
  await guarded(store, "failure", async (inner) => {
    const outcome = await reconcileInside(inner, council, { skipLocked: true });
    if (outcome.skipped) {
      const door = failure.source?.dispatch?.return?.door;
      if (door) await inner.sql`select pg_notify('hub_project', ${"council:" + door})`;
    }
  });
  return true;
}

/**
 * The master's attempt settled, in the same transaction that settles its reply. MANDATORY: these statements are part
 * of the settlement, and if they fail the settlement does not commit.
 *
 * A COUNCIL IS COMPLETE ONLY BECAUSE THE MASTER SAID FINALIZE FROM THIS VERY ATTEMPT, whichever
 * input it was answering (the council's event, or the owner's message that chose). Its reply, which
 * this transaction writes to the outbox, is the result, and the council keeps a reference to it. An
 * attempt that never called finalize completes nothing: a council that was being assessed goes back to
 * waiting for its master, visibly, and no reply is taken for a synthesis because it was a reply. A finalize
 * whose reply is empty is not a result either: the council goes back to waiting for its master.
 *
 * WHY IT MAY FAIL THE SETTLEMENT. The runner journals the model's answer before it settles it (`journalResult`), and
 * a settle that fails is retried from that journal, on the runner's next look and at its next start, without a second
 * input to the engine (`runner/execution.ts`, `settleStored`). So a failure here costs a delay in delivering the reply and never
 * a lost answer, a second generation, or a council whose reply was delivered and whose result was not recorded
 * (which is what swallowing this failure left behind: `preparing_result` for good, and nothing that could finish it).
 */
export async function afterMasterSettle(store: StoreLike, settled: { execution: string; inbound: string; reply: string }): Promise<void> {
  if (settled.reply.trim() !== "") {
    await store.sql`update council c set lifecycle = 'complete', completed_at = now(), revision = c.revision + 1, updated_at = now(),
        result = jsonb_build_object('attempt', ${settled.execution}::text, 'inbound', ${settled.inbound}::text, 'mode', c.finalize ->> 'mode',
          'omitted', coalesce(c.finalize -> 'omitted', '[]'::jsonb), 'at', now(),
          'reply', jsonb_build_object('conversation', (select e.conversation_id from execution e where e.id = ${settled.execution}), 'source', ${settled.inbound}::text, 'kind', 'reply'))
      where c.lifecycle = 'preparing_result' and c.finalize ->> 'attempt' = ${settled.execution}`;
  } else {
    await store.sql`update council set lifecycle = 'waiting_master', finalize = null, revision = revision + 1, updated_at = now()
      where lifecycle = 'preparing_result' and finalize ->> 'attempt' = ${settled.execution}`;
  }
  await store.sql`update council c set lifecycle = 'waiting_master', revision = c.revision + 1, updated_at = now()
    where c.lifecycle = 'assessing' and exists (select 1 from council_event e where e.council_id = c.id and e.consumed_attempt = ${settled.execution})`;
}
