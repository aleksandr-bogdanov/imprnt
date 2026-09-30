import type { StoreLike } from "./connect.ts";
import type { InboundSource, JobSource } from "./inbound.ts";

/**
 * Conversations, attempts and holds, as the runner and the door read and write
 * them. Every function takes a `StoreLike` so a caller can hand it its own
 * transaction: what has to commit together (a settle and its attempt, an
 * interruption and its hold) commits together.
 *
 * JSON travels as the VALUE and never as a string: a `jsonb` parameter given
 * `JSON.stringify(...)` lands as a jsonb string in the column, not the record,
 * and every reader (`evidence ->> 'pids'`, `jsonb ||`) then reads nothing or
 * builds an array. The cast is written out and the object is the parameter.
 */

/** The states in which an attempt may be running, or may have run and not been shown to have ended. */
export const UNRESOLVED = ["claimed", "feed_intent", "received", "running", "unknown", "stop_requested", "stop_unknown"] as const;
/** The states an attempt may be in while the engine holds the input: fed, not finished. */
export const FED = ["feed_intent", "received", "running"] as const;

export interface Conversation {
  id: string;
  person: string;
  agent: string;
  kind: "master" | "worker";
  owner_ref: string | null;
  adapter: string;
  machine: string | null;
  placement_generation: number;
  native_session: string;
  native_state: "new" | "launched" | "started" | "verified";
}

export interface ExecutionRow {
  id: string;
  /** Null only for a `tail` attempt, which primes a fresh child and answers nobody. */
  inbound_id: string | null;
  conversation_id: string;
  agent: string;
  runner: string;
  incarnation: string;
  placement_generation: number;
  purpose: "turn" | "tail";
  state: string;
  input_digest: string;
  native_session: string | null;
  result: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  effects: Record<string, unknown>;
}

export interface HoldRow {
  inbound_id: string;
  execution_id: string;
  conversation_id: string;
  cause: "interrupted" | "ownership-unknown" | "stopped";
  state: "held" | "keep_held" | "continue_pending" | "continuing" | "released";
  revision: number;
  choice: string | null;
  chosen_by: string | null;
}

/** A conversation the row cannot be given, said by name and never defaulted away. */
export class ConversationRefused extends Error {
  constructor(readonly refusal: "conversation unavailable" | "conversation elsewhere") {
    super(`conversation-refused: ${refusal}`);
    this.name = "ConversationRefused";
  }
}

/** Another attempt of this agent is running or has unresolved ownership. */
export class ExecutionBusy extends Error {
  constructor(readonly conversation: string) {
    super(`execution-busy: ${conversation}`);
    this.name = "ExecutionBusy";
  }
}

/**
 * An attempt this runner incarnation does not own any more, or a write that was
 * not made by the claim, the incarnation and the placement generation it names.
 * `reason` says which fence held.
 */
export class ExecutionNotOwned extends Error {
  constructor(readonly execution: string, readonly reason: "state" | "claim" | "generation" | "incarnation" | "stored-result" = "state") {
    super(`execution-not-owned: ${execution} (${reason})`);
    this.name = "ExecutionNotOwned";
  }
}

const COLUMNS = "id, person, agent, kind, owner_ref, adapter, machine, placement_generation, native_session, native_state";

/**
 * The conversation an input belongs to, made when it does not exist yet.
 *
 * A master has one, for good. A NEW job has a fresh one of its own, even when
 * the same configured worker served the last job, and a job that names an
 * existing conversation (`dispatch.conversation`, the explicit follow-up) is
 * put into that one after it is shown to be the same person's, the same
 * worker's and the same machine's. Anything else is refused by name: a follow-up
 * is never quietly turned into a new conversation, which is a different thing.
 */
