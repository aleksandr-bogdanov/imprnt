import type { StoreLike } from "./connect.ts";
import type { OutboxNotice } from "./topics.ts";

/**
 * Topic deletion, as the tool, the door and the hub read and write it. Every function takes a `StoreLike`, so a caller hands it its
 * own transaction and what has to commit together does (the approval and the deletion it confirms).
 *
 * NOTHING HERE DECIDES WHO MAY ASK, AND NOTHING HERE TALKS TO A PLATFORM OR A FILE. The routines behind these are the store's own
 * (`017-topic-deletion.sql`): they hold the rules, keep the receipts and do the one removal of content. What these add is a typed
 * way to call them and to read what became of it. The removal is `eraseActive`; it answers `stop-pending` until the agent and its
 * delegated conversations are shown stopped, and `active_deleted` is only ever the store's word, from receipts it holds.
 */

export type DeletionStage =
  | "awaiting_confirmation" | "quiescing" | "deleting_active" | "verifying_active" | "active_deleted"
  | "pending_machine" | "blocked_scope" | "failed" | "superseded";

export type RetentionState = "not_configured" | "tracking" | "retention_unverified" | "retention_blocked" | "historical_copies_expired";

/** What was asked for and what the owner confirms: numbers and identifiers only, never a word of the history. */
export interface DeletionPreview {
  topic: string;
  agent: string;
  origin: "created" | "legacy";
  door: string;
  inventory: Record<string, number>;
  machines: string[];
  retention: { configured_days: number | null };
}

export interface DeletionRow {
  id: string;
  topic_id: string;
  person: string;
  agent_id: string;
  conversation_id: string;
  door: string;
  chat: string | null;
  requested_by: string;
  source: "tool" | "discord" | "door";
  route: { door: string; chat: string } | null;
  /** What the request kept besides who asked: the chat's LABEL (so the owner is told which chat), and no word of its history. */
  evidence: Record<string, unknown>;
  stage: DeletionStage;
  preview: DeletionPreview;
  blocked: { waiting: ReceiptSummary[]; refused: ReceiptSummary[] } | null;
  failure: Record<string, unknown> | null;
  confirmation_id: string | null;
  deletion_generation: number | null;
  erased: Record<string, number> | null;
  retention_days: number | null;
  retention_state: RetentionState;
  backup_retention_until: Date | null;
  retention_detail: Record<string, unknown>;
  active_deleted_at: Date | null;
}

export interface ReceiptSummary {
  class: ReceiptClass;
  location: string;
  machine: string;
  state: ReceiptState;
  detail?: Record<string, unknown>;
}

export type ReceiptClass =
  | "postgres_active" | "registry_binding" | "chatlog" | "inbox_media" | "engine_state" | "move_copy" | "harvest_stage"
  | "platform_chat" | "platform_message" | "backup_generation";

/**
 * The migration that carries the deletion objects. Code that reads or writes them asks `deletionSchemaReady` first, so that a hub, a
 * door or a backup started against a store that has not been migrated yet degrades to "nothing was ever deleted here" and never fails
 * on a missing routine; the one thing it must not do (serve while a machine's own manifest names a deletion the store has never
 * heard of) is `reconcileErasure`'s, and it holds in that case.
 */
export const DELETION_SCHEMA_VERSION = 17;

/** Whether this store has migration 017's objects. Asked of the catalog, so it needs no privilege on `schema_version`. */
export async function deletionSchemaReady(store: StoreLike): Promise<boolean> {
  const [row] = await store.sql`select to_regclass('public.topic_tombstone') is not null and to_regclass('public.erasure_control') is not null as ready`;
  return row.ready === true;
}

/** Migration 018 is required before serving or applying erasure: General notices belong to their source. */
export async function councilNoticeSchemaReady(store: StoreLike): Promise<boolean> {
  const [row] = await store.sql`select to_regprocedure('public.hub_erasure_owns_notice(text, text, text[])') is not null
    and to_regprocedure('public.hub_topic_attention_lock(text)') is not null
      and to_regprocedure('public.hub_council_notice_lock(text)') is not null as ready`;
  return row.ready === true;
}

const EMPTY_MANIFEST: ErasureManifest = { version: 1, generation: 0, tombstones: [] };

export type ReceiptState =
  | "pending" | "pending_machine" | "erased" | "unsupported" | "blocked" | "not_applicable"
  | "retention_unverified" | "retention_blocked" | "expired";

