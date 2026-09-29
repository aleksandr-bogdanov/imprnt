import type { Adapter, AdapterCapabilities, CapabilityContext, ExitEvidence } from "../adapters/types.ts";
import { contextNotice, holdNotice, type Language } from "../door/lines.ts";
import { effectsLine, type NativeContext } from "../recovery/holds.ts";
import { appendEntry } from "../records/diary.ts";
import { languageOf, noticeRoute } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { bootMoved, groupPresence, presence } from "../os/tree.ts";
import type { StoreLike } from "../store/connect.ts";
import { appendNotice, type ReplyRoute } from "../store/outbox.ts";
import { UNRESOLVED, journaledOf, noteExecution, unresolvedOf, type ExecutionRow } from "../store/conversations.ts";
import type { InboundSource } from "../store/inbound.ts";
import { clearProgress } from "./progress.ts";
import { settleTurn, type TurnRecord } from "./settle.ts";

/**
 * The protocol a runner speaks. 1 is every runner before conversations: it feeds
 * a claimed row again after a crash and treats an expired lease as a dead
 * process. 2 owns an attempt before it launches and never feeds a row that
 * reached the engine twice. A runner of 2 activates it in the store when it
 * starts (`activateProtocol`), and from then on the claim trigger refuses every
 * claim that does not say it speaks 2, on any connection; the diary line at start
 * is only what `check` reads to see which runners are which.
 */
export const RUNNER_PROTOCOL = 2;

/** The migration this runner needs. A runner ahead of its schema does not serve. */
export async function requireSchema(store: StoreLike): Promise<void> {
  const [found] = (await store.sql`select to_regclass('public.execution') is not null
      and to_regclass('public.runner_incarnation') is not null
      and to_regclass('public.hub_protocol') is not null as present`) as unknown as { present: boolean }[];
  if (!found?.present) throw new Error("schema-behind: apply migration 11 (conversations) before this runner serves");
}

const NONE: AdapterCapabilities = { stableSession: false, safeResume: false, delegationDisabled: false };

/**
 * What each adapter can do, remembered for a short while and refreshed off the
 * claim path. A claim never waits for a probe: it uses the last answer and,
 * with none, the answer "no". A capability that has not been shown is not a
 * yes, and a probe that failed is the same as one that has not been made.
 */
export function capabilityReader(ttlMs = 30_000) {
  const seen = new Map<string, { at: number; value: AdapterCapabilities; pending: Promise<void> | null }>();
  const ask = async (adapter: Adapter, context: CapabilityContext): Promise<AdapterCapabilities> => {
    if (!adapter.capabilities) return NONE;
    try { return { ...NONE, ...(await adapter.capabilities(context)) }; } catch { return NONE; }
  };
  const key = (adapter: Adapter, context: CapabilityContext) => `${adapter.name}\0${context.preset}`;
  return {
    /** The last answer, refreshing in the background when it is old. Never awaits a probe. */
    peek(adapter: Adapter, context: CapabilityContext): AdapterCapabilities {
      const k = key(adapter, context);
      const held = seen.get(k) ?? { at: 0, value: NONE, pending: null };
      seen.set(k, held);
      if (!adapter.capabilities) return NONE;
      if (held.pending === null && Date.now() - held.at >= ttlMs) {
        held.pending = ask(adapter, context).then(value => { held.value = value; held.at = Date.now(); }).finally(() => { held.pending = null; });
      }
      return held.value;
    },
    /**
     * A launch is about to happen, so the answer is waited for, but a fresh one is
     * not asked for again: within the window the last answer stands, so a claim does
     * not pay for a probe of the CLI every time.
     */
    async get(adapter: Adapter, context: CapabilityContext): Promise<AdapterCapabilities> {
      const k = key(adapter, context);
      const held = seen.get(k);
      if (held && held.at > 0 && Date.now() - held.at < ttlMs) return held.value;
      const value = await ask(adapter, context);
      seen.set(k, { at: Date.now(), value, pending: null });
      return value;
    },
  };
}

/** Where this process runs: which machine, and which boot of it. */
export interface Here { machine: string | null; boot: string | null }