export async function conversationFor(
  store: StoreLike,
  want: {
    row: { id: string; person: string; agent: string; kind: string; source?: InboundSource | JobSource | null };
    adapter: string;
    machine: string;
  },
): Promise<Conversation> {
  const { row } = want;
  const followUp = row.kind === "job" ? row.source?.dispatch?.conversation : undefined;
  if (followUp !== undefined) {
    const [found] = (await store.sql.unsafe(`select ${COLUMNS} from conversation where id = $1`, [followUp])) as unknown as Conversation[];
    if (!found || found.kind !== "worker" || found.agent !== row.agent || found.person !== row.person) {
      throw new ConversationRefused("conversation unavailable");
    }
    if (found.adapter !== "unknown" && found.adapter !== want.adapter) throw new ConversationRefused("conversation unavailable");
    if (found.machine !== null && found.machine !== want.machine) throw new ConversationRefused("conversation elsewhere");
    return await place(store, found, want);
  }
  if (row.kind === "job") {
    await store.sql`insert into conversation (id, person, agent, kind, owner_ref, adapter, native_session)
      values (${crypto.randomUUID()}, ${row.person}, ${row.agent}, 'worker', ${row.id}, ${want.adapter}, ${crypto.randomUUID()})
      on conflict (owner_ref) where kind = 'worker' do nothing`;
    const [own] = (await store.sql.unsafe(`select ${COLUMNS} from conversation where kind = 'worker' and owner_ref = $1`, [row.id])) as unknown as Conversation[];
    return await place(store, own, want);
  }
  await store.sql`insert into conversation (id, person, agent, kind, adapter, native_session)
    values (${crypto.randomUUID()}, ${row.person}, ${row.agent}, 'master', ${want.adapter}, ${crypto.randomUUID()})
    on conflict (agent) where kind = 'master' do nothing`;
  const [master] = (await store.sql.unsafe(`select ${COLUMNS} from conversation where kind = 'master' and agent = $1`, [row.agent])) as unknown as Conversation[];
  return await place(store, master, want);
}

/** The machine and the engine a conversation is first used on are recorded and then checked, never overwritten. */
async function place(store: StoreLike, found: Conversation, want: { adapter: string; machine: string }): Promise<Conversation> {
  if (found.machine !== null && found.machine !== want.machine) throw new ConversationRefused("conversation elsewhere");
  if (found.machine === null || found.adapter !== want.adapter) {
    // A master follows its agent's engine; a worker's engine was checked above.
    const [placed] = (await store.sql.unsafe(
      `update conversation set machine = coalesce(machine, $2), adapter = $3 where id = $1 returning ${COLUMNS}`,
      [found.id, want.machine, want.adapter])) as unknown as Conversation[];
    return placed;
  }
  return found;
}

/**
 * A child is about to be started under the conversation's own session id for the
 * first time. From this write on the id may exist in the engine whether or not
 * the engine ever acknowledges a message under it, so the hub never treats it as
 * a new one again: see `mintNativeSession`.
 */
export async function markLaunched(store: StoreLike, conversation: string): Promise<void> {
  await store.sql`update conversation set native_state = 'launched' where id = ${conversation} and native_state = 'new'`;
}

/**
 * The session a conversation's launch that nobody acknowledged is replaced by.
 * Only `launched` is replaced (the engine took no message under it, so nothing
 * of the conversation is in it that the hub knows of); the old id is returned so
 * the diary can say it was given up on. `new` needs no replacing, and a session
 * the engine acknowledged (`started`, `verified`) is never replaced here.
 */
export async function mintNativeSession(store: StoreLike, conversation: string): Promise<{ id: string; replaced: string } | null> {
  const id = crypto.randomUUID();
  const [was] = (await store.sql`update conversation c set native_session = ${id}, native_state = 'new'
      from (select native_session from conversation where id = ${conversation} and native_state = 'launched' for update) old
     where c.id = ${conversation} and c.native_state = 'launched'
    returning old.native_session as replaced`) as unknown as { replaced: string }[];
  return was ? { id, replaced: was.replaced } : null;
}

/** The engine took a message (`started`) or reported the same id back (`verified`). Never moves backwards. */
export async function noteNative(store: StoreLike, conversation: string, state: "started" | "verified"): Promise<void> {
  await store.sql`update conversation set native_state = ${state}
    where id = ${conversation}
      and native_state <> 'verified'
      and (native_state in ('new', 'launched') or ${state} = 'verified')`;
}

/**
 * The engine said which session it is in. The id it was launched under is
 * `verified`; a different one is what the engine really has, so it becomes the
 * locator and the difference is returned for the diary rather than hidden.
 */
export async function verifyNative(store: StoreLike, conversation: string, expected: string, reported: string): Promise<"verified" | "mismatch"> {
  if (reported === expected) {
    await noteNative(store, conversation, "verified");
    return "verified";
  }
  await store.sql`update conversation set native_session = ${reported}, native_state = 'started' where id = ${conversation}`;
  return "mismatch";
}

/** What an attempt is known to have done so far, kept so a crash can still say it. */
export async function noteEffects(store: StoreLike, execution: string, effects: { actions: number; lastAction: string }): Promise<void> {
  await store.sql`update execution set effects = ${effects}::jsonb
    where id = ${execution} and state in ('feed_intent', 'received', 'running')`;
}

