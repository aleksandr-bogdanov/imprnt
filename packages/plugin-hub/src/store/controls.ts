import type { StoreLike } from "./connect.ts";
import { UNRESOLVED } from "./conversations.ts";

/**
 * Claim gates and stop requests, as an operation (a council's stop, a topic's
 * archive) uses them. Every function takes a `StoreLike`, so a caller hands it its
 * own transaction and what has to commit together does: a tool call's invocation
 * and consumed sources, the gate it closes and the stop it asks for.
 *
 * NOTHING HERE DECIDES WHO MAY ASK. A caller checks that where it checks it (a
 * tool call's source evidence, the door's sender list) and passes the evidence it
 * used, which is only recorded. There is no default authorization, no exception
 * list and no model-facing entry point: the routines behind these are granted to
 * the runner, the door and the hub, and a model has no login to any of them.
 */

export type GateScope = { kind: "row" | "agent" | "conversation"; id: string };
export type GateState = "open" | "released";

/**
 * What an operation is made of: the conversation whose request started it, that
 * request's key, and, when the same request can start a further cycle (an
 * operation that is continued and stopped again), the number of the cycle.
 */
export interface OperationOrigin { conversation: string; request: string; epoch?: number }

/**
 * The id of an operation in the store's global keys (`claim_gate.operation_id`,
 * `stop_request.operation_id`), which stay global.
 *
 * DETERMINISTIC AND UNAMBIGUOUS. The same origin is the same id, so a replayed
 * request is the same operation; two different origins never share one, whatever
 * characters their parts contain, because every part is written with its length
 * (`op1:<len>:<conversation>:<len>:<request>[:e<epoch>]`). Two conversations that
 * both used the key "stop-1" are two operations, so releasing one leaves the
 * other's gates closed and each has its own stop requests. A key is only unique
 * inside a conversation and is not an operation id.
 *
 * REPEAT CYCLES ARE DISTINCT OPERATIONS. A released gate deliberately stays
 * released and a stop request stays frozen to the attempt it was made about, so a
 * second cycle that reused the first one's id would find its gates already released
 * and its stops answering for the old attempt. The epoch is part of the id, and a
 * cycle that starts from a different request has a different key anyway.
 *
 * A LATER REQUEST THAT ENDS THE OPERATION (a release, a continuation) has a key of
 * its own, so it must not derive an id from it: it takes the original origin from
 * the domain object that recorded it and calls this again with those parts.
 */
export function operationId(origin: OperationOrigin): string {
  if (origin.conversation === "" || origin.request === "") throw new Error("an operation is made from a conversation and a request key");
  if (origin.epoch !== undefined && (!Number.isSafeInteger(origin.epoch) || origin.epoch < 0)) throw new Error("an operation's epoch is a whole number");
  return `op1:${origin.conversation.length}:${origin.conversation}:${origin.request.length}:${origin.request}${origin.epoch === undefined ? "" : `:e${origin.epoch}`}`;
}

/** A request the store refused by name: an unknown scope or target, or a gate asked for again for another cause. */
export class ControlRefused extends Error {
  constructor(readonly refusal: "gate-scope-unknown" | "gate-conflict" | "stop-target-unknown", message: string) {
    super(message);
    this.name = "ControlRefused";
  }
}

function named(error: unknown): never {
  const match = /(gate-scope-unknown|gate-conflict|stop-target-unknown): ?([\s\S]*)$/.exec(String((error as Error)?.message ?? ""));
  if (match) throw new ControlRefused(match[1] as ControlRefused["refusal"], match[2].trim());
  throw error;
}

export interface ClaimGate {
  operation: string;
  scope: GateScope;
  cause: string;
  state: GateState;
  evidence: Record<string, unknown>;
  created_at: Date;
  released_at: Date | null;
}

