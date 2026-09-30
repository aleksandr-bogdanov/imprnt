import type { StoreLike } from "../store/connect.ts";

/**
 * A council as the store holds it, and the few reads and writes everything else is
 * built on. Every function takes a `StoreLike`, so a caller hands it its own
 * transaction and what has to commit together (a member's outcome, the council's
 * lifecycle, the event the master reads) commits together.
 *
 * NOTHING HERE DECIDES ANYTHING. What a member's state is, when a round is complete
 * and what the owner has to choose are `reconcile.ts`'s; who may ask for what is the
 * tool's. This file only reads rows into types and moves a council's columns, and every
 * move of a council bumps its `revision`, which is what `expected_revision` is
 * compared with.
 */

export type Lifecycle =
  | "running" | "waiting_master" | "assessing" | "preparing_result"
  | "waiting_owner" | "stopping" | "stopped" | "complete";

/** A council the owner has nothing more to wait for, until they ask for a follow-up. */
export const TERMINAL: readonly Lifecycle[] = ["complete", "stopped"];

export type MemberState =
  | "open" | "answered" | "missing" | "cancelled" | "superseding" | "superseded" | "stopping" | "stopped";

/** Where a council speaks and where its reply is delivered: pinned when it is made, never re-derived. */
export interface Route { agent: string; door: string; chat: string }