/**
 * This process, as the incarnation the runner's attempts are fenced by. The newest
 * registration wins, so an older incarnation of the same runner can no longer
 * open, feed or settle an attempt as current.
 */
export async function registerIncarnation(
  store: StoreLike,
  who: { runner: string; incarnation: string; machine: string | null; bootId: string | null },
): Promise<void> {
  await store.sql`insert into runner_incarnation (runner, incarnation, protocol, machine, boot_id)
    values (${who.runner}, ${who.incarnation}, 2, ${who.machine}, ${who.bootId})
    on conflict (runner) do update
      set incarnation = excluded.incarnation, protocol = excluded.protocol, machine = excluded.machine,
          boot_id = excluded.boot_id, started_at = now()`;
}

/**
 * Say that this runner speaks protocol 2, for good. Refused by the table while an
 * input a runner of protocol 1 may have handed to the engine is in flight, because
 * nothing could then say what became of it: the error names those inputs.
 */
export async function activateProtocol(store: StoreLike): Promise<void> {
  await store.sql`update hub_protocol set runner_protocol = 2, activated_at = now() where runner_protocol < 2`;
}

/** The busy answer to a unique violation of the table's own one-executor rule. */
function busyOrThrow(error: unknown, conversation: string): never {
  if (/execution_one_unresolved|execution_one_per_agent|duplicate key value/i.test(String((error as Error).message))) throw new ExecutionBusy(conversation);
  throw error;
}

/**
 * Open the attempt, and THE OPENING IS THE FENCE. One statement, and it inserts
 * only if, at that instant and under row locks:
 *   the input is still claimed by this runner (the claim is current, not a lease
 *     that was read a moment ago),
 *   this runner incarnation is the one registered as current,
 *   the conversation is on the placement generation the caller planned with.
 * The table then allows one unresolved attempt per agent and per conversation, so
 * two claimants that both got here, two jobs of one worker included, cannot both
 * insert: the second fails at the index, not at a check that ran before it.
 * A stale snapshot is refused, never quietly replaced by the current generation.
 */
export async function openExecution(
  store: StoreLike,
  open: {
    row: { id: string; agent: string };
    conversation: Conversation;
    runner: string;
    incarnation: string;
    digest: string;
    nativeSession: string | null;
    /** What is already known about the attempt's processes, e.g. the machine and its boot. */
    evidence?: Record<string, unknown>;
  },
): Promise<ExecutionRow> {
  const id = crypto.randomUUID();
  try {
    return await store.sql.begin(async (tx) => {
      const [made] = (await tx`insert into execution
        (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, native_session, evidence)
        select ${id}::text, i.id, c.id, ${open.row.agent}::text, ${open.runner}::text, ${open.incarnation}::text,
               c.placement_generation, 'claimed', ${open.digest}::text, ${open.nativeSession}::text, ${open.evidence ?? {}}::jsonb
          from inbound i, conversation c, runner_incarnation r
         where i.id = ${open.row.id} and i.claimed_by = ${open.runner} and i.state not in ('answered', 'delivered')
           and c.id = ${open.conversation.id} and c.placement_generation = ${open.conversation.placement_generation}
           and r.runner = ${open.runner} and r.incarnation = ${open.incarnation}
           for update of i, c for share of r
        returning *`) as unknown as ExecutionRow[];
      if (!made) throw await whyRefused(tx as unknown as StoreLike["sql"], open, id);
      // The attempt that owns the conversation from here is what the owner's
      // continuation was queued for, so the OWNER'S gate on it is done. That is
      // all it is: the original input stays excluded from replay for good.
      await tx`update replay_hold set state = 'released', updated_at = now()
        where continuation_id = ${open.row.id} and state = 'continuing'`;
      return made;
    });
  } catch (error) {
    if (error instanceof ExecutionNotOwned) throw error;
    return busyOrThrow(error, open.conversation.id);
  }
}