/**
 * Close NEW claims for a row, an agent or a conversation, in the name of one
 * operation. The same operation, scope and cause is the same gate (a replayed
 * request makes no second one) and a gate the operation already released stays
 * released: asking again does not reopen it. Returns the state the gate stands in.
 *
 * It refuses a claim and does nothing else: an attempt that already runs goes on,
 * and no input is stamped answered. Another cause for the same operation and scope
 * is a `ControlRefused("gate-conflict")`.
 *
 * WHAT A COMMITTED GATE MEANS FOR A CONSUMER THAT WANTS THE AGENT QUIET (an archive,
 * a move). Placing the gate is ordered against the opening of attempts for the agent
 * it is about (one short lock, see `hub_gate_place`), and every opening, an input's
 * or a resident's priming tail, reads the gates after that lock. So once this
 * transaction has committed, an attempt either exists and is listed by
 * `attemptsOf(..., { ownedOnly: true })`, or its opening is refused and its claim is
 * handed back. The consumer keeps the gate for as long as it needs the quiet, looks at
 * EVERY owned attempt of the scope after the commit (a claimed one and a tail
 * included), and waits for each one's result or for proof that its process is gone.
 * A stop request that came back `moot` with `no_attempt` is the frozen answer to
 * that one request and is not this proof. Place several gates in one transaction in
 * ascending agent order, and place them before requesting the stops that go with
 * them: those are the lock orders the openings rely on. Nothing here waits for a
 * process while holding the lock.
 */
export async function placeGate(
  store: StoreLike,
  gate: { operation: string; scope: GateScope; cause: string; evidence?: Record<string, unknown> },
): Promise<GateState> {
  try {
    const [placed] = (await store.sql`select hub_gate_place(${gate.operation}, ${gate.scope.kind}, ${gate.scope.id}, ${gate.cause},
      ${gate.evidence ?? {}}::jsonb) as state`) as unknown as { state: GateState }[];
    return placed.state;
  } catch (error) { return named(error); }
}

/**
 * Open the claims one operation closed: all of its gates, or the one at `scope`.
 * Only that operation's gates move. Another operation's gate over the same scope
 * still holds it, and no replay hold is touched. The agents concerned are woken on
 * the channel a runner already waits on. Returns how many gates this call released.
 */
export async function releaseGates(store: StoreLike, release: { operation: string; scope?: GateScope }): Promise<number> {
  const [released] = (await store.sql`select hub_gate_release(${release.operation}, ${release.scope?.kind ?? null}, ${release.scope?.id ?? null}) as n`) as unknown as { n: number }[];
  return Number(released.n);
}

/** The gates on a scope, open and released, oldest first: what holds it and who asked. */
export async function gatesOn(store: StoreLike, scope: GateScope): Promise<ClaimGate[]> {
  const rows = (await store.sql`select operation_id, scope_kind, scope_id, cause, state, evidence, created_at, released_at
    from claim_gate where scope_kind = ${scope.kind} and scope_id = ${scope.id} order by created_at, operation_id`) as unknown as
    { operation_id: string; scope_kind: GateScope["kind"]; scope_id: string; cause: string; state: GateState; evidence: Record<string, unknown>; created_at: Date; released_at: Date | null }[];
  return rows.map(row => ({ operation: row.operation_id, scope: { kind: row.scope_kind, id: row.scope_id }, cause: row.cause, state: row.state,
    evidence: row.evidence, created_at: row.created_at, released_at: row.released_at }));
}

/** What a stop request is about: one attempt by id, or whichever attempt the conversation or the agent owns at the moment of asking. */
export type StopTarget = { execution: string } | { conversation: string } | { agent: string };

/**
 * requested  intent kept, nothing signalled
 * stopping   the attempt is `stop_requested`: asked to end, end not confirmed
 * stopped    the attempt is `stopped`: the loop and everything recorded under it are shown gone
 * unknown    the attempt is `stop_unknown`: not shown gone, so it stays blocked and its input held
 * settled    the attempt had finished with its own result: kept, nothing was stopped
 * moot       the attempt was over by other means, or nothing was owned (`outcome` says which)
 */
export type StopState = "requested" | "stopping" | "stopped" | "unknown" | "settled" | "moot";

