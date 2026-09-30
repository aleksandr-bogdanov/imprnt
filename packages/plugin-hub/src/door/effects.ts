import { randomUUID } from "node:crypto";
import type { StoreLike } from "../store/connect.ts";
import { contentHash, EFFECT_COLUMNS, effectOf, type EffectRow } from "../store/effects.ts";
import type { Platform, PlatformReadback, PlatformRefusalDetail, PlatformVerb, ReadMessage } from "./platform.ts";
import { classifyPlatformError } from "./reply.ts";

/**
 * The one delivery and reconciliation task for platform messages, the door's half of
 * `store/effects.ts`. It sends what was asked for once, edits it to the newest content
 * asked for, and after a crash or a lost answer looks for the message it made before
 * it would ever consider making another.
 *
 * WHAT IT WILL NOT DO, and the table enforces the same rules where it can:
 *
 *  * Send a create whose outcome is uncertain again. A transport failure, a timeout, a
 *    5xx, an answer with no id and a crash between the send and the id being saved are
 *    all uncertain, and none of them is answered by an empty read: the owner may have
 *    deleted the message, a listing can miss it, and a request can still be in flight.
 *    It reads the chat back for POSITIVE evidence, a message by our author, in this
 *    chat, carrying the effect's marker and exactly the content the attempt sent, and
 *    adopts that. Otherwise the effect is `unknown` and stays so.
 *  * Send an edit over an edit whose outcome is uncertain. A PATCH that was sent and
 *    whose answer was lost may still land, later than a newer one, and no read and no
 *    amount of waiting proves it will not. Edits are claimed one at a time per message,
 *    pinned to the attempt, and an uncertain one is looked for and, failing evidence,
 *    left `unknown`: the row then says the newest content is NOT known to be applied,
 *    and nothing newer is sent until a look finds the old one landed. Nothing else
 *    settles it: not a timeout, not a statement that the request is dead, which
 *    nothing here can check. No corrective second write is sent on a stale answer.
 *  * Replace a message the owner deleted. It says `missing`; a caller that wants
 *    another records a new effect.
 *  * Treat a refusal or an error read as a deletion or an approval.
 *  * Hold a database transaction across a request. Every request is preceded by a
 *    committed row that says it is about to happen and followed by a separate write.
 *  * Send a part of a preview that can no longer be approved: the create claim itself
 *    checks that its preview is still standing, at the moment of the claim.
 *
 * A 429 is the one uncertain-looking answer that is not: the platform said it did not
 * process the request, so the effect goes back to where it was and is tried again
 * after exactly the wait the platform named. What a 429 taught the platform seam holds
 * every request that seam makes (`Platform.blockedUntil`), the ordinary outbox and pull
 * included, so a route that is waiting is not asked again by another effect, and the
 * account-wide limit holds everything. A request already under way is not stopped.
 */

/**
 * How far before an attempt's own moment a scan starts, for the clock of this machine
 * against the platform's. It only bounds the scan and never decides anything: a scan
 * that finds nothing concludes nothing.
 */
export const SCAN_SLACK_MS = 10 * 60 * 1000;
const PAGE = 100;
/** More than this many full pages after an attempt is not read, and the scan is incomplete. */
const MAX_PAGES = 10;

export interface EffectsContext {
  store: StoreLike;
  platform: Platform;
  door: string;
  /** `door.delivery_retry_seconds`: how long before a request that may still be in flight is looked for. */
  retrySeconds: number;
  /** `door.delivery_max_attempts`: how many looks come up empty before the outcome is said to be unknown. */
  maxAttempts: number;
  now?: () => number;
  /** Checked between effects, so a stopping door does not start another request. */
  stop?: () => boolean;
}

/**
 * What one door process remembers between passes of its own: the account-wide limit
 * as this task saw it. A platform whose seam keeps the memory itself (`blockedUntil`)
 * holds every request of the process anyway; this is the floor for one that does not.
 */
export interface EffectsGate {
  notBefore: number;
}

export interface EffectWork {
  rows: EffectRow[];
}

