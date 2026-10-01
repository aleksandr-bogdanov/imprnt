import { createHash, randomUUID } from "node:crypto";
import type { StoreLike } from "./connect.ts";

/**
 * Topic moves, as the runner, the hub and the door read and write them (`016-topic-move.sql`). Every function takes a
 * `StoreLike`, so a caller hands it its own transaction when what it writes has to commit with something else.
 *
 * THIS IS THE STORE'S HALF OF MOVEMENT AND NOTHING ELSE. It moves no file, starts and stops no process, edits no registry and
 * knows no native session layout: bytes are opaque, manifests and evidence are typed and bounded documents the store compares
 * for EQUALITY against what it holds, and what only the operating system or the adapter can know (a process is gone, a file was
 * written, a session can be carried) is an ASSERTION the caller makes and the store records. Each function below says which of
 * its checks the store makes itself.
 *
 * NOTHING HERE DECIDES WHO MAY ASK. The routines behind these check what the store can (the current protocol-4 incarnation of a
 * runner, the stage, the generation, the role of the session for the hub's own) and every answer is a WORD, returned and not
 * thrown: a refusal is data a caller reports, and on every refusal the move's gate is exactly as it was. The gate is released by
 * `serveMove` and `withdrawMove` and by nothing else: no block and no failure puts the topic back on the source.
 */

export const MOVE_STAGES = [
  "waiting", "source_released", "importing", "activated", "registry_written", "active", "awaiting_owner", "withdrawn",
] as const;
export type MoveStage = (typeof MOVE_STAGES)[number];
/** The only two stages a move never leaves. */
export const TERMINAL_MOVE_STAGES: readonly MoveStage[] = ["active", "withdrawn"];
/** The stages in which an owner may still withdraw: before the placement moved. */
export const WITHDRAWABLE_STAGES: readonly MoveStage[] = ["waiting", "awaiting_owner", "source_released", "importing"];

/** Limits the store enforces on blobs: a file, and a whole move (postgres.js holds a bytea in memory). */
export const MOVE_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MOVE_MAX_BYTES = 64 * 1024 * 1024;

/** The operation id of a move's own gate (`claim_gate.operation_id`): the one gate `withdrawMove` and `serveMove` release. */
export const moveGateOperation = (move: string): string => `move:${move}`;

/** A note on the current stage. It never touches the gate. `by` says whose it is to clear: `store`'s clear when the condition is gone. */
export interface MoveBlock { code: string; detail: Record<string, unknown>; since: string; by: "source" | "dest" | "hub" | "store" }

export interface MoveHoldRef { inbound: string; execution: string; revision: number; state?: string; cause?: string }
export interface MoveAttemptRef { execution: string; state: string; purpose: string; runner: string; incarnation: string; inbound: string | null }
export interface MoveFailure { inbound: string; execution: string; revision: number; cause: string; state: string; since: string }

/**
 * What the source said it was about to close, persisted BEFORE it closes it. `boot_id` is the boot the incarnation REGISTERED
 * (the store refuses another: `boot-mismatch`, and `boot-unknown` when the registration has none); `machine` is the source's;
 * the rest is what was known. `set: "open"` says the incarnation's intents are not yet known to be all of them: the incarnation owes
 * a `seal` item until `sealDrainIntents` says they are (an intent without it keeps the earlier contract: complete as recorded).
 */
export interface DrainIntent { id: string; boot_id: string; machine: string; leader?: number | null; group?: number | null; pids?: number[]; [more: string]: unknown }

/**
 * What the store knew of the source AT THE REQUEST, frozen with the move. `known: false` (with a `reason`) is an honest "nothing
 * was known" (the source runner never registered, or registered for another machine): the move is admitted and gated, nothing later
 * is substituted for it, and the drain stays blocked by `drain_owner_unknown` until the move is withdrawn. `boot_id` may be null
 * when the registration could not read one.
 */
export type SourceBaseline =
  | { known: true; incarnation: string; boot_id: string | null; machine: string; protocol: number; registered_at: string }
  | { known: false; reason: "unregistered" | "registered-elsewhere"; registered_machine?: string | null };

/**
 * What one accepted piece of drain evidence resolved, kept on the move (`drain_resolutions`): an intent, an owner incarnation with none,
 * or (by a reboot only) the unsealed set of an incarnation that declared its intents open.
 */
export interface DrainResolution { kind: "intent" | "owner" | "seal"; id: string; basis: "process-group" | "boot" | "no-child"; via: string; boot_id: string; by: string; at: string }

/** The exit the source ASSERTS, in one of the three bases the store accepts. */
export type DrainExit =
  /** The very group a named intent recorded, in the same boot (registered boot == intent boot): resolves that intent only. */
  | { confirmed: true; leader: "exited"; descendants: "none"; basis: "process-group"; via: string; group: number; [more: string]: unknown }
  /** The machine booted again since an item was recorded: resolves EVERY pending item whose boot is known and is not the registered one. */
  | { confirmed: true; leader: "exited"; descendants: "none"; basis: "boot"; via: string; [more: string]: unknown }
  /** This incarnation has no child and closed its spawns: its OWN lifetime only (never a predecessor's), and only while it recorded no intent. */
  | { confirmed: true; basis: "no-child"; children: "none"; spawn_closed: true; via: string; [more: string]: unknown };

/**
 * What the source ASSERTS once its child is closed, one owner at a time (`recordDrainDone` accumulates them). The store checks the
 * identities (move, conversation, current native session, placement generation, runner, machine, incarnation), that `boot_id` IS the
 * boot the speaking incarnation registered, and refuses an incomplete assertion; it cannot check the operating system. `intent`
 * names the intent a `process-group` exit resolves. The drain is over only when every owner and intent the move lists is resolved.
 */
export interface DrainEvidence {
  move: string; conversation: string; native_session: string; placement_generation: number;
  runner: string; machine: string; incarnation: string; boot_id: string;
  intent?: string;
  exit: DrainExit;
  [more: string]: unknown;
}