export interface CouncilRow {
  id: string;
  person: string;
  agent: string;
  master_conversation: string | null;
  origin_kind: "owner_request" | "proposal" | "legacy";
  origin: Record<string, unknown>;
  return_route: Route;
  operation_id: string;
  parent_job: string | null;
  question: string;
  question_revision: number;
  roster_revision: number;
  context: { text: string }[];
  debate_opt_in: { kind: string; source_message_ids?: string[]; confirmation?: string; at: string } | null;
  lifecycle: Lifecycle;
  waiting: { kind: string; members?: string[]; legacy?: boolean; [extra: string]: unknown } | null;
  current_round: number;
  epoch: number;
  epoch_started_at: Date;
  epoch_authority: Record<string, unknown>;
  checkpoint_deadline: Date;
  extension: { kind: "rounds" | "minutes"; at: string; source_message_ids: string[]; rounds_left?: number; minutes?: number } | null;
  finalize: { attempt: string; inbound: string | null; at: string; mode: "all" | "use_available"; omitted: string[] } | null;
  result: Record<string, unknown> | null;
  status_effect_key: string;
  status_stage: string | null;
  status_at: Date | null;
  revision: number;
  legacy_of: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ParticipantRow {
  id: string;
  council_id: string;
  ordinal: number;
  worker_agent: string;
  preset_name: string | null;
  preset_id: string | null;
  preset_snapshot: Record<string, unknown>;
  /** The normalized effective profile accepted with the participant (`profile.ts`), and its digest. Empty and null for a seat of the earlier design. */
  profile: Record<string, unknown>;
  profile_id: string | null;
  machine: string | null;
  runner: string | null;
  brief: string;
  required: boolean;
  state: "active" | "replaced";
  replaces: string | null;
  first_inbound: string | null;
  worker_conversation: string | null;
  roster_revision: number;
}

export interface RoundRow {
  council_id: string;
  round: number;
  kind: "independent" | "debate" | "follow_up";
  question_revision: number;
  epoch: number;
  evidence: Record<string, unknown>;
  state: "running" | "complete" | "stopped";
  created_at: Date;
  completed_at: Date | null;
}

export interface MemberRow {
  council_id: string;
  round: number;
  participant_id: string;
  input_revision: number;
  question_revision: number;
  inbound_id: string | null;
  state: MemberState;
  cause: MemberCause | null;
  awaiting: Record<string, unknown> | null;
  report_id: string | null;
  valid_for_revision: number | null;
  supersedes: number | null;
  answered_at: Date | null;
  created_at: Date;
}

/** Why a member cannot be waited for. `kind` is one of `CAUSE_KINDS` in `causes.ts`. */
export interface MemberCause { kind: string; attempt?: string; hold_revision?: number; detail?: string | null; legacy?: boolean; [extra: string]: unknown }

export interface EventRow {
  council_id: string;
  seq: number;
  kind: "round_complete" | "member_missing" | "round_stalled";
  dedupe_key: string;
  inbound_id: string;
  ready_at: Date;
  provenance: Record<string, unknown>;
  consumed_at: Date | null;
  consumed_attempt: string | null;
  disposition: string | null;
}

export interface DecisionRow {
  council_id: string;
  seq: number;
  kind: string;
  conversation_id: string;
  request_key: string;
  operation_id: string;
  sources: string[];
  by_sender: string | null;
  attempt: string | null;
  payload: Record<string, unknown>;
  at: Date;
}

const COUNCIL = `id, person, agent, master_conversation, origin_kind, origin, return_route, operation_id, parent_job, question,
  question_revision, roster_revision, context, debate_opt_in, lifecycle, waiting, current_round, epoch, epoch_started_at,
  epoch_authority, checkpoint_deadline, extension, finalize, result, status_effect_key, status_stage, status_at, revision,
  legacy_of, created_at, updated_at, completed_at`;
const PARTICIPANT = `id, council_id, ordinal, worker_agent, preset_name, preset_id, preset_snapshot, profile, profile_id, machine, runner, brief, required,
  state, replaces, first_inbound, worker_conversation, roster_revision`;
const ROUND = "council_id, round, kind, question_revision, epoch, evidence, state, created_at, completed_at";
const MEMBER = `council_id, round, participant_id, input_revision, question_revision, inbound_id, state, cause, awaiting, report_id,
  valid_for_revision, supersedes, answered_at, created_at`;
const EVENT = "council_id, seq, kind, dedupe_key, inbound_id, ready_at, provenance, consumed_at, consumed_attempt, disposition";
const DECISION = "council_id, seq, kind, conversation_id, request_key, operation_id, sources, by_sender, attempt, payload, at";

type Raw = Record<string, unknown>;

/** The council, or null. `lock` takes the row for update, which is how two reconcilers and a tool call take turns on one council. */
export async function readCouncil(store: StoreLike, id: string, options: { lock?: boolean } = {}): Promise<CouncilRow | null> {
  const [row] = (await store.sql.unsafe(`select ${COUNCIL} from council where id = $1${options.lock ? " for update" : ""}`, [id])) as unknown as CouncilRow[];
  return row ?? null;
}

/** When the council was made, as PostgreSQL holds it (microseconds; a `Date` keeps milliseconds), for a comparison the database makes (`Since` in `mcp/requests.ts`). */
export async function createdAtOf(store: StoreLike, id: string): Promise<string> {
  const [row] = (await store.sql`select created_at::text as at from council where id = ${id}`) as unknown as { at: string }[];
  return row.at;
}

export async function participantsOf(store: StoreLike, council: string): Promise<ParticipantRow[]> {
  return (await store.sql.unsafe(`select ${PARTICIPANT} from council_participant where council_id = $1 order by ordinal`, [council])) as unknown as ParticipantRow[];
}

export async function participantOf(store: StoreLike, id: string): Promise<ParticipantRow | null> {
  const [row] = (await store.sql.unsafe(`select ${PARTICIPANT} from council_participant where id = $1`, [id])) as unknown as ParticipantRow[];
  return row ?? null;
}

export async function roundsOf(store: StoreLike, council: string): Promise<RoundRow[]> {
  return (await store.sql.unsafe(`select ${ROUND} from council_round where council_id = $1 order by round`, [council])) as unknown as RoundRow[];
}

export async function membersOf(store: StoreLike, council: string, round?: number): Promise<MemberRow[]> {
  return (await store.sql.unsafe(`select ${MEMBER} from round_member where council_id = $1${round === undefined ? "" : " and round = $2"}
    order by round, participant_id, input_revision`, round === undefined ? [council] : [council, round])) as unknown as MemberRow[];
}

export async function eventsOf(store: StoreLike, council: string): Promise<EventRow[]> {
  return (await store.sql.unsafe(`select ${EVENT} from council_event where council_id = $1 order by seq`, [council])) as unknown as EventRow[];
}

export async function decisionsOf(store: StoreLike, council: string): Promise<DecisionRow[]> {
  return (await store.sql.unsafe(`select ${DECISION} from council_decision where council_id = $1 order by seq`, [council])) as unknown as DecisionRow[];
}

/** Columns a council move may set, by how each is bound. Anything else is a programming error. */
const JSON_COLUMNS = new Set(["context", "debate_opt_in", "waiting", "extension", "finalize", "result", "epoch_authority"]);
const PLAIN_COLUMNS = new Set(["lifecycle", "current_round", "epoch", "question", "question_revision", "roster_revision", "status_stage", "master_conversation"]);
const TIME_COLUMNS = new Set(["epoch_started_at", "checkpoint_deadline", "completed_at", "status_at"]);

export type CouncilPatch = Partial<Record<string, unknown>>;

/**
 * Move a council, and its `revision` with it. `bump: false` is for the door's own
 * bookkeeping of what it last showed, which is not a decision-relevant change and must not
 * make a tool caller's `expected_revision` stale (nor wake the door that wrote it).
 */
export async function patchCouncil(store: StoreLike, id: string, patch: CouncilPatch, options: { bump?: boolean } = {}): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [column, value] of Object.entries(patch)) {
    values.push(JSON_COLUMNS.has(column) ? (value === null || value === undefined ? null : JSON.stringify(value)) : value instanceof Date ? value.toISOString() : value ?? null);
    const at = `$${values.length}`;
    // JSON and times travel as TEXT and are parsed by the statement: a `jsonb` parameter given a string
    // lands as a jsonb string, not the record (see `store/conversations.ts`).
    if (JSON_COLUMNS.has(column)) sets.push(`${column} = ${at}::text::jsonb`);
    else if (TIME_COLUMNS.has(column)) sets.push(`${column} = ${at}::text::timestamptz`);
    else if (PLAIN_COLUMNS.has(column)) sets.push(`${column} = ${at}`);
    else throw new TypeError(`a council does not move its ${column} this way`);
  }
  if (options.bump !== false) sets.push("revision = revision + 1");
  sets.push("updated_at = now()");
  await store.sql.unsafe(`update council set ${sets.join(", ")} where id = $1`, values as never[]);
}