const clock = (ctx: EffectsContext): number => (ctx.now ?? Date.now)();
const stamp = (ms: number): string => new Date(ms).toISOString();

type Verdict =
  | { kind: "rate_limited"; retryAfterMs: number; global: boolean; scope?: string; blocked: boolean }
  /** The platform refused and did not handle the request. */
  | { kind: "refused"; failure: Record<string, unknown>; detail: PlatformRefusalDetail }
  /** Anything else. It may have happened. */
  | { kind: "uncertain"; failure: Record<string, unknown>; detail: PlatformRefusalDetail };

/** What a failed call was, for the one place that decides what may be done about it. */
export function classify(error: unknown, ctx: EffectsContext): Verdict {
  const detail = (error ?? {}) as PlatformRefusalDetail;
  const status = Number(detail.status);
  const said = classifyPlatformError(error);
  const failure: Record<string, unknown> = { code: said.code, cause: said.cause, at: stamp(clock(ctx)) };
  if (Number.isFinite(status) && status > 0) failure.status = status;
  if (detail.discordCode !== undefined) failure.discord_code = detail.discordCode;
  if (status === 429) {
    const wait = detail.retryAfterMs !== undefined && detail.retryAfterMs >= 0 ? detail.retryAfterMs : ctx.retrySeconds * 1000;
    return { kind: "rate_limited", retryAfterMs: wait, global: detail.rateLimitGlobal === true,
      ...(detail.rateLimitScope ? { scope: detail.rateLimitScope } : {}), blocked: detail.blocked === true };
  }
  // A request that was sent and whose answer was lost says so, whatever else it carries.
  if (detail.sent !== true && status >= 400 && status < 500 && status !== 408) {
    return { kind: "refused", failure: { kind: "permanent", ...failure }, detail };
  }
  return { kind: "uncertain", failure: { kind: "uncertain", ...failure }, detail };
}

/**
 * The parts of a frozen preview. A part is sent only while its preview can still be
 * approved: one whose preview was superseded or has failed is not, because only one
 * revision of a preview is ever live and a correction must not be followed by the old
 * text appearing after it. THE SAME TEST is in the create claim below, evaluated
 * atomically with it, so a correction that commits between the door's read and its
 * claim stops the old part. A request that had already been claimed is under way, and
 * is not undone.
 */
const PREVIEW_STANDING = `not exists (select 1 from confirmation c
                                     where 'confirmation:' || c.id = platform_effect.owner_ref
                                       and c.state in ('superseded', 'failed'))`;
/** What is read: a part behind one that is unknown, failed or missing waits for nothing. */
const NO_LOST_PREDECESSOR = `not exists (select 1 from platform_effect p
                                          where p.owner_ref = platform_effect.owner_ref and p.key < platform_effect.key
                                            and p.state in ('unknown', 'failed', 'missing'))`;
/** What is claimed: a part goes out only once every part before it is delivered. */
const PREDECESSORS_DELIVERED = `not exists (select 1 from platform_effect p
                                              where p.owner_ref = platform_effect.owner_ref and p.key < platform_effect.key
                                                and p.state <> 'confirmed')`;

/** The effects this door has something to do about, read once. `startup` adds the unknown ones, to look again. */
export async function readEffectWork(ctx: EffectsContext, options: { startup?: boolean } = {}): Promise<EffectWork> {
  const rows = await ctx.store.sql.unsafe(
    `select ${EFFECT_COLUMNS} from platform_effect
      where door = $1
        and (state <> 'not_sent' or not frozen or (${PREVIEW_STANDING} and ${NO_LOST_PREDECESSOR}))
        and (state in ('not_sent', 'in_flight')
             or (state = 'confirmed' and edit_state = 'in_flight')
             or (state = 'confirmed' and edit_state = 'idle' and applied_revision < wanted_revision
                 and not (coalesce(failure ->> 'permanent', '') = 'true'
                          and coalesce((failure ->> 'revision')::integer, 0) >= wanted_revision))
             ${options.startup ? "or state = 'unknown' or (state = 'confirmed' and edit_state = 'unknown')" : ""})
      order by created_at, key`,
    [ctx.door],
  );
  return { rows: rows.map((row: Record<string, unknown>) => effectOf(row)) };
}

