import type { StoreLike } from "../store/connect.ts";
import { chainOf, currentInputs, omittedFor } from "./reconcile.ts";
import {
  eventsOf, membersOf, participantsOf, readCouncil,
  type CouncilRow, type Lifecycle, type MemberCause, type MemberRow, type ParticipantRow, type Route,
} from "./rows.ts";

/**
 * What a council is right now, read from its rows and from the jobs, attempts and waits behind
 * them, and from nothing a model wrote. The card, the notices, the tool's `inspect` and `check`
 * all say the same thing because they read this.
 *
 * QUEUED, WAITING, RUNNING AND QUIET ARE FOUR THINGS, and only the store's own facts tell them
 * apart: a job nobody has claimed is queued, and when the runner that would take it is not there
 * it is waiting for its machine, when the runner wrote down that no slot or no memory is free it
 * is waiting for capacity, and when an attempt was launched and the loop has shown activity it
 * is running. A running member with no activity for the quiet threshold is QUIET, which is an
 * observation about output and a flag that clears the moment output resumes: it is still running,
 * and nothing here says it failed. Only a member with a named cause (an interrupted attempt, a
 * refusal) is missing.
 */

export type Stage =
  | "workers-running" | "waiting-machine" | "waiting-capacity" | "waiting-master" | "assessing-next-round"
  | "preparing-result" | "waiting-owner" | "stopping" | "stopped" | "complete";

export type MemberView =
  | "queued" | "waiting-machine" | "waiting-capacity" | "waiting-retry" | "starting" | "running" | "quiet"
  | "answered" | "missing" | "cancelled" | "correcting" | "stopping" | "stopped" | "omitted";

export interface MemberSnapshot {
  participant: string;
  ordinal: number;
  name: string;
  view: MemberView;
  round: number;
  input_revision: number;
  cause: MemberCause | null;
  /** The last activity the loop itself reported, or null when none was seen. */
  activity_at: string | null;
  activity: string | null;
  /** How long this attempt has been running, when there is one. */
  running_seconds: number | null;
  attempt: string | null;
  wait: Record<string, unknown> | null;
  /** How many outputs of earlier inputs of this participant are kept as superseded. */
  superseded: number;
}

export interface CouncilSnapshot {
  id: string;
  label: string;
  person: string;
  route: Route;
  lifecycle: Lifecycle;
  stage: Stage;
  origin_kind: CouncilRow["origin_kind"];
  legacy: boolean;
  round: number;
  question_revision: number;
  epoch: number;
  elapsed_seconds: number;
  answered: number;
  required: number;
  omitted: number;
  members: MemberSnapshot[];
  waiting: CouncilRow["waiting"];
  checkpoint: { reached: boolean; deadline: string; extension: boolean };
  /** What the master is doing about the council right now, when it has been handed one. */
  master: "idle" | "working" | "interrupted" | null;
  pending_event: boolean;
}

export interface SnapshotOptions {
  now: Date;
  /** Seconds without observed output after which a running member is flagged quiet. */
  quietSeconds: number;
}

const LABEL_CAP = 80;

/** A short label for the question: its first line, cut at a word, so two councils can be told apart. */
export function labelOf(question: string): string {
  const line = (question.split("\n").find(one => one.trim() !== "") ?? "").trim();
  if (line.length <= LABEL_CAP) return line;
  const cut = line.slice(0, LABEL_CAP);
  const at = cut.lastIndexOf(" ");
  return (at > LABEL_CAP / 2 ? cut.slice(0, at) : cut) + "…";
}

async function runnerLive(store: StoreLike, runner: string): Promise<boolean> {
  const [row] = (await store.sql`select exists (select 1 from pg_stat_activity
    where datname = current_database() and application_name = ${runner}) as live`) as unknown as { live: boolean }[];
  return Boolean(row?.live);
}

const RUNNING = ["received", "running"];
const STARTING = ["claimed", "feed_intent"];
const UNSETTLED = ["unknown", "stop_requested", "stop_unknown"];

