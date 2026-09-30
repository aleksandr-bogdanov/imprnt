import { CONFIRM_EMOJI, CONFIRMATION_COLUMNS, confirmationOf, type ConfirmationRow } from "../store/confirmations.ts";
import type { StoreLike } from "../store/connect.ts";
import { contentHash, isSettled, readEffects, type EffectRow } from "../store/effects.ts";
import { senderAllowed } from "../registry/entries.ts";
import { classify, heldUntil, newestId, type EffectsContext, type EffectsGate } from "./effects.ts";
import type { PlatformReadback } from "./platform.ts";

/**
 * Reading the reaction on a frozen preview and approving it, in the door, over the
 * platform's REST reads and nothing else: no Gateway, no new connection, no service.
 *
 * What is looked at, in this order, on every poll of every preview still pending:
 *
 *  1. that something is registered to act on the approval. If not, the preview stays
 *     pending and says so; an approval nobody acts on would be a green check that
 *     did nothing, and it is not recorded.
 *  2. that the owner is STILL an allowed sender of the person, by the registry as it
 *     is now, not as it was when the preview was frozen.
 *  3. that every part of the preview was delivered exactly as frozen. A part that is
 *     still being sent waits. One that is gone, refused or unknowable never approves.
 *  4. that every part, read back from the platform now, is ours, in this chat, has the
 *     content that was frozen and has not been edited. Gone or different fails the
 *     preview for good, and a corrected preview is a new revision. A read that fails,
 *     for any reason, proves neither, and the preview stays pending.
 *  5. that the owner is among the users who reacted with the green check on the last
 *     part, paginated to the end. Only the observation now counts: a reaction added
 *     and taken away between two polls was never seen and is not promised.
 *
 * The approval is one update, `pending -> approved`, for the newest revision only, in
 * the same transaction as the hook that turns it into work, so the approval and the
 * work commit once or not at all. Nothing external happens inside that transaction.
 */

/**
 * What acts on an approval, registered by the process that owns the operation kind.
 * It runs INSIDE the approval's transaction with a store bound to it, and it must
 * write only to the store: it is where the work an approval authorizes is recorded, and
 * an effect on the platform is asked for through the ledger, never made here.
 */
export type ApprovalHook = (tx: StoreLike, approval: ConfirmationRow) => Promise<void>;
export type ApprovalHooks = Readonly<Record<string, ApprovalHook>>;

export interface ConfirmContext extends EffectsContext {
  /** The registry as it is NOW, for the owner's standing. May throw. */
  registry: () => unknown;
  hooks: ApprovalHooks;
  /** How often a pending preview is read again: the door's own tick. */
  pollMs: number;
}

/** More than this many full pages of reactors are not read, and the poll is incomplete. */
const MAX_REACTOR_PAGES = 50;
const PAGE = 100;

const clock = (ctx: ConfirmContext): number => (ctx.now ?? Date.now)();

/** The pending previews of this door. */
export async function readPending(ctx: ConfirmContext): Promise<ConfirmationRow[]> {
  const rows = await ctx.store.sql.unsafe(
    `select ${CONFIRMATION_COLUMNS} from confirmation where door = $1 and state = 'pending' order by created_at, id`,
    [ctx.door],
  );
  return rows.map((row: Record<string, unknown>) => confirmationOf(row));
}

/**
 * When each pending preview is next due to be read, by id. The door's task keeps one
 * for its life, so a wake that has nothing to do with a preview (another effect was
 * asked for, the listener came back) does not read it again before it is due: a read
 * is a request per part and per page of reactors, and the tick is what paces them.
 */
export type PollSchedule = Map<string, number>;

/**
 * Poll every pending preview that is due once. Says when the next poll is due (an
 * epoch), or null when nothing pending needs one. Never throws for a failed read: that
 * is recorded on the preview and retried. With a `schedule`, a preview that a poll
 * said was next due later is left alone until then, so the deadline holds whatever
 * woke the task; without one, every preview is read, as a caller that owns its own
 * pacing wants.
 */