const soonest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/**
 * When the platform's own memory of a rate limit lets a request of one of these verbs
 * to `chat` go, or null when nothing known holds it (or the platform keeps no such
 * memory). It is the platform seam's boundary that knows, so this holds for a limit
 * learned by any request of the platform, not only this task's.
 */
export function heldUntil(ctx: EffectsContext, verbs: PlatformVerb[], chat: string): number | null {
  const ask = ctx.platform.blockedUntil;
  if (typeof ask !== "function") return null;
  let until: number | null = null;
  for (const verb of verbs) {
    const at = ask.call(ctx.platform, verb, chat);
    if (typeof at === "number") until = until === null ? at : Math.max(until, at);
  }
  return until;
}

/** One rate limit, learned: when to try again, and every request of the door held if it was the global one. */
function learnLimit(ctx: EffectsContext, gate: EffectsGate, verdict: Extract<Verdict, { kind: "rate_limited" }>): number {
  const at = clock(ctx) + verdict.retryAfterMs;
  if (verdict.global) gate.notBefore = Math.max(gate.notBefore, at);
  return at;
}

/** What a rate limit is on the row: how long, whose, and whether the seam held the request or the platform refused it. */
const limitEvidence = (ctx: EffectsContext, verdict: Extract<Verdict, { kind: "rate_limited" }>) => ({
  retry_after_ms: verdict.retryAfterMs, global: verdict.global, ...(verdict.scope ? { scope: verdict.scope } : {}),
  ...(verdict.blocked ? { held_by_seam: true } : {}), at: stamp(clock(ctx)),
});

/** The verb a row's next request is, for asking whether a limit holds it. */
function verbOf(row: EffectRow): PlatformVerb {
  if (row.state === "not_sent") return "post";
  if (row.state === "confirmed") return row.edit_state === "idle" ? "edit" : "get";
  return "list";
}

/**
 * Do what is due, one effect after another, and say when something will be due next
 * (an epoch, or null for nothing waiting on time). A row that is not due yet only
 * moves that time. It never sleeps: the caller's timer does.
 */
export async function runEffectWork(ctx: EffectsContext, gate: EffectsGate, work: EffectWork): Promise<number | null> {
  let next: number | null = null;
  // The parts of one preview appear in order, the confirmation message last, so a part
  // that is not delivered yet holds back every later part of the same preview.
  const blocked = new Set<string>();
  for (const row of work.rows) {
    if (ctx.stop?.()) return next;
    const now = clock(ctx);
    if (now < gate.notBefore) return soonest(next, gate.notBefore);
    if (row.frozen && row.state === "not_sent" && blocked.has(row.owner_ref)) continue;
    const unresolved = row.state === "unknown" || (row.state === "confirmed" && row.edit_state === "unknown");
    const at = row.retry_at ? row.retry_at.getTime() : null;
    const due = unresolved || at === null || at <= now;
    if (!due) {
      next = soonest(next, at);
      if (row.frozen) blocked.add(row.owner_ref);
      continue;
    }
    // A limit the platform seam already knows of holds this request before it is
    // claimed, so effects waiting on one route wait together and cost nothing, and a
    // route that is not held goes ahead.
    const held = heldUntil(ctx, [verbOf(row)], row.chat);
    if (held !== null) {
      next = soonest(next, held);
      if (row.frozen) blocked.add(row.owner_ref);
      continue;
    }
    // A look at something unknown gives a time only when it found the message, and then
    // the time is for what that lets go out (`dueIfOwed`).
    if (row.state === "not_sent") next = soonest(next, await create(ctx, gate, row));
    else if (row.state === "in_flight") next = soonest(next, await reconcile(ctx, gate, row, false));
    else if (row.state === "unknown") next = soonest(next, await reconcile(ctx, gate, row, true));
    else if (row.edit_state === "in_flight") next = soonest(next, await reconcileEdit(ctx, gate, row, false));
    else if (row.edit_state === "unknown") next = soonest(next, await reconcileEdit(ctx, gate, row, true));
    else next = soonest(next, await edit(ctx, gate, row));
    if (row.frozen) {
      const [now2] = await ctx.store.sql`select state from platform_effect where key = ${row.key}`;
      if (now2?.state !== "confirmed") blocked.add(row.owner_ref);
    }
  }
  return next;
}