/**
 * What a process table can say about an attempt whose owner is gone.
 *
 * TWO THINGS PROVE AN ATTEMPT IS OVER, and nothing else does:
 *   a different boot of the same machine  every process of the earlier boot is gone,
 *                                         whatever was or was not recorded about it. A boot is
 *                                         told by the kernel's per-boot session id (linux
 *                                         `boot_id`, macOS `kern.bootsessionuuid`) and by nothing
 *                                         that moves with the clock;
 *   the leader gone and nothing left      a bounded claim about the managed process: the
 *                                         child led a process group of its own, the system
 *                                         says that group is empty, every process ever
 *                                         recorded under it is gone, and its leader exited.
 * What does NOT prove it: an old incarnation, an empty list, a lease that ran out, a
 * lookup that FAILED (that is unknown, never gone), and above all the absence of a
 * process nobody recorded. A record with no verified group proves nothing, however
 * many of its processes are gone, and a recorded process that is still there (a
 * detached survivor included) keeps the attempt open. A tool that detached itself
 * (its own session or group) before anything recorded it is outside both the record
 * and the group, and nothing here can see it: only a reboot rules it out. Nothing here
 * says an effect outside the process table (a file, an API, a message) was undone.
 * That is stated in `via`, and an attempt with nothing recorded stays unknown.
 */
export function evidenceFromRecord(execution: Pick<ExecutionRow, "evidence">, here?: Here): ExitEvidence {
  const record = (execution.evidence ?? {}) as Record<string, unknown>;
  // ONLY TWO VALID IDENTITIES OF ONE SCHEME THAT DIFFER (`bootMoved`) say the machine booted
  // again. A missing, malformed, untagged or other-scheme identity says nothing, and above all a
  // boot TIME that moved with the clock is not read as a reboot.
  if (bootMoved(record.boot_id, here?.boot ?? null) && typeof record.machine === "string" && record.machine === here?.machine) {
    return { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], basis: "boot", group: null,
      via: "the machine booted again after this attempt's processes were recorded, so none of them can still be running" };
  }
  const pids = Array.isArray(record.pids) ? (record.pids as unknown[]).filter((one): one is number => typeof one === "number") : [];
  if (record.legacy === true || pids.length === 0) {
    return { confirmed: false, leader: "unknown", descendants: "unverified", pids: [], survivors: [], basis: "none", group: null,
      via: "no process was recorded for this attempt" };
  }
  const group = typeof record.group === "number" ? record.group : null;
  const inGroup = group === null ? null : groupPresence(group);
  const looked = pids.map(one => [one, presence(one)] as const);
  const survivors = looked.filter(([, said]) => said === "present").map(([one]) => one);
  const unknown = looked.filter(([, said]) => said === "unknown").map(([one]) => one);
  const said = typeof record.leader === "number" ? presence(record.leader) : "unknown";
  const leader = said === "present" ? "alive" : said === "absent" ? "exited" : "unknown";
  const others = inGroup === "present" || survivors.length > 0;
  const verified = inGroup === "absent" && unknown.length === 0;
  const descendants = others ? "survivors" : verified ? "none" : "unverified";
  return {
    confirmed: leader === "exited" && descendants === "none",
    leader,
    descendants,
    pids, survivors, unknown,
    partial: record.partial === true,
    group,
    basis: inGroup === "absent" ? "process-group" : "observed-tree",
    via: group !== null
      ? "the process group and every process recorded under it, looked up again (a process that left the group before it was recorded is not covered)"
      : "the processes recorded for the attempt, looked up again (no process group of its own was recorded, so a process that was never recorded is not covered and nothing here proves it gone)",
  };
}

/** Where a hold is said: the chat the row came from, or the route a job's report goes back on. */
function whereToSay(registry: Registry, row: { person: string; agent: string; source?: InboundSource | null }): { agent: string; route: ReplyRoute; platform: string; language: Language } | null {
  const back = row.source?.dispatch?.return;
  if (back) {
    const known = noticeRoute(registry, back.agent);
    return { agent: back.agent, route: { door: back.door, chat: back.chat }, platform: known?.platform ?? "discord", language: (known?.language ?? languageOf(registry, row.person)) as Language };
  }
  const own = noticeRoute(registry, row.agent);
  return own ? { agent: row.agent, route: own.route, platform: own.platform, language: own.language as Language } : null;
}