/** Which of the fences an insert that wrote nothing was stopped by, for the error that names it. */
async function whyRefused(sql: StoreLike["sql"], open: { row: { id: string }; conversation: Conversation; runner: string; incarnation: string }, id: string): Promise<ExecutionNotOwned> {
  const [seen] = (await sql`select
      (select claimed_by from inbound where id = ${open.row.id}) as claimed_by,
      (select placement_generation from conversation where id = ${open.conversation.id}) as generation,
      (select incarnation from runner_incarnation where runner = ${open.runner}) as current`) as unknown as
    { claimed_by: string | null; generation: number | null; current: string | null }[];
  const reason = seen?.current !== open.incarnation ? "incarnation"
    : seen?.claimed_by !== open.runner ? "claim"
    : "generation";
  return new ExecutionNotOwned(id, reason);
}

/**
 * Own the agent for a TAIL: the chat log a master's fresh child is primed with is
 * a model turn, so it is an attempt like any other. Same fence, no input row.
 */
export async function openTailExecution(
  store: StoreLike,
  open: { agent: string; conversation: Conversation; runner: string; incarnation: string; digest: string; nativeSession: string | null; evidence?: Record<string, unknown> },
): Promise<ExecutionRow> {
  const id = crypto.randomUUID();
  try {
    const [made] = (await store.sql`insert into execution
      (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, purpose, native_session, evidence)
      select ${id}::text, null::text, c.id, ${open.agent}::text, ${open.runner}::text, ${open.incarnation}::text,
             c.placement_generation, 'claimed', ${open.digest}::text, 'tail', ${open.nativeSession}::text, ${open.evidence ?? {}}::jsonb
        from conversation c, runner_incarnation r
       where c.id = ${open.conversation.id} and c.placement_generation = ${open.conversation.placement_generation}
         and r.runner = ${open.runner} and r.incarnation = ${open.incarnation}
         for update of c for share of r
      returning *`) as unknown as ExecutionRow[];
    if (!made) {
      const [seen] = (await store.sql`select (select incarnation from runner_incarnation where runner = ${open.runner}) as current`) as unknown as { current: string | null }[];
      throw new ExecutionNotOwned(id, seen?.current !== open.incarnation ? "incarnation" : "generation");
    }
    return made;
  } catch (error) {
    if (error instanceof ExecutionNotOwned) throw error;
    return busyOrThrow(error, open.conversation.id);
  }
}

/** One line of the diary about an attempt. The runner's own stream, so no stamp is touched. */
export async function noteExecution(store: StoreLike, execution: string, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
  await store.sql`insert into ledger_event (stream, subject, kind, actor, detail)
    values ('execution', ${execution}, ${kind}, 'runner', ${detail})`;
}

/**
 * The feed intent, committed BEFORE the first byte goes to the engine, together
 * with the input as the conversation's own entry. From this commit on a crash
 * is uncertain whatever the engine did or did not acknowledge.
 *
 * It is fenced the same way the opening was: it moves only an attempt that is
 * still this incarnation's, on the placement it started on, with the input still
 * claimed by this runner. An obsolete owner meets `ExecutionNotOwned` here, before
 * any byte can reach an engine.
 *
 * `stage: "tail"` is the priming tail a fresh child is fed on the attempt of a claimed
 * input. The tail is a model turn and may do things, so it is a feed of its own: the
 * attempt is `feed_intent` before it, and a crash inside it is uncertain and not "the
 * input was never fed". It records no conversation entry (the tail is not the input),
 * and the input's own feed intent then follows on the same attempt, once.
 */
export async function markFeedIntent(store: StoreLike, execution: ExecutionRow, text: string, stage: "input" | "tail" = "input"): Promise<void> {
  await store.sql.begin(async (tx) => {
    const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
    const moved = await tx`update execution e set state = 'feed_intent', feed_intent_at = coalesce(e.feed_intent_at, now()),
          evidence = case when ${stage === "tail"}::boolean then e.evidence || ${{ tail_fed: true }}::jsonb else e.evidence end
        from conversation c, runner_incarnation r
       where e.id = ${execution.id}
         and (e.state = 'claimed'
              -- The input's own feed, after the tail was fed on this attempt and before it was.
              or (${stage === "input"}::boolean and e.state = 'feed_intent' and e.inbound_id is not null and e.evidence ->> 'tail_fed' = 'true'
                  and not exists (select 1 from conversation_entry ce
                                   where ce.conversation_id = e.conversation_id and ce.source_id = e.inbound_id and ce.kind = 'input')))
         and e.runner = ${execution.runner} and e.incarnation = ${execution.incarnation}
         and c.id = e.conversation_id and c.placement_generation = e.placement_generation
         and r.runner = e.runner and r.incarnation = e.incarnation
         and (e.inbound_id is null or exists (select 1 from inbound i
               where i.id = e.inbound_id and i.claimed_by = e.runner and i.state not in ('answered', 'delivered')))
      returning e.id`;
    if (moved.length === 0) throw new ExecutionNotOwned(execution.id);
    if (execution.inbound_id !== null && stage === "input") {
      await recordEntry(inside, { conversation: execution.conversation_id, source: execution.inbound_id, kind: "input", body: text, execution: execution.id });
    }
    await noteExecution(inside, execution.id, "feed.intent", { inbound: execution.inbound_id, digest: execution.input_digest, purpose: stage === "tail" ? "tail" : execution.purpose });
  });
}