/** Send one effect for the first time, or again after a rate limit that said nothing was made. */
async function create(ctx: EffectsContext, gate: EffectsGate, row: EffectRow): Promise<number | null> {
  const { sql } = ctx.store;
  const revision = row.wanted_revision;
  const attempt = randomUUID();
  const now = clock(ctx);
  // The row says a request is about to be made BEFORE it is, and only one claimant wins.
  // The claim also re-checks, in the same statement, that a preview part still belongs
  // to a preview that can be approved and that the parts before it are delivered.
  const claimed = await sql.unsafe(`update platform_effect
    set state = 'in_flight', attempt_id = $1, attempt_revision = $2::integer,
        attempt_hash = $3, attempts = attempts + 1, reconcile_attempts = 0,
        in_flight_at = $4::timestamptz, retry_at = $5::timestamptz,
        failure = null, updated_at = now()
    where key = $6 and state = 'not_sent' and wanted_revision = $2::integer
      and (retry_at is null or retry_at <= $4::timestamptz)
      and (not frozen or (${PREVIEW_STANDING} and ${PREDECESSORS_DELIVERED}))
    returning key`,
  [attempt, String(revision), contentHash(row.wanted_content), stamp(now), stamp(now + ctx.retrySeconds * 1000), row.key]);
  if (claimed.length === 0) return null;

  let id: string | null = null;
  try {
    id = (await ctx.platform.post({ chat: row.chat, text: row.wanted_content, nonce: row.nonce, suppressMentions: true })).id;
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      const at = learnLimit(ctx, gate, verdict);
      await sql`update platform_effect set state = 'not_sent', retry_at = ${stamp(at)}::timestamptz,
        evidence = evidence || ${{ rate_limited: limitEvidence(ctx, verdict) }}::jsonb,
        updated_at = now()
        where key = ${row.key} and attempt_id = ${attempt} and state = 'in_flight'`;
      return at;
    }
    if (verdict.kind === "refused") {
      await sql`update platform_effect set state = 'failed', retry_at = null, failure = ${verdict.failure}::jsonb, updated_at = now()
        where key = ${row.key} and attempt_id = ${attempt} and state = 'in_flight'`;
      return null;
    }
    // Uncertain: left in flight, with what was seen, and looked for when `retry_at` comes.
    await sql`update platform_effect set failure = ${verdict.failure}::jsonb, updated_at = now()
      where key = ${row.key} and attempt_id = ${attempt} and state = 'in_flight'`;
    return now + ctx.retrySeconds * 1000;
  }
  // An answer with no usable id may still have made the message.
  if (typeof id !== "string" || id === "") {
    const failure = { kind: "uncertain", code: "no-message-id", cause: "delivery outcome unknown", at: stamp(now) };
    await sql`update platform_effect set failure = ${failure}::jsonb, updated_at = now()
      where key = ${row.key} and attempt_id = ${attempt} and state = 'in_flight'`;
    return now + ctx.retrySeconds * 1000;
  }
  await confirm(ctx, row.key, attempt, id, { by: "response" });
  return null;
}