/** The master's OWN consumed state: the maximum entry of THIS conversation and its last completed turn, never an inbound or council high-water mark. */
export interface MoveCheckpoint {
  conversation: string; native_session: string; native_state: string; placement_generation: number;
  entry_seq: number; last_completed: string | null;
}

export interface ManifestFile { kind: string; path: string; sha256: string; size: number; mode: number }
/**
 * The sealed export. `digest` is the transfer library's (the store keeps it and compares it for equality). `files` must be exactly
 * the stored blobs (kind, path, sha256, size, mode: the store recomputes sha256 and size from the bytes) and `bytes` their total.
 * For a conversation the engine has seen, `native` and `portability` are the adapter's assertion and are required; an empty
 * portability allowlist never produces them.
 */
export interface MoveManifest {
  digest: string; files: ManifestFile[]; bytes: number;
  native?: { native_session: string; native_manifest_digest: string };
  portability?: { adapter: string; from: string; to: string; evidence: string };
  [more: string]: unknown;
}

/** What the destination recorded at preflight. `profile` and `capabilities` are what serve compares the loaded side to, by equality. */
export interface DestFacts { profile: Record<string, unknown>; capabilities: Record<string, unknown>; [more: string]: unknown }

export interface RegistryReceipt {
  /** The authoritative registry digest the hub observed after its write (equality only: never ordered). */
  digest: string; agent: string; runner: string; machine: string; placement_generation: number; profile: Record<string, unknown>;
}

/** What the destination asserts it loaded, compared to what the store holds (and to the receipt's digest by equality). */
export interface LoadedEvidence {
  agent: string; runner: string; machine: string; placement_generation: number; digest: string;
  profile: Record<string, unknown>; capabilities: Record<string, unknown>;
  imported: { generation: number; manifest_digest: string };
}

export interface MoveRow {
  id: string;
  operation_id: string;
  topic_id: string;
  agent: string;
  person: string;
  requested_by: string;
  route: { door: string; chat: string } | null;
  evidence: Record<string, unknown>;
  stage: MoveStage;
  block: MoveBlock | null;
  source_runner: string;
  source_machine: string;
  dest_runner: string;
  dest_machine: string;
  conversation_id: string;
  adapter: string;
  native_session: string;
  native_state: string;
  source_generation: number;
  dest_generation: number | null;
  source_facts: { holds: number; attempts: number; councils: number; jobs: number };
  /** What the store knew of the source at the request (frozen). */
  source_incarnation: SourceBaseline;
  drain_attempts: MoveAttemptRef[];
  preexisting_holds: MoveHoldRef[];
  acknowledged_failures: { execution: string; revision: number; inbound: string | null; by: string; at: string }[];
  failure: MoveFailure | null;
  drain_intents: (DrainIntent & { incarnation: string; at: string })[];
  /** Every piece of drain evidence accepted so far; it is kept across restarts and across later intents (only the same intent again is a replay). */
  drain_resolutions: DrainResolution[];
  /** The incarnations that said the intents they recorded are every child they owe an account of (`sealDrainIntents`), and which intents. */
  drain_sealed: { incarnation: string; boot_id: string; intents: string[]; at: string }[];
  /** The export generation the current (or last) drain started; blobs and the seal are bound to it. 0 before any drain completed. */
  export_generation: number;
  /** Set when EVERY owner and intent is resolved, by the incarnation that completed it; null while any is pending or after a new intent. */
  drain: { incarnation: string; boot_id: string; runner: string; machine: string; export_generation: number; resolved: number; recorded: string } | null;
  snapshot: (MoveCheckpoint & { conversation: string }) | null;
  manifest: MoveManifest | null;
  dest_facts: DestFacts | null;
  dest_ready_at: Date | null;
  import_generation: number;
  verification: Record<string, unknown> | null;
  registry_receipt: RegistryReceipt | null;
  note_state: "pending" | "delivered" | null;
  note_digest: string | null;
  note_attempt: string | null;
  created_at: Date;
  updated_at: Date;
  source_released_at: Date | null;
  activated_at: Date | null;
  finished_at: Date | null;
}

export type CopyState =
  | "intent" | "verified" | "promote_intent" | "promoted" | "active" | "cleanup_due" | "removed" | "retained" | "source_owned" | "retained_stale"
  | "superseded";

/** A copy claims its location in every state but these two. The table allows ONE live claim per location (conversation, machine). */
export const NOT_LIVE_COPY_STATES: readonly CopyState[] = ["removed", "superseded"];
export type CopyKind = "dest_import" | "source_session_retained";

/**
 * One physical copy and whose it is: the move, the machine, the generation and a staging identity the store made (never a path),
 * and the LOCATION it claims (conversation, machine: the session directory has no native-session part) with the placement generation
 * it stands for. `native_session` is evidence of what the copy held, not part of where it is. A row is a record of who claims a
 * location and what its owner reported, never proof of what is on a disk.
 */
export interface MoveCopyRow {
  move_id: string;
  machine: string;
  kind: CopyKind;
  generation: number;
  state: CopyState;
  staging_id: string;
  runner: string;
  incarnation: string;
  conversation_id: string;
  native_session: string;
  placement_generation: number;
  digest: string | null;
  file_count: number | null;
  bytes: number | null;
  evidence: Record<string, unknown>;
  updated_at: Date;
}

const dateOf = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string));

export function moveOf(raw: Record<string, unknown>): MoveRow {
  const row = raw as unknown as MoveRow;
  return {
    ...row,
    source_generation: Number(row.source_generation),
    dest_generation: row.dest_generation === null ? null : Number(row.dest_generation),
    import_generation: Number(row.import_generation),
    export_generation: Number(row.export_generation),
    dest_ready_at: dateOf(row.dest_ready_at),
    created_at: dateOf(row.created_at)!,
    updated_at: dateOf(row.updated_at)!,
    source_released_at: dateOf(row.source_released_at),
    activated_at: dateOf(row.activated_at),
    finished_at: dateOf(row.finished_at),
  };
}

