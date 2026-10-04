import type { StoreLike } from "../store/connect.ts";

/**
 * Where each agent's open messages stand, as the people page shows them.
 *
 * AN OPEN ROW IS NOT A TURN THAT IS RUNNING. A message stays open from the
 * moment the door writes it until an answer is recorded, and in that time it
 * may be waiting for a runner, held for its owner's decision after an attempt
 * was cut short, or left behind by a runner that is gone. Counting every open
 * row as "answering" told a person an agent was working when nothing was. So
 * each row is placed by the store's own evidence, and the one state that says
 * work is happening needs all three facts the execution table keeps for that:
 * an attempt in a state that may be running, owned by the runner's current
 * incarnation, with that runner connected to the store right now.
 *
 *   answering  an attempt that may be running, its owner current and connected
 *   queued     nothing has it yet, or a connected runner claimed it and has not
 *              started, or it is waiting out a retry
 *   held       an open hold: the owner decides what happens to it
 *   stale      a claim or an attempt whose owner is gone or unknown, or a row
 *              that was started and that nothing holds
 *
 * A RELEASED HOLD IS NOT CURRENT ACTIVITY, by the owner's ruling. Once the
 * owner made the recovery choice that releases a hold (a fresh context, or a
 * continuation that took the work over), the original input is never fed
 * again by anything and nobody is waiting on it, yet it stays open in the
 * store because it was never answered. Read without its hold, it looks like an
 * attempt that stopped with nobody asked; so the statement reads the hold in
 * EVERY state, and a row whose hold is released is left out of the page
 * entirely rather than called answering, queued, held or unfinished.
 *
 * READ ONLY AND ONE STATEMENT for every agent on the page, so a household with
 * many agents does not pay one read per agent. No body, no prompt and no reply
 * is selected: what a page shows is names, counts, a reason and a time.
 */

export type TurnState = "answering" | "queued" | "held" | "stale";

/** The order states are said in on a card: work first, then what needs a person, then the queue. */
export const TURN_STATES: readonly TurnState[] = ["answering", "held", "stale", "queued"];

/** The closed reasons a row is placed for. Each is a sentence in `src/door/lines.ts`. */
export type TurnReason =
  | "answering"
  | "hold"
  | "continuing"
  | "owner-gone"
  | "orphaned"
  | "ownership-unknown"
  | "not-held"
  | "claimed"
  | "retry"
  | "unclaimed";

/** One open row, as the statement below returns it. Times are the store's. */
export interface TurnFacts {
  agent: string;
  id: string;
  state: string;
  /** `human` or `report`: a person's message, or a job's report a person is waiting on. */
  kind?: string;
  received_at: Date | string;
  claimed_by: string | null;
  claim_current: boolean;
  claimer_connected: boolean;
  retry_at: Date | string | null;
  retry_pending: boolean;
  hold_cause: string | null;
  hold_state: string | null;
  hold_at: Date | string | null;
  execution_state: string | null;
  execution_runner: string | null;
  execution_started_at: Date | string | null;
  owner_current: boolean;
  owner_connected: boolean;
}

export interface PlacedTurn {
  state: TurnState;
  reason: TurnReason;
  /** The runner the reason is about, when it is about one. */
  runner: string | null;
  /** The hold's own cause, for a held row. */
  cause: string | null;
  /** The time the reason is as of: when it arrived, was held, was started, or retries. */
  at: string;
  received_at: string;
  /** What the row is: a person's message or a job's report. */
  kind: string;
}

/** An attempt that may be running right now, in `execution`'s own words. */
const ACTIVE = ["claimed", "feed_intent", "received", "running", "stop_requested"];
/** An attempt nobody has shown is over. */
const UNRESOLVED = ["unknown", "stop_unknown"];
/** An attempt that may have handed the input to the engine and did not finish: never fed again by machinery. */
const REACHED = ["interrupted", "stopped"];

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const when = value instanceof Date ? value : new Date(value);
  return Number.isFinite(when.getTime()) ? when.toISOString() : String(value);
}

/** The hold state that ends a hold: the owner chose, and the original input is never fed again. */
export const RELEASED = "released";

/**
 * Where one row stands, or null for a row that is not current activity at all:
 * an original input whose hold the owner's recovery choice released. Pure:
 * every fact it reads is on the row.
 */