/**
 * The notice that names the attempt, what is known about it and the exact command
 * that decides it. Keyed on the attempt and its revision, so it lands once however
 * many times it is asked for: at the end of an attempt, at every start of the
 * runner, and again after a restart that finds a hold nobody was told about.
 */
async function announceHold(store: StoreLike, registry: Registry, hold: {
  row: { id: string; person: string; agent: string; source?: InboundSource | null };
  execution: string; revision: number; cause: string; effects: Record<string, unknown>;
}): Promise<void> {
  const where = whereToSay(registry, hold.row);
  if (!where) return;
  await appendNotice(store, {
    person: hold.row.person, agent: where.agent, route: where.route, platform: where.platform,
    language: where.language,
    body: holdNotice(where.language, { agent: hold.row.agent, attempt: hold.execution, revision: hold.revision, cause: hold.cause, effects: effectsLine(hold.effects) }),
    noticeKey: `hold:${hold.execution}:${hold.revision}`,
  });
}

/** What an agent's engine was measured to be able to do, and the engine and configuration that was measured. */
export interface EngineReading { caps: AdapterCapabilities; engine: string }

/**
 * Whether a held conversation can take a turn on a native context that resumes
 * without replaying what the interrupted attempt left unfinished. Ready only when
 * the engine was MEASURED able to (a stable session and a validated safe resume)
 * and the conversation's own session is one the engine acknowledged; anything else
 * is unavailable, by name. There is no rebuilt context to fall back to.
 */
export function judgeContext(reading: EngineReading, hold: { attempt_session: string | null; native_state: string }): NativeContext {
  const cause = !reading.caps.stableSession || !reading.caps.safeResume ? "safe-resume-unvalidated"
    : !hold.attempt_session ? "no-native-session-recorded"
    : hold.native_state === "new" || hold.native_state === "launched" ? "native-state-uncertain"
    : null;
  return cause ? { state: "unavailable", cause, engine: reading.engine, at: new Date().toISOString() }
    : { state: "ready", engine: reading.engine, at: new Date().toISOString() };
}

/**
 * The notice that says a held conversation cannot take a turn yet, and why. Keyed
 * on the attempt, its revision AND the cause, so it lands once however often it
 * is asked for (every look, every restart) and again only when what is known
 * moves: a new revision or a different cause.
 */
async function announceContext(store: StoreLike, registry: Registry, hold: {
  row: { id: string; person: string; agent: string; source?: InboundSource | null };
  execution: string; revision: number; cause: string;
}): Promise<void> {
  const where = whereToSay(registry, hold.row);
  if (!where) return;
  await appendNotice(store, {
    person: hold.row.person, agent: where.agent, route: where.route, platform: where.platform,
    language: where.language,
    body: contextNotice(where.language, { agent: hold.row.agent, attempt: hold.execution, revision: hold.revision, cause: hold.cause }),
    noticeKey: `context:${hold.execution}:${hold.revision}:${hold.cause}`,
  });
}

/**
 * What a runner has not measured on the engine it is running now is not shown as
 * measured: at start and at stop every open hold of its attempts goes back to
 * pending verification, so a status measured on an engine or a configuration that
 * has changed since is never presented as current. The next look measures it again.
 */
export async function markContextPending(store: StoreLike, runner: string): Promise<void> {
  await store.sql`update replay_hold h set native_context = ${{ state: "pending" }}::jsonb
    from execution e
    where e.id = h.execution_id and e.runner = ${runner} and h.state <> 'released'
      and h.native_context ->> 'state' is distinct from 'pending'`;
}

/** Whether this runner has a terminal hold whose native context could be looked at: the watch's starting value. */
export async function hasContextsToMeasure(store: StoreLike, runner: string): Promise<boolean> {
  const [found] = (await store.sql`select exists (
      select 1 from replay_hold h join execution e on e.id = h.execution_id
       where e.runner = ${runner} and h.state <> 'released' and e.state in ('interrupted', 'stopped')) as open`) as unknown as { open: boolean }[];
  return found?.open === true;
}