async function openView(store: StoreLike, participant: ParticipantRow, member: MemberRow, options: SnapshotOptions): Promise<Pick<MemberSnapshot, "view" | "activity_at" | "activity" | "running_seconds" | "attempt" | "wait">> {
  const none = { activity_at: null, activity: null, running_seconds: null, attempt: null, wait: null };
  if (member.state === "superseding") return { ...none, view: "correcting" };
  if (member.state === "stopping") return { ...none, view: "stopping" };
  if (member.inbound_id === null) return { ...none, view: "queued" };
  const chain = await chainOf(store, member.inbound_id);
  const job = chain[chain.length - 1];
  const [row] = (await store.sql`select claimed_by, retry_at from inbound where id = ${job}`) as unknown as { claimed_by: string | null; retry_at: Date | null }[];
  const [attempt] = (await store.sql`select id, state, started_at from execution where inbound_id = ${job} order by started_at desc, id limit 1`) as unknown as
    { id: string; state: string; started_at: Date }[];
  const [progress] = (await store.sql`select data from state_row where sheet = 'turn_progress' and id = ${job}`) as unknown as { data: { activity_at?: string; activity?: string; last_action?: string } }[];
  if (attempt && RUNNING.includes(attempt.state)) {
    const at = progress?.data.activity_at ?? null;
    const silent = at !== null ? (options.now.getTime() - Date.parse(at)) / 1000 : (options.now.getTime() - new Date(attempt.started_at).getTime()) / 1000;
    return { view: silent > options.quietSeconds ? "quiet" : "running", activity_at: at, activity: progress?.data.last_action ?? progress?.data.activity ?? null,
      running_seconds: Math.max(0, Math.round((options.now.getTime() - new Date(attempt.started_at).getTime()) / 1000)), attempt: attempt.id, wait: null };
  }
  if (attempt && (STARTING.includes(attempt.state) || row?.claimed_by)) return { ...none, view: "starting", attempt: attempt?.id ?? null };
  if (attempt && UNSETTLED.includes(attempt.state)) return { ...none, view: "stopping", attempt: attempt.id };
  if (!attempt && row?.claimed_by) return { ...none, view: "starting" };
  if (row?.retry_at && new Date(row.retry_at).getTime() > options.now.getTime()) {
    const [health] = (await store.sql`select data from state_row where sheet = 'agent_health' and id = ${participant.worker_agent}`) as unknown as { data: Record<string, unknown> }[];
    return { ...none, view: "waiting-retry", wait: { kind: "retry", at: new Date(row.retry_at).toISOString(), ...(health ? { cause: health.data.cause ?? null } : {}) } };
  }
  const [wait] = (await store.sql`select data from state_row where sheet = 'agent_wait' and id = ${participant.worker_agent}`) as unknown as { data: Record<string, unknown> }[];
  if (wait && (wait.data.kind === "slots" || wait.data.kind === "memory")) return { ...none, view: "waiting-capacity", wait: wait.data };
  if (participant.runner !== null && !(await runnerLive(store, participant.runner))) {
    return { ...none, view: "waiting-machine", wait: { kind: "machine", machine: participant.machine, runner: participant.runner } };
  }
  return { ...none, view: "queued" };
}

/** The stage a council is in, from its lifecycle, its members and what the master is doing. Pure. */
export function stageOf(lifecycle: Lifecycle, views: readonly MemberView[], master: CouncilSnapshot["master"]): Stage {
  switch (lifecycle) {
    case "complete": return "complete";
    case "stopped": return "stopped";
    case "stopping": return "stopping";
    case "preparing_result": return "preparing-result";
    case "waiting_owner": return "waiting-owner";
    case "waiting_master": return "waiting-master";
    case "assessing": return master === "working" ? "assessing-next-round" : "waiting-master";
    default: {
      const open = views.filter(one => !["answered", "missing", "cancelled", "stopped", "omitted"].includes(one));
      if (open.length > 0 && open.every(one => one === "waiting-capacity")) return "waiting-capacity";
      if (open.length > 0 && open.every(one => one === "waiting-machine" || one === "waiting-capacity")) return "waiting-machine";
      return "workers-running";
    }
  }
}