export interface StopRequest {
  id: string;
  operation: string;
  target: StopTarget;
  by: string;
  /** The attempt this request is about, frozen when it was made; null only for `moot / no_attempt`. */
  execution: string | null;
  conversation: string | null;
  agent: string | null;
  runner: string | null;
  incarnation: string | null;
  /** The attempt's own placement generation, and the conversation's when the request was made. */
  placement_generation: number | null;
  conversation_generation: number | null;
  state: StopState;
  /** The attempt's own state that decided a terminal answer, or `no_attempt`. */
  outcome: string | null;
  evidence: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const STOP_COLUMNS = `id, operation_id, target_kind, target_id, requested_by, execution_id, conversation_id, agent, runner, incarnation,
  placement_generation, conversation_generation, state, outcome, evidence, created_at, updated_at`;

interface StopRow {
  id: string; operation_id: string; target_kind: "execution" | "conversation" | "agent"; target_id: string; requested_by: string;
  execution_id: string | null; conversation_id: string | null; agent: string | null; runner: string | null; incarnation: string | null;
  placement_generation: number | null; conversation_generation: number | null; state: StopState; outcome: string | null;
  evidence: Record<string, unknown>; created_at: Date; updated_at: Date;
}

export function stopRequestOf(row: StopRow): StopRequest {
  return {
    id: row.id, operation: row.operation_id, target: { [row.target_kind]: row.target_id } as unknown as StopTarget, by: row.requested_by,
    execution: row.execution_id, conversation: row.conversation_id, agent: row.agent, runner: row.runner, incarnation: row.incarnation,
    placement_generation: row.placement_generation, conversation_generation: row.conversation_generation,
    state: row.state, outcome: row.outcome, evidence: row.evidence, created_at: row.created_at, updated_at: row.updated_at,
  };
}

/**
 * Keep the intent to stop one attempt, BEFORE anything is signalled, and freeze
 * which attempt it is. The owning runner is woken at the commit, stops the attempt
 * with its own `stopExecution` outside any transaction, and the request then says
 * only what the attempt says (see `describeStop`). This call returns at once with
 * the request as it stands; it never waits for a process.
 *
 * `operation` is the caller's own idempotency: the same operation and target is one
 * request, whatever happened to the attempt since, and a repeat never resolves to a
 * newer attempt. Two targets for one operation are two requests. A target that owns
 * no attempt now is a request that is `moot` for good.
 */
export async function requestStop(
  store: StoreLike,
  request: { operation: string; target: StopTarget; by: string; evidence?: Record<string, unknown> },
): Promise<StopRequest> {
  const [kind, id] = "execution" in request.target ? ["execution", request.target.execution]
    : "conversation" in request.target ? ["conversation", request.target.conversation] : ["agent", request.target.agent];
  try {
    const [made] = (await store.sql`select hub_stop_request(${crypto.randomUUID()}, ${request.operation}, ${kind}, ${id}, ${request.by},
      ${request.evidence ?? {}}::jsonb) as id`) as unknown as { id: string }[];
    const [row] = (await store.sql.unsafe(`select ${STOP_COLUMNS} from stop_request where id = $1`, [made.id])) as unknown as StopRow[];
    return stopRequestOf(row);
  } catch (error) { return named(error); }
}

/** The stop requests of one operation, oldest first. */
export async function stopsOf(store: StoreLike, operation: string): Promise<StopRequest[]> {
  const rows = (await store.sql.unsafe(`select ${STOP_COLUMNS} from stop_request where operation_id = $1 order by created_at, id`, [operation])) as unknown as StopRow[];
  return rows.map(stopRequestOf);
}

/**
 * What a stop request may be reported as, in the words of the one reply shape. It
 * never says "stopped" of anything the attempt was not recorded as: silence, time
 * and an owner's approval are not evidence, and a process not shown gone is
 * `unknown` and stays blocked.
 */
export function describeStop(request: Pick<StopRequest, "state" | "outcome">): { status: "queued" | "stopping" | "stopped" | "unknown" | "complete"; stage: string; message: string } {
  switch (request.state) {
    case "requested":
      return { status: "queued", stage: "stop_requested", message: "The stop is recorded and nothing has been signalled yet. Its runner will act on it." };
    case "stopping":
      return { status: "stopping", stage: "stopping", message: "The process was asked to end. It is not shown to be gone yet, so it is not called stopped." };
    case "stopped":
      return { status: "stopped", stage: "stopped", message: "Stopped: the process and everything recorded under it are shown gone. Its input stays held; nothing was undone." };
    case "unknown":
      return { status: "unknown", stage: "stop_unknown", message: "Not proved: the process is not shown to be gone. Its agent stays blocked and its input stays held until that is shown." };
    case "settled":
      return { status: "complete", stage: "already_finished", message: "The attempt had already finished with its own result, which is kept. Nothing was stopped." };
    default:
      return { status: "complete", stage: request.outcome === "no_attempt" ? "nothing_running" : "already_over",
        message: request.outcome === "no_attempt" ? "Nothing was running to stop when this was asked."
          : `The attempt was already over (${request.outcome ?? "ended"}) before a stop was needed. Its input stays held if it was fed.` };
  }
}

export interface AttemptView {
  execution: string;
  inbound: string | null;
  conversation: string;
  agent: string;
  runner: string;
  incarnation: string;
  placement_generation: number;
  purpose: "turn" | "tail";
  state: string;
  /**
   * The attempt's state is one of those in which its process may be running or is
   * not shown to be gone. It is NOT "the process is alive": that is not something
   * the store knows, and nothing here says it.
   */
  owned: boolean;
  started_at: Date;
  ended_at: Date | null;
  /** The stop requests made against exactly this attempt, and what each says. */
  stops: { operation: string; state: StopState; outcome: string | null }[];
}

/**
 * The attempts of a conversation or an agent, newest first, with the stop requests
 * made about each. This is how a handler that has to name a target (or say what
 * became of one) reads the store: the runner's own bookkeeping is not consulted and
 * a model is given no way to.
 */
export async function attemptsOf(
  store: StoreLike,
  scope: { conversation: string } | { agent: string },
  options: { ownedOnly?: boolean } = {},
): Promise<AttemptView[]> {
  const owned: readonly string[] = UNRESOLVED;
  // The states are the store's own (`UNRESOLVED`), written out in the statement rather than bound as a list.
  const ownedOnly = options.ownedOnly ?? false;
  const columns = `e.id, e.inbound_id, e.conversation_id, e.agent, e.runner, e.incarnation, e.placement_generation, e.purpose, e.state, e.started_at, e.ended_at`;
  const [by, value] = "conversation" in scope ? ["e.conversation_id", scope.conversation] : ["e.agent", scope.agent];
  const rows = (await store.sql.unsafe(`select ${columns} from execution e where ${by} = $1
    and (not $2::boolean or e.state in (${owned.map(state => `'${state}'`).join(", ")})) order by e.started_at desc, e.id`, [value, ownedOnly])) as unknown as
    { id: string; inbound_id: string | null; conversation_id: string; agent: string; runner: string; incarnation: string;
      placement_generation: number; purpose: "turn" | "tail"; state: string; started_at: Date; ended_at: Date | null }[];
  const stops = rows.length === 0 ? [] : (await store.sql`select execution_id, operation_id, state, outcome from stop_request
    where execution_id in (select jsonb_array_elements_text(${JSON.stringify(rows.map(row => row.id))}::text::jsonb)) order by created_at, id`) as unknown as
    { execution_id: string; operation_id: string; state: StopState; outcome: string | null }[];
  return rows.map(row => ({
    execution: row.id, inbound: row.inbound_id, conversation: row.conversation_id, agent: row.agent, runner: row.runner, incarnation: row.incarnation,
    placement_generation: row.placement_generation, purpose: row.purpose, state: row.state, owned: owned.includes(row.state),
    started_at: row.started_at, ended_at: row.ended_at,
    stops: stops.filter(one => one.execution_id === row.id).map(one => ({ operation: one.operation_id, state: one.state, outcome: one.outcome })),
  }));
}