/** received or running, and only forwards. Zero rows is not an error: a later state already covers it. */
export async function markProgress(store: StoreLike, execution: string, state: "received" | "running"): Promise<void> {
  await store.sql`update execution set state = ${state}
    where id = ${execution}
      and (state = 'feed_intent' or (${state} = 'running' and state = 'received'))`;
}

/**
 * What the process tree looked like the last time anyone looked, and which boot
 * of which machine that was: the only evidence there is after a crash. Recorded as
 * a value (never a string), and merged over what is already known.
 *
 * THE PROCESSES ARE THE UNION OF EVERYTHING EVER OBSERVED, never the latest list: a
 * tool that was seen and later left the tree (detached, or reparented out of sight)
 * is still a process this attempt started, and losing its number would let a crash
 * be judged without it. A group, a leader or a partial-observation mark that was
 * once recorded is not erased by a look that did not have one.
 */
export async function notePids(
  store: StoreLike,
  execution: string,
  seen: { leader: number | null; pids: number[]; group: number | null; machine: string | null; bootId: string | null; partial?: boolean },
): Promise<void> {
  const record = {
    ...(seen.leader !== null ? { leader: seen.leader } : {}),
    ...(seen.group !== null ? { group: seen.group } : {}),
    ...(seen.partial === true ? { partial: true } : {}),
    machine: seen.machine, boot_id: seen.bootId, seen_at: new Date().toISOString(),
  };
  await store.sql`update execution set evidence = evidence || ${record}::jsonb
      || jsonb_build_object('pids', (
           select coalesce(jsonb_agg(distinct p.v order by p.v), '[]'::jsonb) from (
             select v from jsonb_array_elements(case when jsonb_typeof(evidence -> 'pids') = 'array' then evidence -> 'pids' else '[]'::jsonb end) v
             union
             select v from jsonb_array_elements((${{ pids: seen.pids }}::jsonb) -> 'pids') v) p))
    where id = ${execution} and state in ('claimed', 'feed_intent', 'received', 'running')`;
}

/**
 * The turn's final result, kept BEFORE the settle. A settle is one transaction
 * and a crash inside it leaves nothing, so what survives is this: on the next
 * start, or on the next look, the reply is settled from it and the input is not
 * fed again.
 */
export async function journalResult(store: StoreLike, execution: string, result: Record<string, unknown>): Promise<void> {
  await store.sql`update execution set result = ${result}::jsonb where id = ${execution} and result is null`;
}

/** Append to a conversation. The same source and kind land once, so a replayed write is a no-op. */
export async function recordEntry(
  store: StoreLike,
  entry: { conversation: string; source: string; kind: "input" | "reply" | "recovery"; body: string; execution?: string; partial?: boolean },
): Promise<boolean> {
  const landed = await store.sql`insert into conversation_entry (conversation_id, seq, source_id, kind, body, partial, execution_id)
    values (${entry.conversation},
            coalesce((select max(seq) from conversation_entry where conversation_id = ${entry.conversation}), 0) + 1,
            ${entry.source}, ${entry.kind}, ${entry.body}, ${entry.partial ?? false}, ${entry.execution ?? null})
    on conflict (conversation_id, source_id, kind) do nothing returning seq`;
  return landed.length > 0;
}

/** Whether the conversation already carries this entry, without adding it. */
export async function hasEntry(store: StoreLike, conversation: string, source: string, kind: "input" | "reply" | "recovery"): Promise<boolean> {
  const found = await store.sql`select 1 from conversation_entry where conversation_id = ${conversation} and source_id = ${source} and kind = ${kind}`;
  return found.length > 0;
}

/**
 * How an attempt is allowed to settle.
 *   `incarnation`  the NORMAL settle: only the incarnation that is current, on the
 *                  placement the attempt started on. An obsolete one cannot settle
 *                  as current.
 *   `recovery`     the DELIBERATE authority to settle a result the attempt itself
 *                  journaled before it was cut off. It needs that stored result and
 *                  this runner, and asks nothing about the placement or the
 *                  incarnation: the result exists, and the only alternative to
 *                  settling it is losing it. It never starts a model.
 */