/** Save the message id of an attempt, once. A second finder of a different message says so and changes nothing. */
async function confirm(ctx: EffectsContext, key: string, attempt: string, id: string, how: Record<string, unknown>): Promise<boolean> {
  const { sql } = ctx.store;
  const done = await sql`update platform_effect
    set state = 'confirmed', platform_id = ${id}, applied_revision = attempt_revision, applied_hash = attempt_hash,
        retry_at = null, failure = null,
        evidence = evidence || ${{ confirmed: { ...how, message: id, at: stamp(clock(ctx)) } }}::jsonb, updated_at = now()
    where key = ${key} and attempt_id = ${attempt} and state in ('in_flight', 'unknown')
    returning key`;
  if (done.length > 0) return true;
  const [seen] = await sql`select platform_id from platform_effect where key = ${key}`;
  if (seen?.platform_id && seen.platform_id !== id) {
    await sql`update platform_effect set evidence = evidence || ${{ other_message: { id, at: stamp(clock(ctx)) } }}::jsonb, updated_at = now()
      where key = ${key}`;
  }
  return false;
}

/**
 * Two platform ids in the order the platform makes them: numeric strings by value,
 * which is by length and then by digits, and anything else as plain text. Ids are
 * strings because they outgrow a number, and comparing them must never throw.
 */
export function compareIds(a: string, b: string): number {
  const x = /^\d+$/.test(a) ? a.replace(/^0+(?=\d)/, "") : null;
  const y = /^\d+$/.test(b) ? b.replace(/^0+(?=\d)/, "") : null;
  if (x !== null && y !== null) return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The newest id of a page. */
export function newestId(ids: string[]): string {
  return ids.reduce((a, b) => (compareIds(b, a) > 0 ? b : a));
}

/**
 * Messages made since `since` that are OURS and are exactly what the attempt sent:
 * our author, this chat, the attempt's content by hash and carrying its marker. A copy
 * by anybody else, in another chat or with other words matches nothing.
 */
async function scan(readback: PlatformReadback, row: EffectRow, author: string, since: number): Promise<{ matches: ReadMessage[]; complete: boolean }> {
  const matches: ReadMessage[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = await readback.listMessages({ chat: row.chat, ...(after === undefined ? { since } : { after }), limit: PAGE });
    for (const one of page) {
      if (one.chat === row.chat && one.author.id === author && one.content.includes(row.marker)
          && contentHash(one.content) === row.attempt_hash) matches.push(one);
    }
    if (page.length < PAGE) return { matches, complete: true };
    after = newestId(page.map(one => one.id));
  }
  return { matches, complete: false };
}

/**
 * Look for the message a request that may have landed made. Positive evidence adopts
 * it. Nothing found is not an answer: the look is repeated a bounded number of times,
 * spaced by the delivery retry, and then the outcome is `unknown` for good, which no
 * later pass sends again. An `unknown` effect is looked at once more when a door
 * starts, and only ever moves to `confirmed`.
 */
async function reconcile(ctx: EffectsContext, gate: EffectsGate, row: EffectRow, wasUnknown: boolean): Promise<number | null> {
  const { sql } = ctx.store;
  const now = clock(ctx);
  const readback = ctx.platform.readback;
  const attempts = row.reconcile_attempts + 1;
  const spaced = now + ctx.retrySeconds * 1000;

  const nothing = async (evidence: Record<string, unknown>): Promise<number | null> => {
    if (wasUnknown) {
      await sql`update platform_effect set evidence = evidence || ${{ rechecked: { ...evidence, at: stamp(now) } }}::jsonb, updated_at = now()
        where key = ${row.key} and state = 'unknown'`;
      return null;
    }
    if (attempts >= ctx.maxAttempts || !readback) {
      await sql`update platform_effect set state = 'unknown', retry_at = null, reconcile_attempts = ${attempts},
        evidence = evidence || ${{ unknown: { ...evidence, looks: attempts, at: stamp(now) } }}::jsonb, updated_at = now()
        where key = ${row.key} and attempt_id = ${row.attempt_id} and state = 'in_flight'`;
      return null;
    }
    await sql`update platform_effect set reconcile_attempts = ${attempts}, retry_at = ${stamp(spaced)}::timestamptz,
      evidence = evidence || ${{ looked: { ...evidence, looks: attempts, at: stamp(now) } }}::jsonb, updated_at = now()
      where key = ${row.key} and attempt_id = ${row.attempt_id} and state = 'in_flight'`;
    return spaced;
  };

  if (!readback) return await nothing({ reason: "no-readback" });
  let matches: ReadMessage[];
  let complete: boolean;
  try {
    const author = await readback.self();
    const started = row.in_flight_at ? row.in_flight_at.getTime() : now;
    ({ matches, complete } = await scan(readback, row, author.id, started - SCAN_SLACK_MS));
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      const at = learnLimit(ctx, gate, verdict);
      if (!wasUnknown) {
        await sql`update platform_effect set retry_at = ${stamp(at)}::timestamptz, updated_at = now()
          where key = ${row.key} and state = 'in_flight'`;
      }
      return wasUnknown ? null : at;
    }
    return await nothing({ reason: "read-failed", failure: verdict.failure });
  }
  if (matches.length === 0) return await nothing({ reason: "no-positive-evidence", complete });
  const [first, ...rest] = matches.sort((a, b) => compareIds(a.id, b.id));
  const adopted = await confirm(ctx, row.key, row.attempt_id!, first.id, {
    by: "readback", ...(rest.length > 0 ? { duplicates: rest.map(one => one.id) } : {}),
  });
  return adopted ? await dueIfOwed(ctx, gate, row.key) : null;
}