/**
 * Measure, for every terminal hold of this runner's attempts, whether its
 * conversation can take a turn, and make it durable and owner-visible. This does
 * NOT depend on any row being claimable: a conversation whose engine is not shown
 * able to resume is filtered out of every claim before it is ever claimed, and the
 * owner is told regardless. Idempotent: an unchanged measurement writes nothing, and
 * the notice is one per attempt, revision and cause.
 *
 * A hold whose ownership is still unresolved is not measured: nothing runs for it
 * until the attempt is shown over, and that moves its revision. Returns how many
 * holds could NOT be measured (their agent's engine is not readable right now), so
 * the caller keeps looking only while there are; a hold that was measured, usable
 * or not, is stable until something raises the watch again (a new hold, a moved
 * attempt, or the engine's answer flipping).
 */
export async function reconcileContexts(
  store: StoreLike,
  at: { runner: string; registry: Registry; readingFor(agent: string): Promise<EngineReading | null> },
): Promise<number> {
  const holds = (await store.sql`select h.inbound_id, h.execution_id, h.revision, e.native_session as attempt_session, c.agent, c.native_state,
      i.person, i.agent as row_agent, i.source
    from replay_hold h join execution e on e.id = h.execution_id join conversation c on c.id = h.conversation_id join inbound i on i.id = h.inbound_id
    where e.runner = ${at.runner} and h.state <> 'released' and e.state in ('interrupted', 'stopped')
    order by h.created_at, h.execution_id`) as unknown as
    { inbound_id: string; execution_id: string; revision: number; attempt_session: string | null; agent: string; native_state: string;
      person: string; row_agent: string; source: InboundSource | null }[];
  let unmeasured = 0;
  for (const hold of holds) {
    const reading = await at.readingFor(hold.agent);
    if (!reading) { unmeasured += 1; continue; }
    const next = judgeContext(reading, hold);
    await store.sql.begin(async (tx) => {
      const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
      // Only for THIS attempt at THIS revision, and only when the measurement itself (not its time) moved.
      const moved = await tx`update replay_hold set native_context = ${next}::jsonb
        where inbound_id = ${hold.inbound_id} and execution_id = ${hold.execution_id} and revision = ${hold.revision} and state <> 'released'
          and (native_context is null or (native_context - 'at') is distinct from (${next}::jsonb - 'at'))
        returning inbound_id`;
      if (moved.length > 0 && next.state === "unavailable") {
        await announceContext(inside, at.registry, { row: { id: hold.inbound_id, person: hold.person, agent: hold.row_agent, source: hold.source },
          execution: hold.execution_id, revision: hold.revision, cause: next.cause! });
      }
    });
  }
  return unmeasured;
}

export interface EndedAttempt {
  /** The attempt's state, or `journaled` when it has a result of its own that is still to be settled. */
  state: string;
  /** The hold's recovery revision, when the attempt left one. */
  revision: number | null;
}

/** A result an attempt journaled that a settle can be made from. Anything else is not a result. */
export function usableJournal(result: Record<string, unknown> | null): result is { text?: string; chunks: string[]; turn: TurnRecord } {
  return !!result && typeof result === "object" && Array.isArray((result as { chunks?: unknown }).chunks)
    && typeof (result as { turn?: unknown }).turn === "object" && (result as { turn?: unknown }).turn !== null;
}

/**
 * The end of an attempt that did not settle, in ONE transaction: what became of
 * the attempt, the hold on its input, the claim released, its progress line
 * cleared, the diary line and the notice.
 *
 * WHAT THE STATE MEANS, and it is only ever chosen from the evidence:
 *   a result of its own, journaled   nothing ends here: the attempt is left as it is
 *                                    (`journaled`), still owned, because the model
 *                                    finished and what is owed is the settle
 *   never given the input            failed       (no effects, the row may be tried again). ONLY
 *                                    a claimed attempt nothing was fed to, or one whose FIRST
 *                                    feed the adapter refused before writing a byte
 *                                    (`FeedNotWritten`): no output, no receipt and no
 *                                    refusal by the loop are not this
 *   ended, every process shown gone  interrupted  (terminal, the input stays held)
 *   ended, anything not shown gone   unknown      (the slot stays taken, the input stays held)
 *   the same, after an explicit stop stopped / stop_unknown
 * A `tail` attempt has no input to hold: it ends the same way and leaves no hold.
 * Nothing here retries, rolls back or feeds anything: a held input is the
 * owner's to decide, and the choice arrives as a new input.
 */