export type SettleFence = { incarnation: string } | { recovery: true };

/**
 * Settle the attempt inside the settling transaction, under the fence it names.
 */
export async function completeExecution(store: StoreLike, done: { execution: string; runner: string; reply: string | null; fence: SettleFence }): Promise<void> {
  const rows = "incarnation" in done.fence
    ? await store.sql`update execution e set state = 'completed', ended_at = now()
        from conversation c, runner_incarnation r
       where e.id = ${done.execution} and e.runner = ${done.runner} and e.incarnation = ${done.fence.incarnation}
         and c.id = e.conversation_id and c.placement_generation = e.placement_generation
         and r.runner = e.runner and r.incarnation = e.incarnation
         -- A result exists, so whatever else was unresolved about the attempt is not any more.
         and e.state in ('feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
      returning e.conversation_id, e.inbound_id`
    : await store.sql`update execution e set state = 'completed', ended_at = now()
       where e.id = ${done.execution} and e.runner = ${done.runner} and e.result is not null
         and e.state in ('feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
      returning e.conversation_id, e.inbound_id`;
  const [moved] = rows as unknown as { conversation_id: string; inbound_id: string }[];
  if (!moved) throw new ExecutionNotOwned(done.execution, "incarnation" in done.fence ? "incarnation" : "stored-result");
  // An attempt that finished has nothing left held on its input.
  await store.sql`update replay_hold set state = 'released', updated_at = now()
    where execution_id = ${done.execution} and state <> 'released'`;
  if (done.reply !== null) {
    await recordEntry(store, { conversation: moved.conversation_id, source: moved.inbound_id, kind: "reply", body: done.reply, execution: done.execution });
  }
}

/** A tail turn ended: the attempt is over, under the same fence as any settle. */
export async function completeTail(store: StoreLike, execution: ExecutionRow): Promise<void> {
  const moved = await store.sql`update execution e set state = 'completed', ended_at = now()
      from conversation c, runner_incarnation r
     where e.id = ${execution.id} and e.purpose = 'tail' and e.runner = ${execution.runner} and e.incarnation = ${execution.incarnation}
       and c.id = e.conversation_id and c.placement_generation = e.placement_generation
       and r.runner = e.runner and r.incarnation = e.incarnation
       and e.state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
    returning e.id`;
  if (moved.length === 0) throw new ExecutionNotOwned(execution.id, "incarnation");
}

export async function readExecution(store: StoreLike, id: string): Promise<ExecutionRow | null> {
  const [found] = (await store.sql`select * from execution where id = ${id}`) as unknown as ExecutionRow[];
  return found ?? null;
}

/** Every attempt of this runner that is not settled and is not this incarnation's own. */
export async function unresolvedOf(store: StoreLike, runner: string, incarnation: string): Promise<ExecutionRow[]> {
  return (await store.sql`select * from execution
    where runner = ${runner} and incarnation <> ${incarnation}
      and state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
    order by started_at, id`) as unknown as ExecutionRow[];
}

/** Attempts of this runner, of any incarnation, that journaled a result and were not settled. */
export async function journaledOf(store: StoreLike, runner: string): Promise<ExecutionRow[]> {
  return (await store.sql`select * from execution
    where runner = ${runner} and result is not null
      and state in ('feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
    order by started_at, id`) as unknown as ExecutionRow[];
}

/** The holds a conversation still has open, oldest first. */
export type OpenHold = HoldRow & {
  body: string;
  effects: Record<string, unknown>;
  evidence: Record<string, unknown>;
  native_session: string | null;
  continuation_id: string | null;
  native_context: unknown;
};

export async function openHoldsOf(store: StoreLike, conversation: string): Promise<OpenHold[]> {
  return (await store.sql`select h.inbound_id, h.execution_id, h.conversation_id, h.cause, h.state, h.revision, h.choice, h.chosen_by,
      h.continuation_id, h.native_context, i.body, e.effects, e.evidence, e.native_session
    from replay_hold h join inbound i on i.id = h.inbound_id join execution e on e.id = h.execution_id
    where h.conversation_id = ${conversation} and h.state <> 'released'
    order by h.created_at, h.inbound_id`) as unknown as OpenHold[];
}