/**
 * When to look again after a transition that LETS SOMETHING GO OUT: an edit settled, or
 * a created message adopted. The pass that made it read its rows before, so newer
 * content asked for meanwhile, or the later parts of a preview that a part which was
 * unknown had kept out of that read, would otherwise wait for a wake nobody owes. If
 * such work exists this is the moment it may go (now, or when a limit the door or the
 * platform seam knows of is over), and otherwise null. It is a one-off after a real
 * change of state and never a poll: the pass it schedules finds the work done or
 * waits on the row's own time.
 */
async function dueIfOwed(ctx: EffectsContext, gate: EffectsGate, key: string): Promise<number | null> {
  const [seen] = await ctx.store.sql`select chat,
      (state = 'confirmed' and edit_state = 'idle' and applied_revision < wanted_revision) as edit,
      (frozen and exists (select 1 from platform_effect later
                           where later.owner_ref = platform_effect.owner_ref and later.key > platform_effect.key
                             and later.state = 'not_sent')) as later
    from platform_effect where key = ${key}`;
  if (!seen || (seen.edit !== true && seen.later !== true)) return null;
  const verbs: PlatformVerb[] = [];
  if (seen.edit === true) verbs.push("edit");
  if (seen.later === true) verbs.push("post");
  return Math.max(clock(ctx), gate.notBefore, heldUntil(ctx, verbs, seen.chat) ?? 0);
}

/**
 * Bring a message the platform has to the newest content asked for, ONE REQUEST AT A
 * TIME. The edit is claimed first, by a compare-and-set that pins the attempt (its
 * revision, its content hash) and commits before the request, and it is claimed only
 * from `idle`: while an earlier edit of this message has no recorded outcome nobody
 * claims another, on this door or any other. The answer is recorded against the
 * attempt, so a late answer of an old one cannot be taken for the newest.
 *
 *  * Answered: `applied` is the revision that was SENT, not the one wanted by the time
 *    it answered, so content that moved on meanwhile is still owed and is the next edit.
 *  * A 429 or a definite refusal: the platform did not handle it, the claim is released
 *    and the wait is the platform's, or a refusal is remembered against that revision.
 *  * A message the platform names as gone (404 with its code): `missing`.
 *  * Anything uncertain (a transport failure, a timeout, a 5xx): left `in_flight`.
 *    `reconcileEdit` looks for it. A repeat of the SAME content would be safe, but a
 *    NEWER one is not while the old request may still land, and the first proves
 *    nothing about that, so neither is sent.
 */