export async function pollConfirmations(ctx: ConfirmContext, gate: EffectsGate, pending?: ConfirmationRow[], schedule?: PollSchedule): Promise<number | null> {
  let next: number | null = null;
  const soonest = (at: number | null) => { if (at !== null) next = next === null ? at : Math.min(next, at); };
  const rows = pending ?? await readPending(ctx);
  for (const row of rows) {
    if (ctx.stop?.()) return next;
    const now = clock(ctx);
    const due = schedule?.get(row.id);
    if (due !== undefined && due > now) { soonest(due); continue; }
    if (now < gate.notBefore) { soonest(gate.notBefore); continue; }
    const at = await pollOne(ctx, gate, row);
    if (schedule) {
      if (at === null) schedule.delete(row.id);
      else schedule.set(row.id, at);
    }
    soonest(at);
  }
  // A preview that is no longer pending has nothing scheduled.
  if (schedule && schedule.size > 0) {
    const live = new Set(rows.map(row => row.id));
    for (const id of [...schedule.keys()]) if (!live.has(id)) schedule.delete(id);
  }
  return next;
}

/** Record what one poll saw. `observed` is true only for a poll that read the platform to the end. */
async function observe(ctx: ConfirmContext, row: ConfirmationRow, saw: Record<string, unknown>, observed: boolean): Promise<void> {
  const at = new Date(clock(ctx)).toISOString();
  const evidence = { ...saw, at };
  if (observed) {
    await ctx.store.sql`update confirmation set evidence = ${evidence}::jsonb, observed_at = ${at}::timestamptz
      where id = ${row.id} and state = 'pending'`;
  } else {
    await ctx.store.sql`update confirmation set evidence = ${evidence}::jsonb where id = ${row.id} and state = 'pending'`;
  }
}

/** The preview can never be approved: it says why, once, and a correction is a new revision. */
async function fail(ctx: ConfirmContext, row: ConfirmationRow, cause: string, saw: Record<string, unknown> = {}): Promise<null> {
  await ctx.store.sql`update confirmation set state = 'failed', cause = ${cause},
    evidence = ${{ ...saw, at: new Date(clock(ctx)).toISOString() }}::jsonb
    where id = ${row.id} and state = 'pending'`;
  return null;
}

async function pollOne(ctx: ConfirmContext, gate: EffectsGate, row: ConfirmationRow): Promise<number | null> {
  const again = clock(ctx) + ctx.pollMs;
  const readback = ctx.platform.readback;

  if (!Object.hasOwn(ctx.hooks, row.operation_kind)) {
    // Nothing here acts on this kind, so nothing is read and nothing is approved. It
    // does not poll: the hooks are fixed for the life of the process.
    if (row.evidence.cause !== "hook-unavailable") await observe(ctx, row, { cause: "hook-unavailable" }, false);
    return null;
  }
  if (!readback) {
    if (row.evidence.cause !== "readback-unsupported") await observe(ctx, row, { cause: "readback-unsupported" }, false);
    return null;
  }

  // The owner's standing is the registry's, now.
  let allowed = false;
  try {
    allowed = senderAllowed(ctx.registry(), row.person, row.door, row.owner_sender);
  } catch {
    await observe(ctx, row, { cause: "registry-unreadable" }, false);
    return again;
  }
  if (!allowed) {
    await observe(ctx, row, { cause: "owner-not-allowed" }, false);
    return again;
  }

  // Every part delivered, exactly as frozen, before anything is read from the platform.
  const parts = await readEffects(ctx.store, row.effect_keys);
  if (parts.length !== row.effect_keys.length) return await fail(ctx, row, "preview-undeliverable", { reason: "part-missing-from-ledger" });
  if (parts.some(one => one.state === "failed")) return await fail(ctx, row, "preview-undeliverable", { parts: parts.map(states) });
  if (parts.some(one => one.state === "missing")) return await fail(ctx, row, "preview-missing", { parts: parts.map(states) });
  if (parts.some(one => one.state === "unknown")) {
    await observe(ctx, row, { cause: "preview-delivery-unknown", parts: parts.map(states) }, false);
    return null;
  }
  if (parts.some(one => !isSettled(one))) {
    await observe(ctx, row, { cause: "preview-not-delivered", parts: parts.map(states) }, false);
    return null;
  }

  // A limit the platform seam already knows of holds these reads: not asked before it
  // lapses, whoever learned it. Nothing is recorded, because nothing was read.
  const held = heldUntil(ctx, ["get", "reactors"], parts[0].chat);
  if (held !== null) return held;

  try {
    const self = await readback.self();
    for (const part of parts) {
      const read = await readback.getMessage({ chat: part.chat, id: part.platform_id! });
      if (!read.exists) return await fail(ctx, row, "preview-missing", { part: part.key, gone: read.cause });
      const message = read.message;
      if (message.author.id !== self.id || message.chat !== part.chat || message.edited
          || contentHash(message.content) !== contentHash(part.wanted_content)) {
        return await fail(ctx, row, "preview-changed", { part: part.key });
      }
    }
    const last = parts[parts.length - 1];
    const seen = await reactorsOf(readback, last, row.owner_sender);
    if (!seen.found) {
      await observe(ctx, row, { cause: seen.complete ? "awaiting-reaction" : "reactors-incomplete", reactors: seen.count }, seen.complete);
      return again;
    }
    return await approve(ctx, row, seen.count);
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      const at = clock(ctx) + verdict.retryAfterMs;
      if (verdict.global) gate.notBefore = Math.max(gate.notBefore, at);
      await observe(ctx, row, { cause: "rate-limited", retry_after_ms: verdict.retryAfterMs, global: verdict.global,
        ...(verdict.scope ? { scope: verdict.scope } : {}) }, false);
      return at;
    }
    // A refused read (a 403), a 5xx, a dropped connection: not a deletion and not an approval.
    await observe(ctx, row, { cause: "read-failed", failure: verdict.failure }, false);
    return again;
  }
}