const MOVE_COLUMNS = `id, operation_id, topic_id, agent, person, requested_by, route, evidence, stage, block, source_runner, source_machine,
  dest_runner, dest_machine, conversation_id, adapter, native_session, native_state, source_generation, dest_generation, source_facts,
  source_incarnation, drain_attempts, preexisting_holds, acknowledged_failures, failure, drain_intents, drain_resolutions, drain_sealed, export_generation,
  drain, snapshot, manifest, dest_facts, dest_ready_at,
  import_generation, verification, registry_receipt, note_state, note_digest, note_attempt, created_at, updated_at, source_released_at,
  activated_at, finished_at`;

export async function readMove(store: StoreLike, id: string): Promise<MoveRow | null> {
  const [row] = await store.sql.unsafe(`select ${MOVE_COLUMNS} from topic_move where id = $1`, [id]);
  return row ? moveOf(row) : null;
}

export async function readMoveByOperation(store: StoreLike, operation: string): Promise<MoveRow | null> {
  const [row] = await store.sql.unsafe(`select ${MOVE_COLUMNS} from topic_move where operation_id = $1`, [operation]);
  return row ? moveOf(row) : null;
}

/** The topic's one non-terminal move, if it has one. */
export async function openMoveOfTopic(store: StoreLike, topic: string): Promise<MoveRow | null> {
  const [row] = await store.sql.unsafe(`select ${MOVE_COLUMNS} from topic_move where topic_id = $1 and stage not in ('active', 'withdrawn')`, [topic]);
  return row ? moveOf(row) : null;
}

/** The non-terminal move whose gate covers this agent, if any. */
export async function openMoveOfAgent(store: StoreLike, agent: string): Promise<MoveRow | null> {
  const [row] = await store.sql.unsafe(`select ${MOVE_COLUMNS} from topic_move where agent = $1 and stage not in ('active', 'withdrawn')`, [agent]);
  return row ? moveOf(row) : null;
}

/** Every non-terminal move this runner is the source or the destination of, oldest first: what it looks at on its `hub_move` wake and at start. */
export async function movesOfRunner(store: StoreLike, runner: string): Promise<MoveRow[]> {
  const rows = await store.sql.unsafe(`select ${MOVE_COLUMNS} from topic_move
    where stage not in ('active', 'withdrawn') and (source_runner = $1 or dest_runner = $1) order by created_at, id`, [runner]);
  return rows.map((row: Record<string, unknown>) => moveOf(row));
}

/** Every non-terminal move the hub has registry work for: `activated` (write the registry) and `registry_written` (refresh the receipt). */
export async function movesForHub(store: StoreLike): Promise<MoveRow[]> {
  const rows = await store.sql.unsafe(`select ${MOVE_COLUMNS} from topic_move where stage in ('activated', 'registry_written') order by created_at, id`);
  return rows.map((row: Record<string, unknown>) => moveOf(row));
}

/**
 * Copies whose owner this runner is and that are owed their removal (`cleanup_due`): a destination copy of a withdrawn or failed
 * import, or a stale retained source copy a later move retired. The runner removes only what its staging identity owns, serialized
 * against any writer on its own machine, and then reports it with `copyRemoved` and a receipt naming that staging identity.
 */
export async function copiesDueForCleanup(store: StoreLike, runner: string): Promise<MoveCopyRow[]> {
  const rows = await store.sql`select c.move_id, c.machine, c.kind, c.generation, c.state, c.staging_id, c.runner, c.incarnation, c.conversation_id, c.native_session,
      c.placement_generation, c.digest, c.file_count, c.bytes, c.evidence, c.updated_at
    from move_copy c join topic_move m on m.id = c.move_id
    where c.state = 'cleanup_due'
      and ((c.kind = 'dest_import' and m.dest_runner = ${runner}) or (c.kind = 'source_session_retained' and m.source_runner = ${runner}))
    order by c.created_at, c.move_id, c.generation`;
  return (rows as unknown as Record<string, unknown>[]).map(copyOf);
}

export async function copiesOf(store: StoreLike, move: string): Promise<MoveCopyRow[]> {
  const rows = await store.sql`select move_id, machine, kind, generation, state, staging_id, runner, incarnation, conversation_id, native_session, placement_generation,
      digest, file_count, bytes, evidence, updated_at
    from move_copy where move_id = ${move} order by kind, generation`;
  return (rows as unknown as Record<string, unknown>[]).map(copyOf);
}

/**
 * Every copy, of any move, that still claims one location: the conversation on one machine, whatever native session the copy
 * recorded. At most one is live (the table allows no more); this is what a runtime looks at before it writes or removes anything
 * there, and what `beginImport` names as `occupant` when the location is taken.
 */
export async function copiesAtLocation(store: StoreLike, location: { conversation: string; machine: string }): Promise<MoveCopyRow[]> {
  const rows = await store.sql`select move_id, machine, kind, generation, state, staging_id, runner, incarnation, conversation_id, native_session, placement_generation,
      digest, file_count, bytes, evidence, updated_at
    from move_copy where conversation_id = ${location.conversation} and machine = ${location.machine}
    order by created_at, move_id, kind, generation`;
  return (rows as unknown as Record<string, unknown>[]).map(copyOf);
}

function copyOf(raw: Record<string, unknown>): MoveCopyRow {
  const row = raw as unknown as MoveCopyRow;
  return { ...row, generation: Number(row.generation), placement_generation: Number(row.placement_generation),
    file_count: row.file_count === null ? null : Number(row.file_count), bytes: row.bytes === null ? null : Number(row.bytes), updated_at: dateOf(row.updated_at)! };
}

/** The export generation the move's completed drain started (what `putBlob` and `releaseSource` must name), or null while no drain stands. */
export const exportGenerationOf = (move: MoveRow): number | null => (move.drain ? move.export_generation : null);