export interface ReceiptRow extends ReceiptSummary {
  deletion_id: string;
  historical: boolean;
  detail: Record<string, unknown>;
}

const COLUMNS = `id, topic_id, person, agent_id, conversation_id, door, chat, requested_by, source, route, evidence, stage, preview, blocked, failure,
  confirmation_id, deletion_generation, erased, retention_days, retention_state, backup_retention_until, retention_detail, active_deleted_at`;

const dateOf = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string));

export function deletionOf(raw: Record<string, unknown>): DeletionRow {
  const row = raw as unknown as DeletionRow;
  return {
    ...row,
    deletion_generation: row.deletion_generation === null ? null : Number(row.deletion_generation),
    retention_days: row.retention_days === null ? null : Number(row.retention_days),
    backup_retention_until: dateOf(row.backup_retention_until),
    active_deleted_at: dateOf(row.active_deleted_at),
  };
}

export async function readDeletion(store: StoreLike, id: string): Promise<DeletionRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from topic_deletion where id = $1`, [id]);
  return row ? deletionOf(row) : null;
}

/** The newest deletion that was not replaced, found by the topic's id or its agent's: what is still there to ask about after the topic's own row is gone. */
export async function deletionOfTopicOrAgent(store: StoreLike, named: string): Promise<DeletionRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from topic_deletion where (topic_id = $1 or agent_id = $1) and stage <> 'superseded'
    order by created_at desc, id desc limit 1`, [named]);
  return row ? deletionOf(row) : null;
}