/** Move one member's input. Only the columns a member's transitions write. */
export async function patchMember(
  store: StoreLike,
  key: { council: string; round: number; participant: string; input_revision: number },
  patch: { state?: MemberState; cause?: MemberCause | null; awaiting?: Record<string, unknown> | null; report_id?: string | null;
    valid_for_revision?: number | null; answered_at?: Date | null; inbound_id?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [key.council, key.round, key.participant, key.input_revision];
  const bind = (column: string, value: unknown, cast = "") => { values.push(value); sets.push(`${column} = $${values.length}${cast}`); };
  if (patch.state !== undefined) bind("state", patch.state);
  if (patch.cause !== undefined) bind("cause", patch.cause === null ? null : JSON.stringify(patch.cause), "::text::jsonb");
  if (patch.awaiting !== undefined) bind("awaiting", patch.awaiting === null ? null : JSON.stringify(patch.awaiting), "::text::jsonb");
  if (patch.report_id !== undefined) bind("report_id", patch.report_id);
  if (patch.valid_for_revision !== undefined) bind("valid_for_revision", patch.valid_for_revision);
  if (patch.answered_at !== undefined) bind("answered_at", patch.answered_at === null ? null : patch.answered_at.toISOString(), "::text::timestamptz");
  if (patch.inbound_id !== undefined) bind("inbound_id", patch.inbound_id);
  if (sets.length === 0) return;
  sets.push("updated_at = now()");
  await store.sql.unsafe(`update round_member set ${sets.join(", ")}
    where council_id = $1 and round = $2 and participant_id = $3 and input_revision = $4`, values as never[]);
}

/**
 * One line in the council's decision record: who decided what, on which messages, from which
 * attempt. Numbered under the council row lock the caller holds, so the numbering has no gap and
 * a replay of the same operation and kind lands nothing twice. Returns whether it is new.
 */
export async function recordDecision(
  store: StoreLike,
  decision: { council: string; kind: string; conversation: string; request_key: string; operation: string; sources: readonly string[];
    by: string | null; attempt: string | null; payload: Record<string, unknown> },
): Promise<boolean> {
  const landed = await store.sql`insert into council_decision (council_id, seq, kind, conversation_id, request_key, operation_id, sources, by_sender, attempt, payload)
    values (${decision.council}, (select coalesce(max(seq), 0) + 1 from council_decision where council_id = ${decision.council}),
            ${decision.kind}, ${decision.conversation}, ${decision.request_key}, ${decision.operation},
            ${JSON.stringify(decision.sources)}::text::jsonb, ${decision.by}, ${decision.attempt}, ${JSON.stringify(decision.payload)}::text::jsonb)
    on conflict (operation_id, kind) do nothing returning seq`;
  return landed.length > 0;
}

/**
 * The participant's conversation: the one its first job made, found by that job, or by any of
 * the jobs it was later given (a correction of a job nobody had started is a new first job).
 * Null until a worker has claimed one of them. It is written back to the participant once seen.
 */
export async function conversationOfParticipant(store: StoreLike, participant: ParticipantRow): Promise<string | null> {
  if (participant.worker_conversation !== null) return participant.worker_conversation;
  const [found] = (await store.sql`select c.id from conversation c
    where c.kind = 'worker' and c.owner_ref in (
      select m.inbound_id from round_member m where m.participant_id = ${participant.id} and m.inbound_id is not null)
    order by c.created_at limit 1`) as unknown as { id: string }[];
  if (!found) return null;
  await store.sql`update council_participant set worker_conversation = ${found.id} where id = ${participant.id} and worker_conversation is null`;
  return found.id;
}