const states = (one: EffectRow) => ({ key: one.key, state: one.state, applied: one.applied_revision, wanted: one.wanted_revision });

/** Page through the users who reacted, to the end or to the owner. */
async function reactorsOf(readback: PlatformReadback, part: EffectRow, owner: string): Promise<{ found: boolean; complete: boolean; count: number }> {
  let after: string | undefined;
  let count = 0;
  for (let pages = 0; pages < MAX_REACTOR_PAGES; pages += 1) {
    const page = await readback.reactors({ chat: part.chat, id: part.platform_id!, emoji: CONFIRM_EMOJI, ...(after === undefined ? {} : { after }), limit: PAGE });
    count += page.length;
    if (page.some(user => user.id === owner && !user.bot)) return { found: true, complete: true, count };
    if (page.length < PAGE) return { found: false, complete: true, count };
    after = newestId(page.map(user => user.id));
  }
  return { found: false, complete: false, count };
}

/**
 * The approval and the work it authorizes, in ONE transaction. The update only wins for
 * a preview that is still pending, is still the newest revision of its operation and
 * whose parts are all still delivered as frozen; anything else wins nothing and
 * runs nothing. If the hook throws, the approval is rolled back with it and the preview
 * stays pending, so an approval never exists without its work.
 */
async function approve(ctx: ConfirmContext, row: ConfirmationRow, reactors: number): Promise<number | null> {
  const again = clock(ctx) + ctx.pollMs;
  const at = new Date(clock(ctx)).toISOString();
  try {
    await ctx.store.sql.begin(async (tx) => {
      const [won] = await tx`update confirmation
        set state = 'approved', approved_by = owner_sender, approved_at = ${at}::timestamptz, cause = null,
            observed_at = ${at}::timestamptz, evidence = ${{ cause: null, approved: true, reactors, at }}::jsonb
        where id = ${row.id} and state = 'pending'
          and revision = (select max(c.revision) from confirmation c where c.operation_id = confirmation.operation_id)
          and not exists (select 1 from platform_effect e
                           where e.key = any(confirmation.effect_keys)
                             and not (e.state = 'confirmed' and e.applied_revision = e.wanted_revision
                                      and e.edit_state = 'idle'))
        returning *`;
      if (!won) return;
      await ctx.hooks[row.operation_kind]({ sql: tx, url: ctx.store.url }, confirmationOf(won));
    });
    return null;
  } catch (error) {
    // Rolled back whole. Said on the preview, outside the transaction that failed.
    await observe(ctx, row, { cause: "hook-failed", error: String((error as Error)?.message ?? error).slice(0, 300) }, false)
      .catch(() => {});
    return again;
  }
}
