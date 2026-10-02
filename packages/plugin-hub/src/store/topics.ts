import { createHash, randomUUID } from "node:crypto";
import type { StoreLike } from "./connect.ts";

/**
 * Topics, as the tool, the door and the hub read and write them. Every function takes a
 * `StoreLike`, so a caller hands it its own transaction and what has to commit together does:
 * the preview and the identities it was made for, the approval and the topic it confirms, the
 * channel that was found and the first input it carries.
 *
 * NOTHING HERE DECIDES WHO MAY ASK, AND NOTHING HERE TALKS TO A PLATFORM OR A FILE. The routines
 * behind these are the store's own (`015-topics.sql`) and hold the rules a second writer would
 * meet; what these add is a typed way to call them and to read what became of it.
 */

export type CreateState =
  | "previewed" | "confirmed" | "create_intent" | "creation_unknown" | "channel_known"
  | "bind_intent" | "bound" | "failed" | "legacy";

export type Lifecycle = "pending" | "active" | "archiving" | "archived" | "reopening" | "channel_missing" | "deleting";

/** What was frozen with the preview and approved: the exact setup, with the identities it will have. */
export interface TopicSetup {
  topic_id: string;
  agent_id: string;
  conversation_id: string;
  person: string;
  door: string;
  chat_name: string;
  machine: string;
  machine_from: "request" | "door" | "person";
  runner: string;
  preset: string;
  preset_from: "request" | "door" | "person";
  adapter: string;
  model: string;
  /** Only for a preset on a model key: whose model it is, frozen with the rest so that a preset changing provider is a changed setup. */
  provider?: string;
  /** The request or handover, verbatim, and the text of the first input the new agent is given. */
  initial_request: string;
  tool_profile?: string[];
  /** Where it was asked for, which is where it is said to have been done. */
  origin: { door: string; chat: string; agent: string };
  requested_by: string;
}

export interface TopicRow {
  id: string;
  person: string;
  display_name: string;
  agent_id: string;
  conversation_id: string;
  origin: "created" | "legacy";
  operation_id: string | null;
  door: string;
  chat: string | null;
  machine: string;
  runner: string;
  preset: string;
  setup: Partial<TopicSetup>;
  marker: string;
  initial_input_id: string | null;
  create_state: CreateState;
  create_attempt: string | null;
  create_attempts: number;
  create_intent_at: Date | null;
  create_retry_at: Date | null;
  reconcile_attempts: number;
  create_evidence: Record<string, unknown>;
  create_failure: Record<string, unknown> | null;
  confirmation_id: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  lifecycle: Lifecycle;
  lifecycle_generation: number;
  archive_operation: string | null;
  delete_operation: string | null;
  /** The revision of the owner's latest decision about an unsettled create; 0 before any. */
  decision_seq: number;
  /** When the channel became known, and never moved by a retry. Null before it is. */
  channel_known_at: Date | null;
  /** The lifecycle the chat was in when it was found gone, or null. */
  missing_from: "active" | "archiving" | "archived" | "reopening" | null;
  /** The disappearance that holds the topic now (`missing:<topic>:<generation>`): its gate, request and notice are named after it. Null unless the chat is gone. */
  missing_operation: string | null;
  /** The last number given to an attention gap: what tells one occurrence of a kind of gap from a later one. */
  attention_seq: number;
  updated_at: Date;
}

const COLUMNS = `id, person, display_name, agent_id, conversation_id, origin, operation_id, door, chat, machine, runner, preset,
  setup, marker, initial_input_id, create_state, create_attempt, create_attempts, create_intent_at, create_retry_at,
  reconcile_attempts, create_evidence, create_failure, confirmation_id, confirmed_by, confirmed_at, lifecycle,
  lifecycle_generation, archive_operation, delete_operation, decision_seq, channel_known_at, missing_from, missing_operation,
  attention_seq, updated_at`;

const dateOf = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string));

export function topicOf(raw: Record<string, unknown>): TopicRow {
  const row = raw as unknown as TopicRow;
  return {
    ...row,
    create_attempts: Number(row.create_attempts),
    reconcile_attempts: Number(row.reconcile_attempts),
    lifecycle_generation: Number(row.lifecycle_generation),
    decision_seq: Number(row.decision_seq),
    attention_seq: Number(row.attention_seq),
    create_intent_at: dateOf(row.create_intent_at),
    create_retry_at: dateOf(row.create_retry_at),
    confirmed_at: dateOf(row.confirmed_at),
    channel_known_at: dateOf(row.channel_known_at),
    updated_at: dateOf(row.updated_at)!,
  };
}