export function placeTurn(row: TurnFacts): PlacedTurn | null {
  const received = iso(row.received_at);
  const placed = (state: TurnState, reason: TurnReason, runner: string | null, at: string, cause: string | null = null): PlacedTurn =>
    ({ state, reason, runner, cause, at: at === "" ? received : at, received_at: received, kind: row.kind ?? "human" });

  if (row.hold_state === RELEASED) return null;
  if (row.hold_state !== null && row.hold_state !== undefined) {
    // Still the owner's: the original input stays held whatever was chosen so
    // far, and the why says when the choice was to continue it in a new turn.
    const continuing = row.hold_state === "continue_pending" || row.hold_state === "continuing";
    return placed("held", continuing ? "continuing" : "hold", null, iso(row.hold_at), row.hold_cause ?? null);
  }
  const attempt = row.execution_state ?? null;
  if (attempt !== null && ACTIVE.includes(attempt) && row.owner_current && row.owner_connected) {
    return placed("answering", "answering", row.execution_runner, iso(row.execution_started_at));
  }
  if (attempt !== null && UNRESOLVED.includes(attempt)) {
    return placed("stale", "ownership-unknown", row.execution_runner, iso(row.execution_started_at));
  }
  if (attempt !== null && ACTIVE.includes(attempt)) {
    // It may be running, but its owner is not the current incarnation or is
    // not connected, so nothing shows that anybody is still working on it.
    return placed("stale", "owner-gone", row.execution_runner, iso(row.execution_started_at));
  }
  if (attempt !== null && REACHED.includes(attempt)) {
    // Never fed again by machinery, and no hold says the owner was asked.
    return placed("stale", "not-held", row.execution_runner, iso(row.execution_started_at));
  }
  if (row.claimed_by !== null && row.claimed_by !== undefined) {
    return row.claimer_connected && row.claim_current
      ? placed("queued", "claimed", row.claimed_by, received)
      : placed("stale", "owner-gone", row.claimed_by, received);
  }
  if (row.state === "started") {
    // The engine was said to have begun, and no claim and no attempt holds it.
    return placed("stale", "orphaned", null, received);
  }
  if (row.retry_pending) return placed("queued", "retry", null, iso(row.retry_at));
  return placed("queued", "unclaimed", null, received);
}

/** One agent's open messages, counted per state, with the oldest row of each state. */
export interface TurnSummary {
  counts: Record<TurnState, number>;
  /** The oldest open row of each state that has any, in arrival order. */
  oldest: Partial<Record<TurnState, PlacedTurn>>;
  /** When the oldest open message of any state arrived, or null for none. */
  since: string | null;
}

export function emptySummary(): TurnSummary {
  return { counts: { answering: 0, queued: 0, held: 0, stale: 0 }, oldest: {}, since: null };
}

/** The page's view of every agent, from the rows the statement returned, in arrival order. */
export function summarizeTurns(rows: TurnFacts[]): Record<string, TurnSummary> {
  const out: Record<string, TurnSummary> = {};
  for (const row of rows) {
    const one = placeTurn(row);
    // A released original is left out whole: no count, no reason, no time.
    if (one === null) continue;
    const summary = (out[row.agent] ??= emptySummary());
    summary.counts[one.state] += 1;
    summary.oldest[one.state] ??= one;
    if (summary.since === null || one.received_at < summary.since) summary.since = one.received_at;
  }
  return out;
}

/**
 * The one statement: every open row a person waits on, for every agent named,
 * with the facts `placeTurn` needs beside it.
 *
 * The set is `readOpenTurns`'s own (rank 0 kinds, the three open stamps), so the
 * page and the door count the same rows, with one difference that is the point:
 * the door's read filters a released hold away and so cannot tell a released
 * original from an attempt nobody was asked about, and this one reads the hold
 * in every state, `released` included, so `placeTurn` can leave it out. The latest attempt for each row is the
 * one that says where it stands; an earlier one that failed is history. Whether
 * a runner is connected is the server's own client list, which is what the door's
 * waiting line reads too, and the clock every deadline is compared against is
 * the store's.
 */
export async function readTurnStates(store: StoreLike, agents: string[]): Promise<Record<string, TurnSummary>> {
  if (agents.length === 0) return {};
  const rows = (await store.sql`
    select i.agent, i.id, i.state, i.kind, i.received_at, i.claimed_by, i.retry_at,
           (i.claim_deadline is null or i.claim_deadline > now()) as claim_current,
           (i.retry_at is not null and i.retry_at > now()) as retry_pending,
           (i.claimed_by is not null and exists (select 1 from pg_stat_activity a
              where a.datname = current_database() and a.application_name = i.claimed_by)) as claimer_connected,
           h.cause as hold_cause, h.state as hold_state, h.updated_at as hold_at,
           e.state as execution_state, e.runner as execution_runner, e.started_at as execution_started_at,
           (e.incarnation is not null and e.incarnation = r.incarnation) as owner_current,
           (e.runner is not null and exists (select 1 from pg_stat_activity a
              where a.datname = current_database() and a.application_name = e.runner)) as owner_connected
    from inbound i
    left join replay_hold h on h.inbound_id = i.id
    left join lateral (select x.state, x.runner, x.incarnation, x.started_at from execution x
                        where x.inbound_id = i.id order by x.started_at desc, x.id desc limit 1) e on true
    left join runner_incarnation r on r.runner = e.runner
    where i.agent in (select jsonb_array_elements_text(${JSON.stringify(agents)}::text::jsonb))
      and i.kind in ('human', 'report')
      and i.state in ('received', 'acked', 'started')
    order by i.received_at, i.id`) as unknown as TurnFacts[];
  const out: Record<string, TurnSummary> = {};
  for (const agent of agents) out[agent] = emptySummary();
  return { ...out, ...summarizeTurns(rows) };
}