/**
 * The master's own consumed state, read the way the store compares it at release and at activation: the maximum entry of THIS
 * conversation, its last completed turn, its native identity and its placement generation. A council's event, a worker's reply
 * or the inbound high-water mark is not in it and never moves it.
 */
export async function checkpointOf(store: StoreLike, conversation: string): Promise<MoveCheckpoint | null> {
  const [row] = (await store.sql`select c.id, c.native_session, c.native_state, c.placement_generation,
      coalesce((select max(e.seq) from conversation_entry e where e.conversation_id = c.id), 0) as entry_seq,
      (select x.id from execution x where x.conversation_id = c.id and x.state = 'completed' order by x.ended_at desc, x.id desc limit 1) as last_completed
    from conversation c where c.id = ${conversation}`) as unknown as
    { id: string; native_session: string; native_state: string; placement_generation: number; entry_seq: number; last_completed: string | null }[];
  return row ? { conversation: row.id, native_session: row.native_session, native_state: row.native_state,
    placement_generation: Number(row.placement_generation), entry_seq: Number(row.entry_seq), last_completed: row.last_completed } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `protocol-inactive`: the store has not activated protocol 4, so a runner that does not know moves could serve after the gate.
 * `in-progress`: an open move, an open archive or reopen, or a pending deletion request. Nothing is gated on any refusal.
 */
export type RequestAnswer = "requested" | "replay" | "unknown-topic" | "protocol-inactive" | "not-active" | "in-progress" | "same-machine";

/**
 * Ask for a move, and place the master's agent gate in the SAME transaction, whether or not the destination is up: from this
 * commit the source takes no new claim and no unfed attempt's first feed (`markFeedIntent` throws `MoveGated`), while the
 * turn that was already fed finishes. Open councils, jobs and holds are admitted and counted in `source_facts`; only the master
 * moves. The same `operation` is the same move (`replay`).
 */
export async function requestMove(store: StoreLike, request: {
  operation: string; topic: string; destRunner: string; destMachine: string; by: string;
  route?: { door: string; chat: string } | null; evidence?: Record<string, unknown>; id?: string;
}): Promise<{ answer: RequestAnswer; move: MoveRow | null }> {
  const [row] = await store.sql`select hub_move_request(${request.id ?? randomUUID()}, ${request.operation}, ${request.topic}, ${request.destRunner},
    ${request.destMachine}, ${request.by}, ${request.route ?? null}::jsonb, ${request.evidence ?? {}}::jsonb) as answer`;
  const answer = row.answer as RequestAnswer;
  return { answer, move: answer === "requested" || answer === "replay" ? await readMoveByOperation(store, request.operation) : null };
}

/** The answers every routine can give whatever it is about. */
type Common = "unknown-move" | "terminal" | "stage";
type Source = Common | "not-source";
type Dest = Common | "not-destination";

// ---------------------------------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------------------------------

export type BlockAnswer = Common | "not-party" | "block-invalid" | "replay" | "blocked" | "occupied";
export type UnblockAnswer = Common | "not-party" | "none" | "still-blocked" | "not-yours" | "cleared";

/**
 * Name what a stage is waiting on. `party: null` is the hub (the store checks the session's role). The gate stays and the move
 * keeps its stage: a block is an annotation, never a release and never a fallback to the source. `dependency_unverified` is such a
 * name; there is no acknowledgement that clears one, only the side that set it re-verifying and clearing it. There is one block at a
 * time and ANOTHER PARTY'S IS NEVER REPLACED: a call that would is `occupied` (a side may restate or replace its own). Every step
 * that advances the handoff (release, import and its steps, activation, the registry receipt, serve) stops under any block.
 */
export async function blockMove(store: StoreLike, move: string, party: { runner: string; incarnation: string } | null, code: string, detail: Record<string, unknown> = {}): Promise<BlockAnswer> {
  const [row] = await store.sql`select hub_move_block(${move}, ${party?.runner ?? null}, ${party?.incarnation ?? null}, ${code}, ${detail}::jsonb) as answer`;
  return row.answer as BlockAnswer;
}

/** Clear a block: the side that set it clears it; the store's own (`topic_not_active`) clears only once the topic is active again. */
export async function unblockMove(store: StoreLike, move: string, party: { runner: string; incarnation: string } | null, code: string): Promise<UnblockAnswer> {
  const [row] = await store.sql`select hub_move_unblock(${move}, ${party?.runner ?? null}, ${party?.incarnation ?? null}, ${code}) as answer`;
  return row.answer as UnblockAnswer;
}

// ---------------------------------------------------------------------------------------------------------------------
// The destination's preflight and the source's drain
// ---------------------------------------------------------------------------------------------------------------------

export type DestReadyAnswer = Dest | "facts-invalid" | "replay" | "ready";

/** The destination's preflight (login, capabilities, profile digests, CLI version, empty session directory): recorded, not judged. Only `waiting`. */
export async function destReady(store: StoreLike, move: string, who: { runner: string; incarnation: string }, facts: DestFacts): Promise<DestReadyAnswer> {
  const [row] = await store.sql`select hub_move_dest_ready(${move}, ${who.runner}, ${who.incarnation}, ${facts}::jsonb) as answer`;
  return row.answer as DestReadyAnswer;
}

export type DrainIntentAnswer = Source | "intent-invalid" | "intent-limit" | "intent-sealed" | "boot-unknown" | "boot-mismatch" | "replay" | "intent";

/**
 * The intent to close the source's child, durable BEFORE anything is closed; its `boot_id` must be the boot the incarnation
 * registered. A genuinely new intent makes the drain stale and starts a new export (the previous export's unsealed blobs are
 * removed); it keeps what the other intents and owners already proved. The same intent again is a `replay` and changes nothing.
 */
export async function recordDrainIntent(store: StoreLike, move: string, who: { runner: string; incarnation: string }, intent: DrainIntent): Promise<DrainIntentAnswer> {
  const [row] = await store.sql`select hub_move_drain_intent(${move}, ${who.runner}, ${who.incarnation}, ${intent}::jsonb) as answer`;
  return row.answer as DrainIntentAnswer;
}

export type DrainSealAnswer = Source | "seal-invalid" | "seal-mismatch" | "boot-unknown" | "replay" | "sealed";

/**
 * The incarnation's assertion that the intents it recorded for this move (`ids`, EXACTLY those: the store compares them with what it
 * holds) are every child it owes an account of and that it records no other. Until it is made, an incarnation whose intents say
 * `set: "open"` has a `seal` item the drain cannot be certified without, so a prefix of its intents (a crash between two writes, a
 * refused intent) can never show the drain is over. Sealed, the set takes no further intent (`intent-sealed`). It is not evidence that
 * any child is gone.
 */
export async function sealDrainIntents(store: StoreLike, move: string, who: { runner: string; incarnation: string }, ids: string[]): Promise<DrainSealAnswer> {
  const [row] = await store.sql`select hub_move_drain_seal(${move}, ${who.runner}, ${who.incarnation}, ${JSON.stringify(ids)}::text::jsonb) as answer`;
  return row.answer as DrainSealAnswer;
}

export type DrainDoneAnswer = Source | "evidence-invalid" | "replay" | "busy" | "failure-unacknowledged" | "boot-unknown" | "boot-mismatch"
  | "drain-identity-mismatch" | "no-intent" | "drain-proof-incomplete" | "partial" | "owner-unknown" | "drained";

/**
 * One piece of the assertion that the source's children are gone, for ONE owner. The drain is over (`drained`) only when EVERY
 * owner and intent the move lists is resolved: each drain intent ever recorded, the incarnation that was the source's at the request
 * (when it recorded none), and the incarnation speaking now (when it recorded none). `partial` says some remain (read
 * `drain_resolutions` and `drain_intents`); `owner-unknown` says the source's predecessor at the request was never known, which
 * nothing the store can check resolves (the move carries the block `drain_owner_unknown`; it ends by its withdrawal). A restarted
 * runner that finds no child in memory has proved nothing about its predecessor: `process-group` resolves the one intent it names in
 * the same boot, `boot` resolves every pending item of another boot (the store compares the recorded boots itself), and `no-child`
 * is an incarnation's claim about its OWN lifetime only. The evidence's `boot_id` must be the boot the incarnation registered
 * (`boot-mismatch`, `boot-unknown`). Refused while any attempt of the agent is owned (`busy`) or a new failure stands
 * (`failure-unacknowledged`, which also moves the move to `awaiting_owner`). Completing the drain starts a new export generation.
 */
export async function recordDrainDone(store: StoreLike, move: string, who: { runner: string; incarnation: string }, evidence: DrainEvidence): Promise<DrainDoneAnswer> {
  const [row] = await store.sql`select hub_move_drain_done(${move}, ${who.runner}, ${who.incarnation}, ${evidence}::jsonb) as answer`;
  return row.answer as DrainDoneAnswer;
}

/**
 * Look again for a NEW drain failure: an unreleased hold on the master that did not exist at the request and that the owner has
 * not acknowledged at its revision. The trigger on `replay_hold` does this in the writing transaction; this is for a reconciler.
 * A held conversation admitted at the request is not a failure. Returns the stage.
 */
export async function checkMoveFailure(store: StoreLike, move: string): Promise<MoveStage | "unknown-move" | "terminal"> {
  const [row] = await store.sql`select hub_move_check_failure(${move}) as answer`;
  return row.answer as MoveStage | "unknown-move" | "terminal";
}

export type ContinueAnswer = Common | "replay" | "continue-invalid" | "stale" | "ownership-unresolved" | "waiting" | "awaiting_owner";

/**
 * The owner's `continue` for THIS MOVE, bound to the failure (attempt and revision) it was shown. It needs ownership resolved, returns
 * the move to `waiting`, and writes nothing about the hold: it is not `/recover continue`, releases no hold and authorizes nothing to
 * be fed. The same unchanged hold is not a new failure; a distinct one still blocks (`awaiting_owner`).
 */
export async function continueMove(store: StoreLike, move: string, by: string, failure: { execution: string; revision: number }, evidence: Record<string, unknown> = {}): Promise<ContinueAnswer> {
  const [row] = await store.sql`select hub_move_continue(${move}, ${by}, ${failure.execution}, ${failure.revision}::integer, ${evidence}::jsonb) as answer`;
  return row.answer as ContinueAnswer;
}

// ---------------------------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------------------------

export type BlobAnswer = Source | "not-source" | "drain-stale" | "stale-export" | "busy" | "replay" | "blob-conflict" | "stored";

/**
 * One opaque file, after this incarnation's drain evidence and with nothing owned, written UNDER THE EXPORT GENERATION the
 * completed drain started (`exportGenerationOf(move)`): a late writer of an earlier generation, even of the same incarnation,
 * meets `stale-export` and writes nothing. The bytes are never read by the store, which recomputes their sha256 and size; the same
 * bytes with the same mode again is a `replay`, anything else at that path a `blob-conflict`. Refused before it is sent when it is
 * over a limit the table would refuse anyway.
 */
export async function putBlob(store: StoreLike, move: string, who: { runner: string; incarnation: string }, generation: number,
  file: { kind: string; path: string; mode: number; bytes: Uint8Array }): Promise<BlobAnswer> {
  if (file.bytes.byteLength > MOVE_MAX_FILE_BYTES) throw new RangeError(`a file of a move is at most ${MOVE_MAX_FILE_BYTES} bytes`);
  const [row] = await store.sql`select hub_move_blob_put(${move}, ${who.runner}, ${who.incarnation}, ${generation}::integer, ${file.kind}, ${file.path}, ${file.mode}::integer,
    ${Buffer.from(file.bytes)}::bytea) as answer`;
  return row.answer as BlobAnswer;
}

export type ReleaseAnswer = Source | "replay" | "blocked" | "dest-not-ready" | "topic-not-active" | "drain-stale" | "stale-export" | "busy" | "failure-unacknowledged"
  | "source-copy-unresolved" | "placement-changed" | "checkpoint-mismatch" | "manifest-invalid" | "manifest-mismatch" | "native-evidence-missing" | "released";

/**
 * Seal the export of `generation`. The store checks, itself: the current protocol-4 source incarnation with THIS incarnation's
 * completed drain and that export generation; the destination's preflight; no block; an active topic with no open transition; no
 * new failure (found now, it moves the move to `awaiting_owner`); nothing owned; the checkpoint equals the master's own consumed
 * state; the source's own copy of the session is not claimed by anything unresolved; and the manifest's files are exactly the stored
 * blobs with their recomputed sha256 and sizes. It records the manifest digest and, for a conversation the engine has seen, the
 * adapter's native and portability assertion, and refuses a started conversation that has none. A sealed export is immutable. No
 * council event or inbound high-water mark is read.
 */
export async function releaseSource(store: StoreLike, move: string, who: { runner: string; incarnation: string }, generation: number,
  checkpoint: MoveCheckpoint, manifest: MoveManifest): Promise<ReleaseAnswer> {
  const [row] = await store.sql`select hub_move_source_release(${move}, ${who.runner}, ${who.incarnation}, ${generation}::integer, ${checkpoint}::jsonb, ${manifest}::jsonb) as answer`;
  return row.answer as ReleaseAnswer;
}

export class MoveBlobsGone extends Error {
  constructor(readonly move: string, detail: string) {
    super(`move-blobs-gone: ${move} (${detail})`);
    this.name = "MoveBlobsGone";
  }
}

export interface MoveBlob { kind: string; path: string; mode: number; size: number; sha256: string; bytes: Buffer }

/**
 * The bytes a sealed move carries, for the destination that imports them. They are exactly the manifest's files or this throws
 * `MoveBlobsGone`: a move that was withdrawn or served had its blobs removed, and a reader must treat what is missing as a failed
 * import, never as an empty or partial one. The bytes are checked against the manifest's own sha256 and size here too.
 */
export async function readBlobs(store: StoreLike, move: MoveRow): Promise<MoveBlob[]> {
  if (!move.manifest) throw new MoveBlobsGone(move.id, "no manifest was sealed");
  const rows = (await store.sql`select kind, rel_path, mode, size, sha256, bytes from move_blob where move_id = ${move.id} order by kind, rel_path`) as unknown as
    { kind: string; rel_path: string; mode: number; size: number; sha256: string; bytes: Buffer }[];
  if (rows.length !== move.manifest.files.length) throw new MoveBlobsGone(move.id, `${rows.length} of ${move.manifest.files.length} files are stored`);
  const listed = new Map(move.manifest.files.map(file => [`${file.kind}\u001f${file.path}`, file]));
  return rows.map((row) => {
    const file = listed.get(`${row.kind}\u001f${row.rel_path}`);
    const bytes = Buffer.from(row.bytes);
    if (!file || file.sha256 !== row.sha256 || file.size !== Number(row.size) || file.mode !== Number(row.mode)
      || createHash("sha256").update(bytes).digest("hex") !== file.sha256 || bytes.byteLength !== file.size) {
      throw new MoveBlobsGone(move.id, `${row.kind}/${row.rel_path} is not the manifest's file`);
    }
    return { kind: row.kind, path: row.rel_path, mode: Number(row.mode), size: Number(row.size), sha256: row.sha256, bytes };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------------------------

export type ImportBeginAnswer = Dest | "blocked" | "topic-not-active" | "cleanup-pending" | "copy-occupied" | "intent" | "resumed";

/** The copy that claims the location a refused `beginImport` wanted (any move's: the location is the conversation on the machine). */
export interface CopyOccupant { move: string; kind: CopyKind; generation: number; state: CopyState; machine: string }

/**
 * The destination takes ownership of an import generation and its staging identity BEFORE it writes a file. `resumed` is its own
 * earlier generation after a restart (recognised by the same staging identity, not a foreign collision). Both stop under a block or
 * while the topic is not active. A generation cannot begin while ANY copy, of this move or an earlier one, claims the same location
 * (this conversation on the destination machine, whatever native session the copy recorded): `cleanup-pending` while that copy is owed its removal (the
 * owner reports it with `copyRemoved` first), `copy-occupied` for anything else, named in `occupant` (a stale retained source copy
 * is retired with `retireCopy` and then removed).
 */
export async function beginImport(store: StoreLike, move: string, who: { runner: string; incarnation: string }):
  Promise<{ answer: ImportBeginAnswer; generation: number | null; staging: string | null; occupant?: CopyOccupant }> {
  const [row] = await store.sql`select hub_move_import_begin(${move}, ${who.runner}, ${who.incarnation}) as answer`;
  const said = row.answer as { answer: ImportBeginAnswer; generation?: number; staging?: string; occupant?: CopyOccupant };
  return { answer: said.answer, generation: said.generation ?? null, staging: said.staging ?? null, ...(said.occupant ? { occupant: said.occupant } : {}) };
}

export type ImportStep = "verified" | "promote_intent" | "promoted";
export type ImportAdvanceAnswer = Dest | "stale-generation" | "unknown-copy" | "replay" | "blocked" | "topic-not-active" | "bad-transition" | "evidence-invalid"
  | "verification-mismatch" | ImportStep;

/**
 * One step of the current generation's own copy, committed for THIS stage, generation and incarnation (a late write after a
 * withdraw, for another generation or by a replaced incarnation is refused). `verified` carries the read-back and is checked
 * against the manifest; `promote_intent` is recorded BEFORE files go into the launch directory, `promoted` after. A step is a step
 * of the handoff: under any block, or while the topic is not active, it is refused (`blocked`, `topic-not-active`).
 */
export async function advanceImport(store: StoreLike, move: string, who: { runner: string; incarnation: string }, generation: number, to: ImportStep, evidence: Record<string, unknown> = {}): Promise<ImportAdvanceAnswer> {
  const [row] = await store.sql`select hub_move_import_advance(${move}, ${who.runner}, ${who.incarnation}, ${generation}::integer, ${to}, ${evidence}::jsonb) as answer`;
  return row.answer as ImportAdvanceAnswer;
}

export type ImportFailedAnswer = Dest | "stale-generation" | "block-invalid" | "failed";

/**
 * The import failed: the copy is due for the owner's cleanup (always) and the move waits, gate kept. The destination's reason is the
 * move's block only when there is none; another party's block is preserved, and the destination's reason stays on the copy's evidence.
 */
export async function failImport(store: StoreLike, move: string, who: { runner: string; incarnation: string }, generation: number, code: string, detail: Record<string, unknown> = {}): Promise<ImportFailedAnswer> {
  const [row] = await store.sql`select hub_move_import_failed(${move}, ${who.runner}, ${who.incarnation}, ${generation}::integer, ${code}, ${detail}::jsonb) as answer`;
  return row.answer as ImportFailedAnswer;
}

export type CopyRemovedAnswer = "unknown-move" | "not-owner" | "unknown-copy" | "replay" | "not-due" | "receipt-mismatch" | "removed";

/**
 * The owner reports what it removed, of ONE copy (`kind`, `generation` of `move`; an import by default). Only a `cleanup_due` copy
 * can be reported removed: a promoted, active or retained one has no path here. The `receipt` must name the copy's own `staging`
 * identity (`MoveCopyRow.staging_id`), so a cleaner holding an earlier move's identity can neither certify nor release a later
 * owner's copy. The reporter is the current protocol-4 incarnation of the copy's side on its machine. The store records the report;
 * that the files are gone, and that no writer raced the cleaner, is the runtime's.
 */
export async function copyRemoved(store: StoreLike, move: string, who: { runner: string; incarnation: string }, generation: number,
  receipt: { staging: string; [more: string]: unknown }, kind: CopyKind = "dest_import"): Promise<CopyRemovedAnswer> {
  const [row] = await store.sql`select hub_move_copy_removed(${move}, ${who.runner}, ${who.incarnation}, ${kind}, ${generation}::integer, ${receipt}::jsonb) as answer`;
  return row.answer as CopyRemovedAnswer;
}

export type CopyRetireAnswer = Common | "not-destination" | "unknown-copy" | "needed" | "replay" | "retired";

/**
 * Retire a STALE retained source copy so that this move can import into its location (A to B to A: the source copy an earlier move
 * left behind is where the conversation is coming back to). Called by the destination runner of `move` (before its import, stage
 * `source_released`) for the stale copy named by `{ move, kind, generation }`; the copy becomes `cleanup_due` and its owner removes
 * it and reports it with `copyRemoved`. Refused as `needed`: this move's own copies, any copy that is not `retained_stale`, and a
 * copy on the machine the conversation is placed on now (the source copy a current handoff or a withdrawal depends on is never
 * retirable). Nothing here removes anything.
 */
export async function retireCopy(store: StoreLike, move: string, who: { runner: string; incarnation: string },
  stale: { move: string; kind: CopyKind; generation: number }): Promise<CopyRetireAnswer> {
  const [row] = await store.sql`select hub_move_copy_retire(${move}, ${who.runner}, ${who.incarnation}, ${stale.move}, ${stale.kind}, ${stale.generation}::integer) as answer`;
  return row.answer as CopyRetireAnswer;
}

// ---------------------------------------------------------------------------------------------------------------------
// Activation, the registry receipt and serve
// ---------------------------------------------------------------------------------------------------------------------

export type ActivateAnswer = Dest | "stale-generation" | "import-incomplete" | "verification-mismatch" | "blocked" | "topic-not-active" | "gate-lost"
  | "snapshot-changed" | "busy" | "replay" | "activated";

/**
 * Move the placement. The store checks, itself: the current protocol-4 destination incarnation; the current import generation's
 * copy is `promoted`; the verification names that generation and staging, the sealed manifest digest and (started conversations)
 * the manifest's native identity; the topic is active with no open transition; the gate is still open; and the source is exactly
 * the snapshot sealed at release (same conversation, placement, native identity, the master's entry maximum and last completed
 * turn, nothing owned). The gate STAYS: only `serveMove` releases it.
 */
export async function activateMove(store: StoreLike, move: string, who: { runner: string; incarnation: string }, generation: number, verification: Record<string, unknown>): Promise<ActivateAnswer> {
  const [row] = await store.sql`select hub_move_activate(${move}, ${who.runner}, ${who.incarnation}, ${generation}::integer, ${verification}::jsonb) as answer`;
  return row.answer as ActivateAnswer;
}

export type RegistryWrittenAnswer = "unknown-move" | "terminal" | "stage" | "use-refresh" | "replay" | "blocked" | "topic-not-active" | "receipt-invalid" | "written";

/** The hub's receipt after it wrote the registry: the observed digest and the semantic binding. The hub role only. */
export async function recordRegistryWritten(store: StoreLike, move: string, receipt: RegistryReceipt): Promise<RegistryWrittenAnswer> {
  const [row] = await store.sql`select hub_move_registry_written(${move}, ${receipt}::jsonb) as answer`;
  return row.answer as RegistryWrittenAnswer;
}

export type RegistryRefreshAnswer = "unknown-move" | "terminal" | "stage" | "binding-changed" | "unchanged" | "refreshed";

/**
 * An unrelated registry edit changed the digest: the hub reconciles and refreshes the receipt while the binding (agent, destination,
 * placement generation, profile) still matches. A receipt that does not match the binding is `binding-changed` and the gate stays.
 */
export async function refreshRegistryReceipt(store: StoreLike, move: string, receipt: RegistryReceipt): Promise<RegistryRefreshAnswer> {
  const [row] = await store.sql`select hub_move_registry_refresh(${move}, ${receipt}::jsonb) as answer`;
  return row.answer as RegistryRefreshAnswer;
}

export type ServeAnswer = Dest | "replay" | "loaded-invalid" | "blocked" | "topic-not-active" | "placement-changed" | "import-unavailable" | "loaded-mismatch"
  | "profile-mismatch" | "registry-stale" | "active";

/** The body the notice queued in the serve (or withdraw) transaction carries, once, under the move's own key. */
export interface MoveNotice { body: string; person: string; agent: string; route: { door: string; chat: string; origin?: "watcher" } | null }

/**
 * THE ONLY CALL THAT RELEASES A MOVE'S GATE FOR A MOVE THAT WENT THROUGH. `loaded` is the destination's assertion; the store compares
 * it, by equality, with what it holds (the activated placement, the destination's own preflight profile and capabilities, the
 * receipt's digest, the sealed manifest digest) and checks itself that the topic is active with no open transition, that the
 * conversation and topic name the destination and that the import copy is still the promoted one. ANY block stops it (`blocked`,
 * whoever set it: the gate is never released under one), and a topic archived between activation and serve is `topic-not-active`:
 * the gate stays, the stage stays, no notice is queued. The store's own `topic_not_active` clears itself here once the topic is
 * active again. On success the gate is released,
 * the relocation note is owed (`note.digest`), the notice is queued, the blobs are removed and the source copy is marked stale.
 */
export async function serveMove(store: StoreLike, move: string, who: { runner: string; incarnation: string }, loaded: LoadedEvidence,
  note: { digest: string }, notice: MoveNotice | null): Promise<ServeAnswer> {
  const [row] = await store.sql`select hub_move_serve(${move}, ${who.runner}, ${who.incarnation}, ${loaded}::jsonb, ${note}::jsonb, ${notice}::jsonb) as answer`;
  return row.answer as ServeAnswer;
}

// ---------------------------------------------------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------------------------------------------------

export type WithdrawAnswer = "unknown-move" | "replay" | "too-late" | "withdraw-invalid" | "execution-unresolved" | "withdrawn";

/**
 * The owner's withdrawal, only before activation and only with no attempt of the agent owned. It releases ONLY this move's gate
 * (every other gate and every hold stays), marks the destination's unfinished copies `cleanup_due` (the owner removes what it owns
 * and reports it; this records no file as removed), keeps the source the owner of its session, and removes the blobs. `too-late`
 * from `activated`: the activated move finishes its destination handoff first, and no new move is promised meanwhile.
 */
export async function withdrawMove(store: StoreLike, move: string, by: string, options: {
  route?: { door: string; chat: string } | null; evidence?: Record<string, unknown>; notice?: MoveNotice | null;
} = {}): Promise<WithdrawAnswer> {
  const [row] = await store.sql`select hub_move_withdraw(${move}, ${by}, ${options.route ?? null}::jsonb, ${options.evidence ?? {}}::jsonb, ${options.notice ?? null}::jsonb) as answer`;
  return row.answer as WithdrawAnswer;
}

// ---------------------------------------------------------------------------------------------------------------------
// The relocation note
// ---------------------------------------------------------------------------------------------------------------------

/** What is owed to the next real input of a moved conversation: the move, the note's digest, and the attempt that last carried it, if any. */
export interface OwedNote { move: string; digest: string; conversation: string; attempt: string | null }

/**
 * The relocation notes this agent still owes its next real input (human, report or council event, or an authorized continuation:
 * never a turn of its own, never synthetic history), OLDEST FIRST. Two completed moves with no real input between them owe two, and
 * the model is told the whole chain, so the caller composes ALL of them into the one input (the body of each is the text whose
 * sha256 its move declared at serve) and passes the complete list `[{ move, digest }]` as `markFeedIntent`'s `notes`, which
 * journals the carrying attempt in the feed-intent transaction. They stay owed until `noteDelivered`: opening an attempt, a feed
 * intent, a failed feed (`FeedNotWritten`) or a crash before a byte deliver nothing, and the held assignment is never touched.
 */
export async function pendingNotesOf(store: StoreLike, agent: string): Promise<OwedNote[]> {
  const rows = (await store.sql`select id, note_digest, conversation_id, note_attempt from topic_move
    where agent = ${agent} and stage = 'active' and note_state = 'pending' order by finished_at, id`) as unknown as
    { id: string; note_digest: string; conversation_id: string; note_attempt: string | null }[];
  return rows.map(row => ({ move: row.id, digest: row.note_digest, conversation: row.conversation_id, attempt: row.note_attempt }));
}

export type NoteDeliveredAnswer = "no-note" | "replay" | "not-carrier" | "not-received" | "notes-mismatch" | "note-invalid" | "digest-mismatch" | "delivered";

/**
 * Acknowledge delivery on EVIDENCE, for EXACTLY the notes the attempt carried: the attempt the feed journaled as carrying them is
 * `received`, `running` or `completed`. `notes` is the list of `{ move, body }` it carried, oldest first, and each `body` must be the
 * text whose sha256 is that move's declared note digest (`digest-mismatch`: no other text is ever written down as a move's
 * explanation). The conversation's recovery entries (one for each, once: `move-note:<move>`) and the delivered marks commit
 * together, so a failed bookkeeping write leaves all of them owed, a partial acknowledgement is never made (`notes-mismatch`) and a
 * crash after the acknowledgement duplicates no entry. Call it at the receipt seam and again at the completed-result seam (it is
 * idempotent). An attempt that never reached the engine is `not-received`: the notes stay owed.
 */
export async function noteDelivered(store: StoreLike, ack: { execution: string; notes: { move: string; body: string }[] }): Promise<NoteDeliveredAnswer> {
  const [row] = await store.sql`select hub_move_note_delivered(${ack.execution}, ${JSON.stringify(ack.notes)}::text::jsonb) as answer`;
  return row.answer as NoteDeliveredAnswer;
}