export async function readTopic(store: StoreLike, id: string): Promise<TopicRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from topic where id = $1`, [id]);
  return row ? topicOf(row) : null;
}

export async function readTopicByAgent(store: StoreLike, agent: string): Promise<TopicRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from topic where agent_id = $1`, [agent]);
  return row ? topicOf(row) : null;
}

export async function readTopicByOperation(store: StoreLike, operation: string): Promise<TopicRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from topic where operation_id = $1`, [operation]);
  return row ? topicOf(row) : null;
}

export async function readTopicByChat(store: StoreLike, door: string, chat: string): Promise<TopicRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from topic where door = $1 and chat = $2`, [door, chat]);
  return row ? topicOf(row) : null;
}

/** Every adopted master's topic, whichever door it is on: the door that finds the registry moved an agent onto it looks here. */
export async function legacyTopics(store: StoreLike): Promise<TopicRow[]> {
  const rows = await store.sql.unsafe(`select ${COLUMNS} from topic where origin = 'legacy' order by created_at, id`);
  return rows.map((row: Record<string, unknown>) => topicOf(row));
}

/** The topics of one door with a topic, agent or conversation identity that was retired: none of them is watched or moved. */
export async function retiredTopicsOfDoor(store: StoreLike, door: string): Promise<Set<string>> {
  const rows = (await store.sql`select t.id from topic t where t.door = ${door} and exists (
      select 1 from identity_reservation r
       where (r.kind = 'topic' and r.id = t.id) or (r.kind = 'agent' and r.id = t.agent_id) or (r.kind = 'conversation' and r.id = t.conversation_id))`) as unknown as { id: string }[];
  return new Set(rows.map(row => row.id));
}

/** The topics of one door, oldest first, optionally only those in some of these creation states or lifecycles. */
export async function topicsOfDoor(store: StoreLike, door: string,
  where: { create?: readonly CreateState[]; lifecycle?: readonly Lifecycle[] } = {}): Promise<TopicRow[]> {
  // The two lists are written into the statement, and only after each word is checked to be one of
  // the store's own: an array is not passed as a parameter, and a word that is not one is refused.
  const listed = (words: readonly string[] | undefined, allowed: readonly string[], column: string): string => {
    if (words === undefined) return "";
    for (const word of words) if (!allowed.includes(word)) throw new RangeError(`${word} is not a ${column}`);
    return words.length === 0 ? " and false" : ` and ${column} in (${words.map(word => `'${word}'`).join(", ")})`;
  };
  const rows = await store.sql.unsafe(`select ${COLUMNS} from topic where door = $1
    ${listed(where.create, CREATE_STATES, "create_state")}${listed(where.lifecycle, LIFECYCLES, "lifecycle")}
    order by created_at, id`, [door]);
  return rows.map((row: Record<string, unknown>) => topicOf(row));
}

const CREATE_STATES: readonly string[] = ["previewed", "confirmed", "create_intent", "creation_unknown", "channel_known", "bind_intent", "bound", "failed", "legacy"];
const LIFECYCLES: readonly string[] = ["pending", "active", "archiving", "archived", "reopening", "channel_missing", "deleting"];

// ---------------------------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------------------------

/** The three identities a topic has for good, and what the platform is asked to find it by. */
export interface TopicIdentity {
  topic_id: string;
  /** An agent id: it is a folder name (`isAgentId`), made from a UUID and never from the chat's name. */
  agent_id: string;
  conversation_id: string;
  native_session: string;
  /** Opaque, and derived from the topic id by a hash: it names nothing. */
  marker: string;
}

/** The marker a channel of this topic carries in its description. It says nothing of who or what. */
export function markerOf(topicId: string): string {
  return `hub-topic:${createHash("sha256").update(`hub-topic:${topicId}`).digest("hex").slice(0, 16)}`;
}

export function newIdentity(uuid: () => string = randomUUID): TopicIdentity {
  const topic = uuid();
  return { topic_id: topic, agent_id: `t-${uuid()}`, conversation_id: uuid(), native_session: uuid(), marker: markerOf(topic) };
}