export async function endAttempt(
  store: StoreLike,
  end: {
    execution: string;
    evidence: ExitEvidence | null;
    cause: string;
    effects?: { actions: number; lastAction: string };
    /** False when the engine was never given the input, whatever state the row says. */
    delivered?: boolean;
    /** An explicit stop asked for this attempt to end. */
    requested?: boolean;
    registry?: Registry | null;
  },
): Promise<EndedAttempt> {
  return await store.sql.begin(async (tx) => {
    const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
    const [ex] = (await tx`select * from execution where id = ${end.execution} for update`) as unknown as ExecutionRow[];
    if (!ex || !(UNRESOLVED as readonly string[]).includes(ex.state)) return { state: ex?.state ?? "missing", revision: null };
    // A finished answer is not an interruption. The model produced it and it is
    // journaled: whatever cut the attempt off (a failed settle, a stop that landed
    // between the journal and the settle) does not turn it into held work, and the
    // settle is retried from the journal until it lands.
    if (ex.result !== null) {
      if (usableJournal(ex.result)) return { state: "journaled", revision: null };
      await noteExecution(inside, ex.id, "journal.unreadable", {});
    }
    const confirmed = end.evidence?.confirmed === true;
    const asked = end.requested === true || ex.state === "stop_requested" || ex.state === "stop_unknown";
    const state = end.delivered === false || ex.state === "claimed" ? "failed"
      : asked ? (confirmed ? "stopped" : "stop_unknown")
      : confirmed ? "interrupted" : "unknown";
    const terminal = state === "failed" || state === "interrupted" || state === "stopped";
    const effects = end.effects ?? ex.effects;
    await tx`update execution
      set state = ${state}, evidence = evidence || ${{ exit: end.evidence, cause: end.cause }}::jsonb,
          effects = ${effects}::jsonb, ended_at = case when ${terminal}::boolean then now() else ended_at end
      where id = ${ex.id}`;
    if (ex.inbound_id === null) {
      // A tail: nothing was asked of the agent, so there is no input to hold and no
      // owner to ask. The slot stays taken exactly as long as the process is not
      // shown to be gone.
      await noteExecution(inside, ex.id, state, { cause: end.cause, purpose: "tail", exit: end.evidence?.via ?? null,
        leader: end.evidence?.leader ?? "unknown", descendants: end.evidence?.descendants ?? "unverified", survivors: end.evidence?.survivors ?? [] });
      return { state, revision: null };
    }
    const [row] = (await tx`select id, person, agent, source from inbound where id = ${ex.inbound_id}`) as unknown as
      { id: string; person: string; agent: string; source: InboundSource | null }[];
    await tx`update inbound set claimed_by = null, claim_deadline = null where id = ${ex.inbound_id} and claimed_by is not null`;
    await clearProgress(inside, ex.inbound_id);
    if (state === "failed") {
      await noteExecution(inside, ex.id, "failed", { cause: end.cause });
      return { state, revision: null };
    }
    const cause = state === "interrupted" ? "interrupted" : state === "stopped" ? "stopped" : "ownership-unknown";
    await tx`insert into replay_hold (inbound_id, execution_id, conversation_id, cause)
      values (${ex.inbound_id}, ${ex.id}, ${ex.conversation_id}, ${cause})
      on conflict (inbound_id) do update
        -- What is known moved, so a choice made against the old knowledge is void.
        -- Except the one that WAS the wait for this: an owner who chose to continue
        -- while ownership was unknown chose exactly this evidence, and keeps it.
        set cause = excluded.cause,
            revision = case when replay_hold.state = 'continue_pending' then replay_hold.revision else replay_hold.revision + 1 end,
            -- What was measured about the native context belongs to the revision it was measured at.
            native_context = case when replay_hold.state = 'continue_pending' then replay_hold.native_context else null end,
            updated_at = now()
        where replay_hold.cause <> excluded.cause`;
    const [standing] = (await tx`select revision from replay_hold where inbound_id = ${ex.inbound_id}`) as unknown as { revision: number }[];
    await noteExecution(inside, ex.id, state, { cause: end.cause, revision: standing.revision, exit: end.evidence?.via ?? null,
      leader: end.evidence?.leader ?? "unknown", descendants: end.evidence?.descendants ?? "unverified", survivors: end.evidence?.survivors ?? [],
      basis: end.evidence?.basis ?? "none" });
    // Told every time this is reached, and the notice's own key makes it once: a
    // hold that already existed and did not move is announced too, so one that was
    // never announced (a runner that stopped before it could) is not lost.
    if (end.registry && row) {
      await announceHold(inside, end.registry, { row, execution: ex.id, revision: standing.revision, cause, effects });
    }
    // An owner who already chose to continue is waiting on exactly this: the
    // proof that the old attempt is over. With it, the continuation is queued.
    if (terminal) await tx`select hub_hold_advance(${ex.inbound_id})`;
    return { state, revision: standing.revision };
  });
}