/** The deletion of a topic that has not finished or been replaced: the one a new request has to wait for. */
export async function liveDeletionOfTopic(store: StoreLike, topic: string): Promise<DeletionRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from topic_deletion where topic_id = $1 and stage not in ('active_deleted', 'superseded')`, [topic]);
  return row ? deletionOf(row) : null;
}

/** The stages a door has work for: it erases, deletes the chat and the messages, judges and tells. */
const DOOR_STAGES = "('quiescing', 'deleting_active', 'verifying_active', 'pending_machine', 'blocked_scope', 'failed')";

/**
 * The deletions this door acts on, oldest first: the ones in flight, and the finished ones whose one notice has not been queued
 * (and that have somewhere to send it).
 */
export async function deletionsOfDoor(store: StoreLike, door: string): Promise<DeletionRow[]> {
  const rows = await store.sql.unsafe(`select ${COLUMNS} from topic_deletion d where d.door = $1 and (d.stage in ${DOOR_STAGES}
      or (d.stage = 'active_deleted' and not exists (select 1 from outbox o where o.notice_key = 'topic:deleted:' || d.id)))
    order by d.created_at, d.id`, [door]);
  return rows.map((row: Record<string, unknown>) => deletionOf(row));
}

/** Every confirmed deletion that has not finished, for the hub of any machine: it removes the registry entry and the local copies. */
export async function confirmedDeletions(store: StoreLike): Promise<DeletionRow[]> {
  const rows = await store.sql.unsafe(`select ${COLUMNS} from topic_deletion where stage in ${DOOR_STAGES} or stage = 'active_deleted' order by created_at, id`);
  return rows.map((row: Record<string, unknown>) => deletionOf(row));
}

export type RequestAnswer = "ok" | "replay" | "unknown-topic" | "deleted" | "in-progress" | "not-settled";

/**
 * Freeze what a deletion would remove and ask for nothing else. `machines` are the machines that may hold an active copy, and
 * `retentionDays` is what the owner configured, or null: both are part of what is confirmed. A new request replaces a preview nobody
 * approved, and takes over the open "this chat is gone" request of the topic.
 */
export async function requestDeletion(store: StoreLike, input: {
  operation: string; topic: string; by: string; source: "tool" | "discord" | "door";
  route: { door: string; chat: string } | null; retentionDays: number | null; machines: readonly string[];
  evidence: Record<string, unknown>;
}): Promise<RequestAnswer> {
  const [row] = await store.sql`select hub_deletion_request(${input.operation}, ${input.topic}, ${input.by}, ${input.source},
    ${input.route}::jsonb, ${input.retentionDays}::integer, ${JSON.stringify([...input.machines])}::text::jsonb, ${input.evidence}::jsonb) as answer`;
  return row.answer as RequestAnswer;
}

/** The approval, as this deletion's own. Called by the approval hook, in the approval's transaction. */
export async function confirmDeletion(store: StoreLike, confirmationId: string): Promise<string> {
  const [row] = await store.sql`select hub_deletion_confirm(${confirmationId}) as state`;
  return String(row.state);
}

export type EraseAnswer = "erased" | "replay" | "stop-pending" | "not-confirmed" | "unknown-deletion";

/**
 * Remove the active rows of a confirmed deletion, in one transaction, once nothing of the topic is shown still running.
 * `stop-pending` is not an error. A refusal by the store (rows it could not remove) is thrown and rolls the removal back whole.
 */
export async function eraseActive(store: StoreLike, deletion: string): Promise<EraseAnswer> {
  const [row] = await store.sql`select hub_deletion_erase_active(${deletion}) as answer`;
  return row.answer as EraseAnswer;
}

export type VerifyAnswer = "active_deleted" | "pending-machine" | "blocked-scope" | "rows-remain" | "replay" | "not-erased" | "unknown-deletion";

export async function verifyDeletion(store: StoreLike, deletion: string): Promise<VerifyAnswer> {
  const [row] = await store.sql`select hub_deletion_verify(${deletion}) as answer`;
  return row.answer as VerifyAnswer;
}

export type ReceiptAnswer = "recorded" | "replay" | "final" | "historical" | "not-confirmed" | "unknown-deletion" | "unknown-receipt";

/** One location's own account of what became of the copy it held. The store refuses to change a receipt that says erased. */
export async function recordReceipt(store: StoreLike, deletion: string, receipt: {
  class: ReceiptClass; location: string; machine?: string; state: Exclude<ReceiptState, "retention_unverified" | "retention_blocked" | "expired">;
  detail?: Record<string, unknown>; by: string;
}): Promise<ReceiptAnswer> {
  const [row] = await store.sql`select hub_deletion_receipt(${deletion}, ${receipt.class}, ${receipt.location}, ${receipt.machine ?? ""},
    ${receipt.state}, ${receipt.detail ?? {}}::jsonb, ${receipt.by}) as answer`;
  return row.answer as ReceiptAnswer;
}

const RECEIPT_CLASSES: readonly string[] = ["postgres_active", "registry_binding", "chatlog", "inbox_media", "engine_state", "move_copy",
  "harvest_stage", "platform_chat", "platform_message", "backup_generation"];

export async function receiptsOf(store: StoreLike, deletion: string,
  where: { machine?: string; classes?: readonly ReceiptClass[]; open?: boolean; historical?: boolean } = {}): Promise<ReceiptRow[]> {
  // A list is written into the statement, and only after each word is checked to be one of the store's own, as `topicsOfDoor` does.
  for (const one of where.classes ?? []) if (!RECEIPT_CLASSES.includes(one)) throw new RangeError(`${one} is not a class of receipt`);
  const params: unknown[] = [deletion];
  const clauses = ["deletion_id = $1"];
  if (where.machine !== undefined) { params.push(where.machine); clauses.push(`machine = $${params.length}`); }
  if (where.classes !== undefined) clauses.push(where.classes.length === 0 ? "false" : `class in (${where.classes.map(one => `'${one}'`).join(", ")})`);
  if (where.open === true) clauses.push("state in ('pending', 'pending_machine')");
  if (where.historical !== undefined) clauses.push(where.historical ? "historical" : "not historical");
  const rows = await store.sql.unsafe(`select deletion_id, class, location, machine, historical, state, detail from erasure_receipt
    where ${clauses.join(" and ")} order by class, machine, location`, params);
  return rows as unknown as ReceiptRow[];
}

/** One notice, queued once under its key. It goes where the caller says (General), and never to the chat that was deleted. */
export async function queueDeletionNotice(store: StoreLike, deletion: string, notice: OutboxNotice): Promise<boolean> {
  const [row] = await store.sql`select hub_deletion_notice(${deletion}, ${notice.key}, ${notice}::jsonb) as made`;
  return row.made === true;
}

export type RetentionAnswer = "recorded" | "unverified" | "not-confirmed" | "unknown-deletion";

/**
 * The account of the HISTORICAL copies. `historical_copies_expired` is refused (`unverified`) unless every inventoried generation
 * is `expired`, so the word is only ever said from receipts.
 */
export async function recordRetention(store: StoreLike, deletion: string, input: {
  state: RetentionState; until?: Date | null; detail?: Record<string, unknown>;
  generations?: { id: string; state: "pending" | "retention_unverified" | "retention_blocked" | "expired"; expires_at?: string | null }[];
}): Promise<RetentionAnswer> {
  const [row] = await store.sql`select hub_deletion_retention(${deletion}, ${input.state}, ${input.until === undefined || input.until === null ? null : input.until.toISOString()}::timestamptz,
    ${input.detail ?? null}::jsonb, ${input.generations === undefined ? null : JSON.stringify(input.generations)}::text::jsonb) as answer`;
  return row.answer as RetentionAnswer;
}

// ---------------------------------------------------------------------------------------------
// The control manifest
// ---------------------------------------------------------------------------------------------

/** One tombstone as a manifest carries it: identifiers only. */
export interface ManifestTombstone {
  topic_id: string;
  person: string;
  agent_id: string;
  conversation_id: string;
  origin: "created" | "legacy";
  door: string;
  chat: string | null;
  machine: string;
  runner: string;
  workers: string[];
  worker_locations?: { agent: string; conversation: string }[];
  deletion_id: string;
  deletion_generation: number;
  active_deleted: boolean;
}

export interface ErasureManifest {
  version: 1;
  generation: number;
  tombstones: ManifestTombstone[];
}

/** The content-free control manifest of this store, as of now. A store that has not been migrated has deleted nothing: the empty one. */
export async function readErasureManifest(store: StoreLike): Promise<ErasureManifest> {
  if (!(await deletionSchemaReady(store))) return { ...EMPTY_MANIFEST, tombstones: [] };
  const [row] = await store.sql`select hub_erasure_manifest() as manifest`;
  return row.manifest as ErasureManifest;
}

export async function erasureGeneration(store: StoreLike): Promise<number> {
  if (!(await deletionSchemaReady(store))) return 0;
  const [row] = await store.sql`select generation from erasure_control`;
  return Number(row.generation);
}

/**
 * Whether a backup assembled NOW would carry a topic whose deletion the owner confirmed: its rows are not erased yet, or a copy of it
 * is still waiting to be removed on this machine, where the backup reads its files. A string says why the copy is held; null says
 * nothing stands in its way. A held backup is a named failure, never a published copy of what was deleted.
 */
export async function backupHold(store: StoreLike, machine: string): Promise<string | null> {
  if (!(await deletionSchemaReady(store))) return null;
  const [row] = await store.sql`select
      (select count(*) from topic_deletion where stage in ('quiescing', 'deleting_active', 'failed')) as unerased,
      (select count(*) from erasure_receipt r join topic_deletion d on d.id = r.deletion_id
        where r.machine = ${machine} and r.state <> 'erased' and r.class in ('chatlog', 'engine_state', 'inbox_media', 'move_copy', 'harvest_stage') and not r.historical
          and d.stage not in ('awaiting_confirmation', 'superseded')) as local`;
  if (Number(row.unerased) > 0) return `${Number(row.unerased)} confirmed deletion${Number(row.unerased) === 1 ? " has" : "s have"} not erased the store's rows yet, so a copy of the store would still hold what was deleted`;
  if (Number(row.local) > 0) return `${Number(row.local)} copy${Number(row.local) === 1 ? "" : "s"} of a deleted topic on ${machine} ${Number(row.local) === 1 ? "is" : "are"} still waiting to be removed, so a copy of its files would still hold what was deleted`;
  return null;
}