/** An identity that was asked for and is reserved, said by what it was. */
export class IdentityReserved extends Error {
  constructor(readonly kind: "topic" | "agent" | "conversation" | "unknown", message: string) {
    super(message);
    this.name = "IdentityReserved";
  }
}

export async function identityReserved(store: StoreLike, kind: "topic" | "agent" | "conversation", id: string): Promise<boolean> {
  const [row] = await store.sql`select hub_identity_reserved(${kind}, ${id}) as reserved`;
  return row.reserved === true;
}

/**
 * Reserve an identity for good. Nothing in this step calls it outside a check: the step that
 * deletes a topic is the one that decides to, and it must do it BEFORE anything of the topic is
 * erased. It is here so that step has the routine, and so the fences that refuse a reserved
 * identity are exercised against a real reservation.
 */
export async function reserveIdentity(store: StoreLike, kind: "topic" | "agent" | "conversation", id: string,
  why: string, proof: Record<string, unknown> = {}): Promise<boolean> {
  const [row] = await store.sql`select hub_identity_reserve(${kind}, ${id}, ${why}, ${proof}::jsonb) as made`;
  return row.made === true;
}

/** The kind an error out of the store names, when it is a reserved identity. */
export function reservedKindOf(error: unknown): IdentityReserved["kind"] | null {
  const said = /identity-reserved: (topic|agent|conversation)?\s*/.exec(String((error as Error)?.message ?? ""));
  return said ? ((said[1] as IdentityReserved["kind"] | undefined) ?? "unknown") : null;
}

/**
 * Give a new topic its identities and record it as previewed, or return the topic this operation
 * already made. The identities are chosen here, checked against the reservations BEFORE the store
 * is asked, and the store checks them again under its own lock, so a reservation made in between
 * is refused too. A reserved one is replaced by a fresh one; it is never used, and never adopted.
 */
export async function allocateTopic(store: StoreLike, input: {
  operation: string; person: string; door: string; display_name: string; machine: string; runner: string;
  preset: string; adapter: string; setup: (identity: TopicIdentity) => TopicSetup;
}, options: { identity?: () => TopicIdentity; tries?: number } = {}): Promise<TopicRow> {
  const standing = await readTopicByOperation(store, input.operation);
  if (standing) return standing;
  const make = options.identity ?? (() => newIdentity());
  for (let tried = 0; tried < (options.tries ?? 5); tried += 1) {
    const identity = make();
    const reserved = (await identityReserved(store, "topic", identity.topic_id))
      || (await identityReserved(store, "agent", identity.agent_id))
      || (await identityReserved(store, "conversation", identity.conversation_id));
    if (reserved) continue;
    const setup = input.setup(identity);
    let made: string;
    try {
      // THE ANSWER IS THE STORE'S. Under a concurrent request for the same operation this call may lose: the
      // routine then returns the topic that won, not the identity this call generated, and nothing of this
      // call's identity (no topic, no conversation) exists. The id it returns is the topic to read.
      const [row] = await store.sql`select hub_topic_allocate(${identity.topic_id}, ${input.person}, ${input.display_name}, ${identity.agent_id},
        ${identity.conversation_id}, ${input.operation}, ${input.door}, ${input.machine}, ${input.runner}, ${input.preset},
        ${input.adapter}, ${identity.native_session}, ${identity.marker}, ${setup}::jsonb) as id`;
      made = String(row.id);
    } catch (error) {
      const kind = reservedKindOf(error);
      if (kind !== null) throw new IdentityReserved(kind, String((error as Error).message));
      throw error;
    }
    return (await readTopic(store, made))!;
  }
  throw new IdentityReserved("unknown", "every identity that was tried is reserved");
}

/** Change what a preview that nobody approved is for, never who the topic is. */
export async function reviseTopic(store: StoreLike, input: {
  operation: string; display_name: string; machine: string; runner: string; preset: string; adapter: string; setup: TopicSetup;
}): Promise<void> {
  await store.sql`select hub_topic_revise(${input.operation}, ${input.display_name}, ${input.machine}, ${input.runner},
    ${input.preset}, ${input.adapter}, ${input.setup}::jsonb)`;
}

/** The approval, as this topic's own. Called by the approval hook, in the approval's transaction. */
export async function confirmTopic(store: StoreLike, confirmationId: string): Promise<string> {
  const [row] = await store.sql`select hub_topic_confirm(${confirmationId}) as state`;
  return String(row.state);
}