/**
 * The holds this runner's attempts have open, announced. A hold that was opened
 * before this runner (or this build) could say so, or whose notice never reached
 * the outbox, is told to the owner now; one already told is the same notice key
 * and lands nothing.
 */
async function announceOpenHolds(store: StoreLike, registry: Registry, runner: string): Promise<void> {
  const open = (await store.sql`select h.execution_id, h.revision, h.cause, e.effects,
      i.id, i.person, i.agent, i.source
    from replay_hold h join execution e on e.id = h.execution_id join inbound i on i.id = h.inbound_id
    where e.runner = ${runner} and h.state <> 'released'
    order by h.created_at, h.execution_id`) as unknown as
    { execution_id: string; revision: number; cause: string; effects: Record<string, unknown>; id: string; person: string; agent: string; source: InboundSource | null }[];
  for (const hold of open) {
    await announceHold(store, registry, { row: { id: hold.id, person: hold.person, agent: hold.agent, source: hold.source },
      execution: hold.execution_id, revision: hold.revision, cause: hold.cause, effects: hold.effects });
  }
}

/**
 * At start, before anything is claimed: every attempt an earlier incarnation of
 * this runner left unsettled is resolved, and none of it is run again.
 *   a result the attempt had already journaled   settled from it, without generation
 *   claimed and never fed                        failed, the row may be tried again
 *   fed, with every recorded process gone        interrupted, the input held
 *   fed, with anything else                      unknown, the slot stays taken
 * A runner cannot vouch for a process it cannot see, so nothing another
 * machine's runner started is touched here: attempts are looked up by runner. The
 * evidence knows which machine and which boot this is, so a reboot is the one
 * thing that proves a whole earlier boot's processes gone.
 *
 * Returns how many journaled results are still to be settled, so the runner keeps
 * trying to.
 */
export async function reconcileExecutions(
  store: StoreLike,
  at: { runner: string; incarnation: string; registry: Registry; here?: Here },
): Promise<number> {
  for (const ex of await unresolvedOf(store, at.runner, at.incarnation)) {
    if (usableJournal(ex.result)) continue;
    await endAttempt(store, { execution: ex.id, evidence: evidenceFromRecord(ex, at.here), cause: "the runner that started it stopped", registry: at.registry });
  }
  const owed = await settleStored(store, { runner: at.runner });
  await announceOpenHolds(store, at.registry, at.runner);
  return owed;
}

/**
 * Attempts of this runner whose ownership is unresolved, looked at again: the
 * process that was not shown to be gone may have gone since. Only PROOF moves an
 * attempt, and an attempt still not proved is left exactly as it is, without a
 * diary line for every look. Returns how many are still unresolved, so a caller
 * can stop looking when there are none.
 */