/**
 * Merge a manifest into this store, as a restore or a returning machine does before anything is served: the identities are
 * reserved, the tombstones recorded and whatever of those topics the store holds is erased. A manifest that cannot be read whole
 * is refused and nothing of it is applied.
 */
export interface ApplyResult {
  tombstones: number;
  applied: number;
  generation: number;
  /** The topics whose tombstone this store had never heard of: what an old copy brought back was removed from it for the first time. */
  created: string[];
  /** The attachment folders (by the hash of the input's id) of the inputs it held for these topics, which went with the inputs. */
  inbox: { person: string; digest: string }[];
}

export async function applyErasureManifest(store: StoreLike, manifest: ErasureManifest): Promise<ApplyResult> {
  if (!(await councilNoticeSchemaReady(store))) throw new Error("schema-behind: apply migration 18 (council notice erasure) before restoring deleted topics");
  const [row] = await store.sql`select hub_erasure_apply(${JSON.stringify(manifest)}::text::jsonb) as done`;
  const done = row.done as { tombstones: number; applied: number; generation: number; created?: string[]; inbox?: { person: string; digest: string }[] };
  return { tombstones: Number(done.tombstones), applied: Number(done.applied), generation: Number(done.generation),
    created: done.created ?? [], inbox: done.inbox ?? [] };
}