// ---------------------------------------------------------------------------------------------
// The creation, step by step
// ---------------------------------------------------------------------------------------------

/** Ask to make the channel: committed BEFORE the platform is asked. `intent` means this call owns the attempt. */
export async function createIntent(store: StoreLike, topic: string, attempt: string): Promise<string> {
  const [row] = await store.sql`select hub_topic_create_intent(${topic}, ${attempt}) as state`;
  return String(row.state);
}

export async function createUnsent(store: StoreLike, topic: string, attempt: string, retryAt: Date, proof: Record<string, unknown>): Promise<string> {
  const [row] = await store.sql`select hub_topic_create_unsent(${topic}, ${attempt}, ${retryAt.toISOString()}::timestamptz, ${proof}::jsonb) as state`;
  return String(row.state);
}

export async function createLook(store: StoreLike, topic: string, attempt: string, proof: Record<string, unknown>,
  retryAt: Date | null, unknown: boolean): Promise<string> {
  const [row] = await store.sql`select hub_topic_create_look(${topic}, ${attempt}, ${proof}::jsonb,
    ${retryAt === null ? null : retryAt.toISOString()}::timestamptz, ${unknown}) as state`;
  return String(row.state);
}

export async function createFailed(store: StoreLike, topic: string, attempt: string, proof: Record<string, unknown>): Promise<string> {
  const [row] = await store.sql`select hub_topic_create_failed(${topic}, ${attempt}, ${proof}::jsonb) as state`;
  return String(row.state);
}

/** The channel is known. Call it inside the transaction that stores the first input (`door/topic-task.ts`). */
export async function channelKnown(store: StoreLike, topic: string, chat: string, proof: Record<string, unknown>): Promise<string> {
  const [row] = await store.sql`select hub_topic_channel_known(${topic}, ${chat}, ${proof}::jsonb) as state`;
  return String(row.state);
}

/** An explicit decision about a create nobody could settle, or one the platform refused. */
export async function decideCreation(store: StoreLike, topic: string, choice: "adopt" | "recreate", by: string,
  options: { chat?: string; proof?: Record<string, unknown> } = {}): Promise<string> {
  const [row] = await store.sql`select hub_topic_create_decision(${topic}, ${choice}, ${options.chat ?? null}, ${by}, ${options.proof ?? {}}::jsonb) as state`;
  return String(row.state);
}

/**
 * The channel the owner named is the one: committed together with the first input, and only for the
 * decision it was read for (`seq`). `stale` means a newer decision moved on and nothing was changed.
 */
export async function adoptNamed(store: StoreLike, topic: string, chat: string, seq: number, proof: Record<string, unknown>): Promise<string> {
  const [row] = await store.sql`select hub_topic_adopt_named(${topic}, ${chat}, ${seq}::integer, ${proof}::jsonb) as state`;
  return String(row.state);
}

/** The channel the owner named cannot be used, and why, for the decision it was named in. */
export async function adoptRefused(store: StoreLike, topic: string, seq: number, code: string, cause: string): Promise<string> {
  const [row] = await store.sql`select hub_topic_adopt_refused(${topic}, ${seq}::integer, ${code}, ${cause}) as answer`;
  return String(row.answer);
}

export async function bindIntent(store: StoreLike, topic: string): Promise<string> {
  const [row] = await store.sql`select hub_topic_bind_intent(${topic}) as state`;
  return String(row.state);
}

export async function bound(store: StoreLike, topic: string, proof: Record<string, unknown>): Promise<string> {
  const [row] = await store.sql`select hub_topic_bound(${topic}, ${proof}::jsonb) as state`;
  return String(row.state);
}

export async function bindRefused(store: StoreLike, topic: string, proof: Record<string, unknown>): Promise<string> {
  const [row] = await store.sql`select hub_topic_bind_refused(${topic}, ${proof}::jsonb) as state`;
  return String(row.state);
}

/**
 * Said once where it was asked for and given its status line: true only for the call that did it.
 * `running` is the milestone "the first input was picked up", and is refused (false) for a chat
 * that is not active; `reason` is why a waiting line still waits.
 */