async function masterState(store: StoreLike, council: CouncilRow): Promise<CouncilSnapshot["master"]> {
  let attempt: string | null = null;
  if (council.lifecycle === "preparing_result") attempt = council.finalize?.attempt ?? null;
  else if (council.lifecycle === "assessing") {
    const [consumed] = (await store.sql`select consumed_attempt from council_event where council_id = ${council.id} and consumed_attempt is not null
      order by consumed_at desc, seq desc limit 1`) as unknown as { consumed_attempt: string }[];
    attempt = consumed?.consumed_attempt ?? null;
  }
  if (attempt === null) return null;
  const [row] = (await store.sql`select state from execution where id = ${attempt}`) as unknown as { state: string }[];
  if (!row) return "interrupted";
  if ([...STARTING, ...RUNNING].includes(row.state)) return "working";
  if (row.state === "completed") return "idle";
  return "interrupted";
}

/** Read the council as it is. Null when there is no such council. */
export async function readSnapshot(store: StoreLike, id: string, options: SnapshotOptions): Promise<CouncilSnapshot | null> {
  const council = await readCouncil(store, id);
  if (!council) return null;
  const participants = await participantsOf(store, id);
  const members = await membersOf(store, id);
  const omitted = await omittedFor(store, council);
  const inputs = currentInputs(council, participants, members);
  const views: MemberSnapshot[] = [];
  for (const { participant, member } of inputs) {
    const earlier = members.filter(one => one.participant_id === participant.id && one.state === "superseded").length;
    const base = { participant: participant.id, ordinal: participant.ordinal, name: participant.worker_agent, round: member.round,
      input_revision: member.input_revision, cause: member.cause, superseded: earlier };
    if (omitted.has(participant.id)) {
      views.push({ ...base, view: "omitted", activity_at: null, activity: null, running_seconds: null, attempt: null, wait: null });
      continue;
    }
    if (member.state === "answered") views.push({ ...base, view: "answered", activity_at: null, activity: null, running_seconds: null, attempt: null, wait: null });
    else if (member.state === "missing") views.push({ ...base, view: "missing", activity_at: null, activity: null, running_seconds: null, attempt: null, wait: null });
    else if (member.state === "cancelled") views.push({ ...base, view: "cancelled", activity_at: null, activity: null, running_seconds: null, attempt: null, wait: null });
    else if (member.state === "stopped") views.push({ ...base, view: "stopped", activity_at: null, activity: null, running_seconds: null, attempt: null, wait: null });
    else views.push({ ...base, ...(await openView(store, participant, member, options)) });
  }
  const master = await masterState(store, council);
  const events = await eventsOf(store, id);
  const live = views.filter(one => one.view !== "omitted");
  return {
    id: council.id,
    label: labelOf(council.question),
    person: council.person,
    route: council.return_route,
    lifecycle: council.lifecycle,
    stage: stageOf(council.lifecycle, live.map(one => one.view), master),
    origin_kind: council.origin_kind,
    legacy: council.origin_kind === "legacy",
    round: council.current_round,
    question_revision: council.question_revision,
    epoch: council.epoch,
    elapsed_seconds: Math.max(0, Math.round((options.now.getTime() - new Date(council.epoch_started_at).getTime()) / 1000)),
    answered: live.filter(one => one.view === "answered").length,
    required: live.length,
    omitted: views.length - live.length,
    members: views,
    waiting: council.waiting,
    checkpoint: { reached: options.now.getTime() > new Date(council.checkpoint_deadline).getTime(), deadline: new Date(council.checkpoint_deadline).toISOString(),
      extension: council.extension !== null },
    master,
    pending_event: events.some(one => one.consumed_at === null),
  };
}