async function edit(ctx: EffectsContext, gate: EffectsGate, row: EffectRow): Promise<number | null> {
  const { sql } = ctx.store;
  const revision = row.wanted_revision;
  const hash = contentHash(row.wanted_content);
  const now = clock(ctx);

  // What the platform is already known to show needs no request, and a request whose
  // content is what is already there could not be told, on a look, from one that never
  // landed.
  if (row.applied_hash !== null && row.applied_hash === hash) {
    await sql`update platform_effect set applied_revision = ${revision}, retry_at = null, failure = null, updated_at = now()
      where key = ${row.key} and state = 'confirmed' and edit_state = 'idle' and wanted_revision = ${revision}
        and applied_revision < ${revision} and applied_hash = ${hash}`;
    return null;
  }

  const attempt = randomUUID();
  const claimed = await sql`update platform_effect
    set edit_state = 'in_flight', edit_attempt_id = ${attempt}, edit_revision = ${revision}, edit_hash = ${hash},
        edit_attempts = edit_attempts + 1, reconcile_attempts = 0,
        in_flight_at = ${stamp(now)}::timestamptz, retry_at = ${stamp(now + ctx.retrySeconds * 1000)}::timestamptz,
        failure = null, updated_at = now()
    where key = ${row.key} and state = 'confirmed' and edit_state = 'idle'
      and wanted_revision = ${revision} and applied_revision < ${revision}
      and (retry_at is null or retry_at <= ${stamp(now)}::timestamptz)
      and not (coalesce(failure ->> 'permanent', '') = 'true' and coalesce((failure ->> 'revision')::integer, 0) >= ${revision})
    returning key`;
  if (claimed.length === 0) return null;

  try {
    await ctx.platform.edit({ chat: row.chat, id: row.platform_id!, text: row.wanted_content, suppressMentions: true });
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      const at = learnLimit(ctx, gate, verdict);
      await sql`update platform_effect set edit_state = 'idle', retry_at = ${stamp(at)}::timestamptz,
        evidence = evidence || ${{ edit_rate_limited: limitEvidence(ctx, verdict) }}::jsonb, updated_at = now()
        where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state in ('in_flight', 'unknown')`;
      return at;
    }
    const code = verdict.failure.discord_code;
    if (verdict.kind === "refused" && verdict.failure.status === 404 && (code === 10008 || code === 10003)) {
      await sql`update platform_effect set state = 'missing', edit_state = 'idle', retry_at = null,
        failure = ${verdict.failure}::jsonb, updated_at = now()
        where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state in ('in_flight', 'unknown') and state = 'confirmed'`;
      return null;
    }
    if (verdict.kind === "refused") {
      // Refused for this content, so nothing landed. A newer revision is a new request and is tried.
      await sql`update platform_effect set edit_state = 'idle', retry_at = null,
        failure = ${{ ...verdict.failure, permanent: true, revision }}::jsonb, updated_at = now()
        where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state in ('in_flight', 'unknown')`;
      return null;
    }
    // Uncertain: left in flight, pinned to this attempt, and looked for at `retry_at`.
    await sql`update platform_effect set failure = ${{ ...verdict.failure, revision }}::jsonb, updated_at = now()
      where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state = 'in_flight'`;
    return now + ctx.retrySeconds * 1000;
  }
  if (await settleEdit(ctx, row.key, attempt, { by: "response" })) return await dueIfOwed(ctx, gate, row.key);
  return null;
}

/**
 * The attempt's request is known to have landed: the applied revision moves to the one
 * it sent (never backwards) and the message may be edited again. Pinned to the attempt,
 * so it is the attempt's own answer, or a look that found its content, that settles it,
 * and from `unknown` as well, because a late positive answer is still one.
 */
async function settleEdit(ctx: EffectsContext, key: string, attempt: string, how: Record<string, unknown>): Promise<boolean> {
  const done = await ctx.store.sql`update platform_effect
    set applied_hash = case when edit_revision > applied_revision then edit_hash else applied_hash end,
        applied_revision = greatest(applied_revision, edit_revision),
        edit_state = 'idle', retry_at = null, failure = null, reconcile_attempts = 0,
        evidence = evidence || ${{ edit_confirmed: { ...how, at: stamp(clock(ctx)) } }}::jsonb, updated_at = now()
    where key = ${key} and edit_attempt_id = ${attempt} and edit_state in ('in_flight', 'unknown') and state = 'confirmed'
    returning key`;
  return done.length > 0;
}