export async function reevaluateUnknown(store: StoreLike, at: { runner: string; registry: Registry; here?: Here; moved?: () => void }): Promise<number> {
  const open = (await store.sql`select * from execution
    where runner = ${at.runner} and state in ('unknown', 'stop_unknown') order by started_at, id`) as unknown as ExecutionRow[];
  let remaining = 0;
  for (const ex of open) {
    const evidence = evidenceFromRecord(ex, at.here);
    if (!evidence.confirmed) { remaining += 1; continue; }
    await endAttempt(store, { execution: ex.id, evidence, cause: "the process tree was looked up again and is gone", registry: at.registry });
    // A hold that was waiting on this proof is now one whose native context matters.
    at.moved?.();
  }
  return remaining;
}

/**
 * Whether this runner has something to look at again on its tick: attempts whose
 * ownership is unresolved, or holds whose native context is not yet shown usable.
 *
 * THE WATCH GOES DOWN ONLY ON A FULL LOOK THAT FOUND NOTHING LEFT AND DURING WHICH
 * NOTHING WAS RAISED. A look awaits the store, and another agent can end an
 * attempt `unknown` (or open a hold) while it does: the look never saw it, so its
 * zero says nothing about it, and lowering the watch on that zero would leave the
 * new one unexamined until something else raised it. `raise` is called at EVERY
 * site that creates such a thing and moves the mark; a look that started before
 * it cannot lower the watch. Nothing polls: with the watch down the tick issues no
 * statement.
 */
export function markedWatch(initial: boolean) {
  let watching = initial;
  let mark = 0;
  return {
    get watching(): boolean { return watching; },
    /** An attempt of this runner was just left unresolved. */
    raise(): void { watching = true; mark += 1; },
    /** One look at every unresolved attempt: `unresolved` answers how many are still open after it. */
    async look(unresolved: () => Promise<number>): Promise<void> {
      const before = mark;
      const remaining = await unresolved();
      if (remaining === 0 && before === mark) watching = false;
    },
  };
}

/**
 * Settle every result this runner's attempts journaled and never settled, under
 * the DELIBERATE recovery authority: the result is stored, the model is not asked
 * again, and neither the placement generation nor the incarnation is consulted
 * (the answer exists, and losing it is the only alternative). One that fails, on a
 * transient error or anything else, is left journaled and counted, so the next
 * look tries again; it is never turned into an interruption. `skip` is the
 * attempts a live turn is settling itself, and `only` narrows it to one.
 * Returns how many are still owed WITHIN THAT SCOPE, and an attempt that was
 * skipped because a live turn is settling it is still owed until that turn has:
 * skipping it is not settling it. A caller that asked about one attempt (`only`)
 * learns nothing about the others, so it must not treat the answer as the runner's
 * whole debt.
 */
export async function settleStored(store: StoreLike, at: { runner: string; skip?: ReadonlySet<string>; only?: string }): Promise<number> {
  let owed = 0;
  for (const ex of await journaledOf(store, at.runner)) {
    if (!usableJournal(ex.result) || (at.only !== undefined && ex.id !== at.only)) continue;
    if (at.skip?.has(ex.id)) { owed += 1; continue; }
    try { await settleJournaled(store, ex); } catch { owed += 1; }
  }
  return owed;
}

/** The reply a finished turn had already journaled, settled exactly as the live settle would have. */
export async function settleJournaled(store: StoreLike, ex: ExecutionRow): Promise<void> {
  if (ex.inbound_id === null) return;
  const [row] = (await store.sql`select id, person, kind, source, state from inbound where id = ${ex.inbound_id}`) as unknown as
    { id: string; person: string; kind: string; source: InboundSource | null; state: string }[];
  const saved = ex.result;
  if (!usableJournal(saved)) {
    await appendEntry(store, { stream: "execution", subject: ex.id, kind: "journal.unreadable", actor: "runner", detail: {} });
    return;
  }
  if (!row || row.state === "answered" || row.state === "delivered") {
    // Nothing left to write: the reply is already in.
    await store.sql`update execution set state = 'completed', ended_at = now() where id = ${ex.id} and state <> 'completed'`;
    return;
  }
  await settleTurn(store, {
    inboundId: row.id, person: row.person, source: row.source, kind: row.kind,
    chunks: saved.chunks, turn: saved.turn, execution: { id: ex.id, runner: ex.runner, fence: { recovery: true } },
  });
}