export async function announceTopic(store: StoreLike, topic: string, notice: OutboxNotice | null, status: "waiting" | "running",
  reason: string | null = null): Promise<boolean> {
  const [row] = await store.sql`select hub_topic_announce(${topic}, ${notice}::jsonb, ${status}, ${reason}) as made`;
  return row.made === true;
}

/** Moves the status line; false when the chat is not active (or was never announced), and then nothing may be published for it. */
export async function setTopicStatus(store: StoreLike, topic: string, status: "waiting" | "running", reason: string | null = null): Promise<boolean> {
  const [row] = await store.sql`select hub_topic_status(${topic}, ${status}, ${reason}) as moved`;
  return row.moved === true;
}

/**
 * What needed telling and could not be told: neither the chat it belongs to nor the General was somewhere a notice can be
 * delivered. Kept on the topic under the kind of notice, for `check` and `inspect`; a null cause clears it once one is routed.
 */
export async function noteAttention(store: StoreLike, topic: string, kind: string, cause: string | null): Promise<void> {
  await store.sql`select hub_topic_attention(${topic}, ${kind}, ${cause})`;
}

/** The attention the topic could not deliver, by the kind of notice: what `check` and `inspect` say. */
export function attentionGapsOf(topic: Pick<TopicRow, "create_evidence">): { kind: string; cause: string; at: string | null }[] {
  const map = topic.create_evidence.attention;
  if (map === null || typeof map !== "object") return [];
  return Object.entries(map as Record<string, { cause?: unknown; at?: unknown }>)
    .filter(([, one]) => one !== null && typeof one === "object" && typeof one.cause === "string")
    .map(([kind, one]) => ({ kind, cause: String(one.cause), at: typeof one.at === "string" ? one.at : null }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

/** One occurrence of "this could not be told": `seq` is what tells it from a later gap of the same kind. */
export interface AttentionDebt {
  kind: string;
  cause: string;
  at: string | null;
  seq: number;
}

/** What a topic still owes the person, with the number of each occurrence: what a catch-up names and clears. */
export function attentionDebtOf(topic: Pick<TopicRow, "create_evidence">): AttentionDebt[] {
  const map = topic.create_evidence.attention;
  if (map === null || typeof map !== "object") return [];
  return Object.entries(map as Record<string, { cause?: unknown; at?: unknown; seq?: unknown }>)
    .filter(([, one]) => one !== null && typeof one === "object" && typeof one.cause === "string" && Number.isInteger(one.seq))
    .map(([kind, one]) => ({ kind, cause: String(one.cause), at: typeof one.at === "string" ? one.at : null, seq: Number(one.seq) }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

export type CatchupAnswer = "queued" | "stale" | "nothing" | "unknown-topic";

/**
 * Tell once what could not be told, and clear exactly those gaps in the same transaction. The store locks the topic and reads
 * every gap again: one that is not standing as it was read (cleared, or opened again since under another number) makes the
 * whole answer `stale`, and nothing is queued or cleared. The key of the notice names the occurrences it stands for.
 */
export async function attentionCatchup(store: StoreLike, topic: string, represented: { kind: string; seq: number }[],
  notice: OutboxNotice | null): Promise<CatchupAnswer> {
  // A JSON array is passed as text and read as jsonb, as `store/controls.ts` does: a bare array would be a Postgres array.
  const [row] = await store.sql`select hub_topic_attention_catchup(${topic}, ${JSON.stringify(represented)}::text::jsonb, ${notice}::jsonb) as answer`;
  return row.answer as CatchupAnswer;
}

/** A notice that is queued in the same transaction as the fact it reports, once, under its key. */
export interface OutboxNotice {
  person: string;
  agent: string;
  body: string;
  key: string;
  route: { door: string; chat: string };
}

// ---------------------------------------------------------------------------------------------
// Adopted masters
// ---------------------------------------------------------------------------------------------

/** The topic of an agent that was adopted before topics existed, made once and keeping its conversation. */
export async function linkLegacyTopic(store: StoreLike, input: {
  person: string; agent: string; door: string; chat: string; machine: string; runner: string; preset: string;
  adapter: string; display_name: string;
}): Promise<TopicRow> {
  const identity = newIdentity();
  try {
    await store.sql`select hub_topic_link_legacy(${identity.topic_id}, ${input.person}, ${input.agent}, ${identity.conversation_id},
      ${input.door}, ${input.chat}, ${input.machine}, ${input.runner}, ${input.preset}, ${input.adapter}, ${identity.native_session},
      ${input.display_name}, ${identity.marker})`;
  } catch (error) {
    const kind = reservedKindOf(error);
    if (kind !== null) throw new IdentityReserved(kind, String((error as Error).message));
    throw error;
  }
  return (await readTopicByAgent(store, input.agent))!;
}

export type RebindAnswer = "not-a-topic" | "managed" | "not-active" | "missing-gated" | "rebound"
  | "person-mismatch" | "identity-reserved" | "chat-taken" | "unchanged";

/**
 * A legacy master was repaired onto another chat, or its registry entry was edited onto another chat or door, and its topic
 * follows: the same topic, agent, conversation and history. An active one takes the route; one whose chat vanished while it was
 * active takes it and comes back (only the gate of the disappearance that holds it is released); one that vanished mid-archive,
 * and one that is archiving, archived or reopening, is `missing-gated` / `not-active` and keeps everything it has. Answers why
 * not, when it does not. `door` moves the topic to the door the registry now says; `person` is whose agent the caller believes
 * it is (another person's is refused); `requireChange` is for a caller that infers the repair from the registry, so that an
 * agent that reappears on the route it vanished from repairs nothing (`unchanged`).
 */
export async function rebindLegacyTopic(store: StoreLike, agent: string, chat: string,
  options: { door?: string; person?: string; requireChange?: boolean } = {}): Promise<RebindAnswer> {
  const [row] = await store.sql`select hub_topic_rebind(${agent}, ${chat}, ${options.door ?? null}::text, ${options.person ?? null}::text,
    ${options.requireChange === true}::boolean) as answer`;
  return row.answer as RebindAnswer;
}

// ---------------------------------------------------------------------------------------------
// Archive, reopen, and a chat that is gone
// ---------------------------------------------------------------------------------------------

export type TransitionKind = "archive" | "reopen";
export type TransitionRefusal = "unknown-topic" | "not-active" | "not-archived" | "already-archived" | "in-progress" | "missing" | "stale";
export type TransitionAnswer = "ok" | "replay" | TransitionRefusal;

/**
 * The chat and the lifecycle generation a caller looked at when it decided to write something about a topic. The store
 * writes it only while the topic still stands exactly there (`stale` / `false` otherwise): a look at a chat the topic has
 * been moved off cannot act on the chat it has now.
 */
export interface RouteFence {
  chat: string | null;
  generation: number;
}

/** The fence of a topic as it was read. */
export const fenceOf = (topic: Pick<TopicRow, "chat" | "lifecycle_generation">): RouteFence => ({ chat: topic.chat, generation: topic.lifecycle_generation });

/**
 * Ask for one archive or reopen. An archive gates the master and asks for a stop of what it owns
 * NOW, in this transaction, and it is `archiving` until both the channel and the stop are
 * confirmed. The answer is a word for the caller to report. A request made because of what a channel showed carries
 * the `fence` of the topic it was made about.
 */
export async function requestTransition(store: StoreLike, request: {
  operation: string; topic: string; kind: TransitionKind; source: "tool" | "discord"; by: string;
  route: { door: string; chat: string } | null; evidence: Record<string, unknown>; stopId?: string; fence?: RouteFence;
}): Promise<TransitionAnswer> {
  const [row] = await store.sql`select hub_topic_transition_request(${request.operation}, ${request.topic}, ${request.kind},
    ${request.source}, ${request.by}, ${request.stopId ?? randomUUID()}, ${request.route}::jsonb, ${request.evidence}::jsonb,
    ${request.fence?.chat ?? null}::text, ${request.fence?.generation ?? null}::integer) as answer`;
  return row.answer as TransitionAnswer;
}

export interface TransitionRow {
  id: string;
  topic_id: string;
  kind: "archive" | "reopen" | "deletion_request";
  seq: number;
  source: "tool" | "discord" | "door";
  requested_by: string;
  route: { door: string; chat: string } | null;
  evidence: Record<string, unknown>;
  state: "open" | "complete" | "failed";
  stage: string;
  channel_state: "none" | "intent" | "applied" | "conflict" | "failed" | "unknown";
  channel_plan: Record<string, unknown> | null;
  channel_result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const TRANSITION_COLUMNS = `id, topic_id, kind, seq, source, requested_by, route, evidence, state, stage, channel_state,
  channel_plan, channel_result, created_at, updated_at`;

export function transitionOf(raw: Record<string, unknown>): TransitionRow {
  const row = raw as unknown as TransitionRow;
  return { ...row, seq: Number(row.seq), created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) };
}

export async function readTransition(store: StoreLike, id: string): Promise<TransitionRow | null> {
  const [row] = await store.sql.unsafe(`select ${TRANSITION_COLUMNS} from topic_transition where id = $1`, [id]);
  return row ? transitionOf(row) : null;
}

/** The open archives and reopens of this door's topics, oldest first. */
export async function openTransitionsOfDoor(store: StoreLike, door: string): Promise<{ topic: TopicRow; transition: TransitionRow }[]> {
  const rows = await store.sql.unsafe(`select t.id as topic_key, ${TRANSITION_COLUMNS.split(",").map(one => `x.${one.trim()}`).join(", ")}
      from topic_transition x join topic t on t.id = x.topic_id
     where t.door = $1 and x.state = 'open' and x.kind in ('archive', 'reopen') order by x.created_at, x.id`, [door]);
  const out: { topic: TopicRow; transition: TransitionRow }[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const topic = await readTopic(store, String(row.topic_key));
    if (topic) out.push({ topic, transition: transitionOf(row) });
  }
  return out;
}

/** The transitions of a topic that finished, newest first: what a reopen reads to know what was changed. */
export async function completedTransitions(store: StoreLike, topic: string, kind: TransitionKind): Promise<TransitionRow[]> {
  const rows = await store.sql.unsafe(`select ${TRANSITION_COLUMNS} from topic_transition
    where topic_id = $1 and kind = $2 and state = 'complete' order by seq desc`, [topic, kind]);
  return rows.map((row: Record<string, unknown>) => transitionOf(row));
}

/**
 * The newest completed reopen of a topic, and whether it completed AFTER the chat was last sampled: the two timestamps are
 * compared by the store at the precision it keeps them (microseconds), and never through a JavaScript `Date`, which keeps
 * milliseconds and would call a sample taken just before the completion, in the same millisecond, no older than it. `newer`
 * is true only for a reopen that completed strictly after the sample; a sample taken at or after the completion, or none, is
 * not older than it.
 */
export async function newestReopenSinceSample(store: StoreLike, topic: string): Promise<{ transition: TransitionRow; newer: boolean } | null> {
  const rows = await store.sql.unsafe(`select ${TRANSITION_COLUMNS.split(",").map(one => `x.${one.trim()}`).join(", ")},
      (s.seen_at is not null and x.updated_at > s.seen_at) as newer
    from topic_transition x left join topic_channel_seen s on s.topic_id = x.topic_id
   where x.topic_id = $1 and x.kind = 'reopen' and x.state = 'complete' order by x.seq desc limit 1`, [topic]) as Record<string, unknown>[];
  const row = rows[0];
  if (row === undefined) return null;
  const { newer, ...transition } = row;
  return { transition: transitionOf(transition), newer: newer === true };
}

export async function recordChannel(store: StoreLike, operation: string, state: TransitionRow["channel_state"],
  plan: Record<string, unknown> | null, result: Record<string, unknown> | null): Promise<string> {
  const [row] = await store.sql`select hub_topic_transition_channel(${operation}, ${state}, ${plan}::jsonb, ${result}::jsonb) as state`;
  return String(row.state);
}

export type CompletionAnswer = "complete" | "channel-pending" | "stop-pending" | "unknown-operation" | "failed" | "not-completable";

export async function completeTransition(store: StoreLike, operation: string, proof: Record<string, unknown>,
  notice: OutboxNotice | null): Promise<CompletionAnswer> {
  const [row] = await store.sql`select hub_topic_transition_complete(${operation}, ${proof}::jsonb, ${notice}::jsonb) as answer`;
  return row.answer as CompletionAnswer;
}

export interface ChannelSeen {
  topic_id: string;
  present: boolean | null;
  parent_id: string | null;
  name: string | null;
  seen_at: Date | null;
  checked_at: Date | null;
  last_error: Record<string, unknown> | null;
}

export async function readSeen(store: StoreLike, topic: string): Promise<ChannelSeen | null> {
  const [row] = await store.sql`select topic_id, present, parent_id, name, seen_at, checked_at, last_error from topic_channel_seen where topic_id = ${topic}`;
  if (!row) return null;
  return { ...(row as ChannelSeen), seen_at: dateOf(row.seen_at), checked_at: dateOf(row.checked_at) };
}

/**
 * What the platform showed of a chat. An error (`error` given) changes nothing about the chat, only when it was tried. A look
 * that carries the `fence` of the topic it was made about is written only while the topic still stands there; false says it was
 * not written.
 */
export async function observeChannel(store: StoreLike, topic: string, seen: { present: boolean; parent_id: string | null; name: string | null } | null,
  error: Record<string, unknown> | null, fence?: RouteFence): Promise<boolean> {
  const [row] = await store.sql`select hub_topic_observe(${topic}, ${seen?.present ?? null}, ${seen?.parent_id ?? null}, ${seen?.name ?? null}, ${error}::jsonb,
    ${fence?.chat ?? null}::text, ${fence?.generation ?? null}::integer) as written`;
  return row.written === true;
}

export type MissingAnswer = "ok" | "suppressed" | "already" | "not-bound" | "unknown-topic" | "stale";

/**
 * The chat is gone, established by the door. The vanished master is gated, the topic says so, one
 * request for the shared deletion flow is recorded (unless a deletion of the Hub's own is already
 * in flight for the topic), and NOTHING is erased. The gate, the request and the notice belong to THIS disappearance,
 * named by the store after the topic and the generation it begins at (`missingOperationOf`), so a chat that was repaired
 * and vanishes again is a new one; the key on `notice` is the store's to write. With the `fence` of what the caller
 * looked at, a topic that has been moved on since answers `stale` and nothing happens.
 */
export async function markChannelMissing(store: StoreLike, topic: string, proof: Record<string, unknown>,
  notice: (OutboxNotice) | null, fence?: RouteFence): Promise<MissingAnswer> {
  const [row] = await store.sql`select hub_topic_channel_missing(${topic}, ${proof}::jsonb, ${notice}::jsonb,
    ${fence?.chat ?? null}::text, ${fence?.generation ?? null}::integer) as answer`;
  return row.answer as MissingAnswer;
}

/** The names one disappearance carries, from the operation the topic holds while the chat is gone (`missing:<topic>:<generation>`). */
export function missingOperationOf(topic: Pick<TopicRow, "missing_operation">): { gate: string; request: string; notice: string } | null {
  if (topic.missing_operation === null) return null;
  const occurrence = topic.missing_operation.replace(/^missing:/, "");
  return { gate: topic.missing_operation, request: `deletion-request:${occurrence}`, notice: `topic:missing:${occurrence}` };
}

/** Whether a process has a session on the store right now, under the id it opened it with (a runner's or a door's own). */
export async function sessionLive(store: StoreLike, name: string): Promise<boolean> {
  const [row] = await store.sql`select exists (select 1 from pg_stat_activity
    where datname = current_database() and application_name = ${name}) as live`;
  return row.live === true;
}

/** Whether a runner has a session on the store right now: the same look the door's waiting line is made from. */
export const runnerLive = sessionLive;

/**
 * Whether the runner the topic was bound to has picked up the owner's first input: it claimed it, or an attempt of that
 * runner exists for it. This is the one evidence there is that the binding is usable there, for a runner serves an agent
 * only after it has the registry that names it, and a runner whose copy is stale claims nothing. A connection of that
 * runner to the store, which is all `runnerLive` sees, is not it; an input claimed by ANOTHER runner is not it either.
 */
export async function firstInputPickedUp(store: StoreLike, topic: Pick<TopicRow, "initial_input_id" | "runner">): Promise<boolean> {
  if (topic.initial_input_id === null) return false;
  const [row] = await store.sql`select (
      exists (select 1 from inbound where id = ${topic.initial_input_id} and claimed_by = ${topic.runner})
      or exists (select 1 from execution where inbound_id = ${topic.initial_input_id} and runner = ${topic.runner})
    ) as picked`;
  return row.picked === true;
}

/** Whether the chat can take a line said in it: not one that is archived, being reopened, gone or being deleted. */
export async function chatUsable(store: StoreLike, door: string, chat: string): Promise<boolean> {
  const [row] = await store.sql`select not exists (select 1 from topic where door = ${door} and chat = ${chat}
    and lifecycle in ('archiving', 'archived', 'reopening', 'channel_missing', 'deleting')) as usable`;
  return row.usable === true;
}