/**
 * Look for the outcome of an edit request that may have landed, by reading the message
 * back. Content that is exactly what the attempt sent (and was not already what the
 * message showed, which `edit` never claims) is positive evidence that the request
 * landed, and that settles it. Anything else proves nothing: the request may still
 * land, and no read shows that it will not. So the look is repeated a bounded number
 * of times, spaced by the delivery retry, and then the edit is `unknown` and STAYS so,
 * with no newer edit sent over it and no clean "applied the latest" claimed, until a
 * later look finds it landed. An `unknown` edit is looked at once more when a door
 * starts. When a look does settle it and newer content is owed, that content is due
 * at once (see `dueIfOwed`), so it does not wait for an unrelated wake.
 *
 * The evidence is content equal to the attempt's AGAINST a known baseline that differs:
 * `applied_hash`, what the message showed before the attempt, must be known and must
 * not be the attempt's hash. Otherwise the same content could be the message as it
 * always was, and a look would call a request that never landed a success.
 */
async function reconcileEdit(ctx: EffectsContext, gate: EffectsGate, row: EffectRow, wasUnknown: boolean): Promise<number | null> {
  const { sql } = ctx.store;
  const now = clock(ctx);
  const readback = ctx.platform.readback;
  const attempts = row.reconcile_attempts + 1;
  const spaced = now + ctx.retrySeconds * 1000;
  const attempt = row.edit_attempt_id!;

  const nothing = async (evidence: Record<string, unknown>): Promise<number | null> => {
    if (wasUnknown) {
      await sql`update platform_effect set evidence = evidence || ${{ edit_rechecked: { ...evidence, at: stamp(now) } }}::jsonb, updated_at = now()
        where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state = 'unknown'`;
      return null;
    }
    if (attempts >= ctx.maxAttempts || !readback) {
      await sql`update platform_effect set edit_state = 'unknown', retry_at = null, reconcile_attempts = ${attempts},
        evidence = evidence || ${{ edit_unknown: { ...evidence, revision: row.edit_revision, looks: attempts, at: stamp(now) } }}::jsonb,
        updated_at = now()
        where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state = 'in_flight'`;
      return null;
    }
    await sql`update platform_effect set reconcile_attempts = ${attempts}, retry_at = ${stamp(spaced)}::timestamptz,
      evidence = evidence || ${{ edit_looked: { ...evidence, looks: attempts, at: stamp(now) } }}::jsonb, updated_at = now()
      where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state = 'in_flight'`;
    return spaced;
  };

  if (!readback) return await nothing({ reason: "no-readback" });
  try {
    const self = await readback.self();
    const read = await readback.getMessage({ chat: row.chat, id: row.platform_id! });
    if (!read.exists) {
      // The platform names the message as gone: nothing is left for a request to land on.
      await sql`update platform_effect set state = 'missing', edit_state = 'idle', retry_at = null,
        failure = ${{ kind: "permanent", code: "message-gone", cause: read.cause, at: stamp(now) }}::jsonb, updated_at = now()
        where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state in ('in_flight', 'unknown') and state = 'confirmed'`;
      return null;
    }
    const message = read.message;
    if (message.author.id === self.id && message.chat === row.chat && row.edit_hash !== null
        && row.applied_hash !== null && row.edit_hash !== row.applied_hash && contentHash(message.content) === row.edit_hash) {
      if (await settleEdit(ctx, row.key, attempt, { by: "readback", revision: row.edit_revision })) return await dueIfOwed(ctx, gate, row.key);
      return null;
    }
    return await nothing({ reason: "no-positive-evidence" });
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      const at = learnLimit(ctx, gate, verdict);
      if (!wasUnknown) {
        await sql`update platform_effect set retry_at = ${stamp(at)}::timestamptz, updated_at = now()
          where key = ${row.key} and edit_attempt_id = ${attempt} and edit_state = 'in_flight'`;
      }
      return wasUnknown ? null : at;
    }
    return await nothing({ reason: "read-failed", failure: verdict.failure });
  }
}
