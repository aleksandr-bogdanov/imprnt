import { erasureFence } from "../erasure/startup.ts";
import { executeHarvest } from "../harvest/execute.ts";
import { watchControls } from "../hub/control.ts";
import { prepareReply } from "../door/reply.ts";
import type { InboundSource } from "../store/inbound.ts";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { bootId, descendantsOf } from "../os/tree.ts";
import { adapterFor, loopLaunch } from "../adapters/index.ts";
import { AdapterMissing, FeedNotWritten, NativeRefusal, type Adapter, type AdapterSession, type ExitEvidence, type TurnEnd } from "../adapters/types.ts";
import { credentialSource, type HubMcpServer } from "../adapters/launch.ts";
import { boxContextFor } from "../box/index.ts";
import { readTail, withBackground } from "../chatlog.ts";
import { deriveTail } from "../chatlog/derive.ts";
import { SAID_CAP } from "../harvest/parse.ts";
import { thisOs } from "../os/index.ts";
import { appendEntry, type NewEntry } from "../records/diary.ts";
import { putRow, readSheet, removeRow } from "../records/statesheet.ts";
import { stamp } from "../records/stamps.ts";
import {
  agentRetry,
  catchUpNotice,
  outageNotice,
  windowNotice,
  type Language,
  finding,
  safeValue,
} from "../door/lines.ts";
import {
  agentsFor,
  chatStateFor,
  lifetimeFor,
  runnerAdmission,
  languageOf,
  listAgents,
  listRunEntries,
  noticeRoute,
} from "../registry/entries.ts";
import { entryMachine, loadRegistry, readSetting, registryDigest, type AgentEntry, type Registry } from "../registry/load.ts";
import { registryStanding } from "../hub/digest.ts";
import { materializeMedia, rewriteMediaPaths } from "../store/media.ts";
import { waitRecorder, type AgentWait } from "./waiting.ts";
import {
  credentialOfPreset,
  getPreset,
  presetId,
  priceFor,
  windowThresholds,
  type Preset,
  type WindowThresholds,
} from "../registry/presets.ts";
import { openStore, type Store } from "../store/connect.ts";
import { noteDelivered, readMove } from "../store/moves.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { appendNotice } from "../store/outbox.ts";
import { openWorkWaiter, type EligibleRow, type Waiter } from "../store/wake.ts";
import { claimNext } from "./claim.ts";
import { taskDigest } from "../door/dispatch.ts";
import { recoveryContext } from "../recovery/holds.ts";
import {
  ConversationRefused,
  ExecutionBusy,
  ExecutionNotOwned,
  MoveGated,
  MoveNoteRefused,
  activateProtocol,
  conversationFor,
  hasEntry,
  journalResult,
  markFeedIntent,
  markLaunched,
  markProgress,
  mintNativeSession,
  noteEffects,
  noteExecution,
  noteNative,
  notePids,
  openExecution,
  openHoldsOf,
  readExecution,
  recordEntry,
  registerIncarnation,
  verifyNative,
  type Conversation,
  type ExecutionRow,
} from "../store/conversations.ts";
import {
  capabilityReader,
  endAttempt,
  hasContextsToMeasure,
  markContextPending,
  markedWatch,
  reconcileContexts,
  reconcileExecutions,
  reevaluateUnknown,
  requireSchema,
  settleStored,
  RUNNER_PROTOCOL,
  type EngineReading,
  type Here,
} from "./execution.ts";
import { bindFacade, type FacadeBinding } from "./ipc.ts";
import { checkLaunch, launchProfileOf } from "../council/launch.ts";
import { admitOnce } from "./admission.ts";
import { councilOfJob, fenceAbandonedClaims, noteJobFailed, sweepAbandonedClaims } from "./council.ts";
import { admitJob, refuseJob } from "./job.ts";
import { clearProgress, writeProgress, type TurnProgress } from "./progress.ts";
import { watchStops } from "./stops.ts";
import {
  SpawnFenced,
  createFences,
  createLedger,
  digestOf,
  drainSource,
  handBackFeed,
  placementOf,
  settleSet,
  watchMoves,
  type ChildRecord,
  type DrainStep,
  type DrainWorld,
  type MoveWatch,
  type Owed,
} from "./move.ts";
import { effectiveConfigOf, moveConfigDrift } from "./move-config.ts";
import { exportSource } from "./move-export.ts";
import { ENGINE_RECHECK, MOVE_NATIVE_LIMITS, probedEngine, waiting as handoffWaiting, type EngineBuild, type HandoffStep, type HandoffWorld } from "./move-handoff.ts";
import { DEST_GATE_CODES, cleanupCopies, importDestination, prepareDestination } from "./move-import.ts";
import { importedBy, noteBlock, notesOwedTo, type CarriedNote } from "./move-note.ts";
import { profileOf } from "./move-profile.ts";
import { defaultInstructionsOf, localShapeOf, scopeOf } from "./move-scope.ts";
import { serveDestination, type ServeWorld } from "./move-serve.ts";
import { observeDest, observeSource, workspaceFactsOf } from "./move-workspace.ts";
import {
  clearOutage,
  classifyRefusal,
  readOutage,
  maxRankFor,
  noticeKey,
  openOutage,
  percentOf,
  readingStands,
  readWindow,
  recordWindow,
  type WindowRow,
} from "./outage.ts";
import {
  refuseTurn,
  settleTurn,
  type TurnRecord,
} from "./settle.ts";

export interface RunnerHandle {
  runner: string;
  stop(): Promise<void>;
  recoverAgent(request: { id: string; agent: string }): Promise<void>;
  /**
   * Stop the attempt an agent is running, on request and for nothing else:
   * ask its processes to end, end what is left after the grace, and say what is
   * proved. `stopped` is only ever the answer when the loop and everything last
   * seen under it are gone; a process that cannot be shown to have left is
   * `stop_unknown`, and its input stays held either way. Nothing is undone and
   * nothing is retried. With `execution` it stops that attempt or nothing (`none`):
   * a request frozen to one attempt never reaches a newer one. An attempt that is
   * only claimed, not yet fed, is `opening`: nothing is signalled (the resident
   * session that may be there is not its own yet) and it is asked again once fed.
   */
  stopExecution(request: { agent: string; execution?: string; graceMs?: number }): Promise<{ state: string; revision: number | null }>;
}

/**
 * One agent this runner is serving right now.
 *
 * The set is reconciled on the tick, so adding an agent to the registry
 * starts its loop and removing one stops it, with no restart and without
 * touching the others. The reconcile is its own loop rather than something
 * inside an agent's, because one that lived inside `runAgent` would never run
 * on a runner that has no agents yet and would never notice the first one
 * added. It reads the FILE and issues no SQL, which is what keeps the runner's
 * wait a wait: `test/runner-drain.test.ts` counts zero statements in it.
 */
interface Live {
  agent: AgentEntry;
  reserved: boolean;
  /** The loop the agent is talking to, for the memory watch to read and kill. */
  session: AdapterSession | null;
  /** The watch killed this child, so the next turn starts a new session first. */
  killed: boolean;
  /**
   * The loop was spawned INSIDE a box, so `session.pid` is the box tool's and
   * the loop is somewhere below it. What the memory watch must read is not the
   * pid it holds.
   */
  boxed: boolean;
  /**
   * The conversation this child is bound to, and the native session it runs
   * under. A child is never fed an input of another conversation: a job's
   * context is its brief and its own transcript, not the last job's.
   */
  conversation: string | null;
  nativeSession: string | null;
  /** The open attempt, for an explicit stop to find. */
  attempt: ExecutionRow | null;
  /**
   * An explicit stop was ACCEPTED for one attempt on one session: the loop ending under it
   * is the stop, not a failure, and that session is never fed again. It names the attempt and
   * the session that attempt holds when the store's acceptance is seen (a fresh child is
   * installed while an opening attempt's stop is in flight, so that is read after the answer,
   * not before the question), and is set only once the attempt is shown to still be current,
   * so it can never describe a newer attempt or a replacement session, and nothing clears it
   * for another caller: a session that is not the one named is simply not retiring.
   * `evidence` is the one signal that was sent (a second caller for the same attempt never
   * signals again), and `done` is the ending that followed it, which a second caller waits on
   * and which is made again if it failed.
   */
  retiring: {
    execution: string;
    session: AdapterSession;
    evidence: Promise<ExitEvidence | null>;
    done: Promise<{ state: string; revision: number | null }>;
  } | null;
  /** The hub's tool facade bound to this child's launch, closed with it. */
  facade: FacadeBinding | null;
  /** The ledger's record of the child `session` is, which stays in the ledger after the session is let go of until the child is shown gone (`./move.ts`). */
  child: ChildRecord | null;
  /**
   * What the move watch has for this loop to do: taken at the top of the loop's own iteration, so it is sequential with the loop's
   * spawn, claim, feed and idle close and cannot race them. Nothing is queued once the loop is `ending`.
   */
  jobs: { run(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void }[];
  ending: boolean;
  /** Set by `nudge` and read by the loop's wait before it begins, so a nudge that came between two waits is not lost. */
  nudging: boolean;
  /** Resolves when something this loop waits on changed (a job was queued, a fence was lifted); replaced by each `nudge`. */
  nudged: Promise<void>;
  nudge(): void;
  leaving: boolean;
  /** Resolves when this agent alone is asked to leave. */
  left: Promise<"stopped">;
  release(): void;
  done: Promise<void>;
  /** Resolves once this agent's loop is up, or has given up trying. */
  serving: Promise<void>;
  settle(): void;
  /** What this agent is waiting on, written for the door to read, or cleared. */
  noteWait(wait: AgentWait | null): Promise<void>;
}

/** The turn that is open right now. One message per turn, never two. */
interface OpenTurn {
  id: string;
  person: string;
  agent: string;
  acked: boolean;
  started: boolean;
  /** What the loop has done so far, and when it started doing it. */
  actions: number;
  lastAction: string;
  startedAt: string;
  /** When the sheet was last written, for the throttle that is a TIME. */
  wroteAt: number;
  /**
   * The last event the LOOP reported, and when. Set only by what the adapter
   * says, never by a timer of the runner's, so a long silence stays visible as
   * one. It rides on the same throttled sheet write as the counts.
   */
  activityAt: string | null;
  activity: string;
  /** When the sheet was last written for an event that is not a tool start. */
  activityWroteAt: number;
  /**
   * What the loop reported since the sheet was last written, that the cadence did not
   * write, and the one timer that writes it when the cadence allows. The timer only
   * decides WHEN: the values it writes, the count and the moment of the last event, were
   * taken from adapter events as they arrived.
   */
  unwritten: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Set at the error cleanup boundary, before its first await. Events that are still
   * delivered after it are counted as evidence, and nothing of this turn is written to
   * the sheet again, so the row that cleanup clears is not made anew.
   */
  sealed: boolean;
  /**
   * The turn carries a relocation note, so it is the first on a moved conversation and its resume is not yet verified: no progress sheet is written
   * while it runs (the door would post a line for a turn that may then be refused), and the one write it makes is the last, after the check passed.
   */
  held: boolean;
  finish(end: TurnEnd): void;
}

/**
 * The platform an answer is cut for, read off the id of the row it answers.
 *
 * A person's message carries its platform at the front of its id. A report's
 * id is its job's with `report:` in front, and the job's own id carries the
 * platform of the chat the command was typed in, which is the return route the
 * report and the answer to it go back on. Read as the front of the report's
 * id, it would be the word `report`, and the answer would be cut at the shorter
 * limit on every platform.
 */
function answerPlatform(logId: string | undefined): string | undefined {
  if (logId === undefined) return undefined;
  const parts = logId.split(":");
  return parts[0] === "report" && parts[1] === "job" ? parts[2] : parts[0];
}

function setting(registry: Registry, key: string): number {
  return Number(readSetting(registry, key));
}

/**
 * How long a runner waits before it tries a refused credential again.
 * L10 rule 3's fixed interval, and v2's own was five minutes.
 */
function retrySeconds(registry: Registry): number {
  const said = readSetting(registry, "hub.outage_retry_seconds");
  return typeof said === "number" && said > 0 ? said : 300;
}

/** The open turn, as the sheet the door reads it off. */
function progressOf(open: {
  id: string;
  person: string;
  agent: string;
  actions: number;
  lastAction: string;
  startedAt: string;
  activityAt: string | null;
  activity: string;
}): TurnProgress {
  return {
    messageId: open.id,
    person: open.person,
    agent: open.agent,
    actions: open.actions,
    lastAction: open.lastAction,
    startedAt: open.startedAt,
    activityAt: open.activityAt,
    activity: open.activity,
  };
}

/** The credential this agent's outage is keyed by, from the agent in hand. */
function credentialFor(registry: Registry, agent: AgentEntry): string {
  return credentialOfPreset(registry, agent.preset) ?? `preset:${agent.preset}`;
}

/**
 * One line per PERSON, and the agent on the row is the FIRST agent of
 * that person, in registry order, whose preset resolves to this credential.
 *
 * Computed the same way by every runner, so two of them write one row between
 * them and the key never depends on which got there first. Per person and not
 * per agent, because a household-wide cause is one thing a person is told once
 * however many of their agents it stopped.
 */
function peopleOn(
  registry: Registry,
  credential: string,
): { person: string; agent: string }[] {
  const out: { person: string; agent: string }[] = [];
  for (const one of listAgents(registry)) {
    if (credentialFor(registry, one) !== credential) continue;
    if (out.some((row) => row.person === one.person)) continue;
    out.push({ person: one.person, agent: one.id });
  }
  return out;
}

/**
 * How many messages each person still has waiting, for the catch-up's own N.
 *
 * ONE statement over the rows that are not finished, counted in memory, because
 * the alternative is an array bound into the statement for a table that holds
 * what is in flight and nothing else.
 */
async function waitingPerPerson(
  store: Store,
  registry: Registry,
  credential: string,
): Promise<Map<string, number>> {
  const mine = new Set(
    listAgents(registry)
      .filter((one) => credentialFor(registry, one) === credential)
      .map((one) => one.id),
  );
  // A HELD input is not waiting for the credential: it was handed to the engine and did not finish, and
  // only its owner's choice moves it, so "it works again, N waiting" does not count it (nothing will
  // answer it by itself). It is told apart by its hold record and not by `hub_row_held`, which is also
  // true of the turn that is running right now.
  const rows = (await store.sql`select person, agent from inbound i
                                where state not in ('answered', 'delivered')
                                  and not exists (select 1 from replay_hold h where h.inbound_id = i.id)`) as unknown as {
    person: string;
    agent: string;
  }[];
  const count = new Map<string, number>();
  for (const row of rows) {
    if (!mine.has(row.agent)) continue;
    count.set(row.person, (count.get(row.person) ?? 0) + 1);
  }
  return count;
}

/**
 * ONE line, at connect, naming the server this runner really reached.
 *
 * The household's own check that two runners share one store
 * can observe one server and cannot rule out a second hidden one, because
 * `application_name` says who connected and nothing says WHERE. `initdb`
 * generates a `system_identifier` per cluster, so a runner that writes the one
 * it sees has said which cluster it is talking to in a way nothing on the
 * client side could have invented, and `check` compares it with the identifier
 * of the store IT is reading.
 *
 * It is stream `runner` and not `machine`, because `machine` is the hub's and
 * `ledger_event_hub_writes` fences it. It is ONE statement pair at connect,
 * which lands long before any wait window opens,
 * so a waiting runner still issues nothing at all.
 *
 * A RUNNER THAT COULD NOT READ THE IDENTIFIER SAYS WHY, and never writes an
 * empty one: an empty identifier is the one value `check` cannot tell from
 * a healthy runner, so a runner pointing at the wrong cluster would go on
 * saying nothing forever. The reason is written into the line instead, and
 * `check` reports the silence as a finding rather than skipping it. The read is
 * wrapped and the append is not: a runner that cannot write its connect line at
 * all is a runner whose store is refusing it, and that is not a thing to
 * swallow here.
 */
async function sayWhichServer(
  store: Store,
  registry: Registry,
  runner: string,
): Promise<void> {
  // `system_identifier` is a 64 bit value well past what a double holds, so it
  // crosses as text and is compared as text everywhere after this.
  let identifier = "";
  let version = "";
  let unreadable = "";
  try {
    const [server] = (await store.sql.unsafe(
      `select system_identifier::text as system_identifier, version() as server_version
         from pg_control_system()`,
    )) as { system_identifier: string; server_version: string }[];
    identifier = String(server?.system_identifier ?? "");
    version = String(server?.server_version ?? "");
    if (identifier === "") {
      unreadable = "the server answered pg_control_system() with no system_identifier";
    }
  } catch (error) {
    unreadable = `reading pg_control_system() failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  await appendEntry(store, {
    stream: "runner",
    subject: runner,
    kind: "connected",
    actor: "runner",
    detail: {
      system_identifier: identifier,
      server_version: version,
      machine: listRunEntries(registry).find((entry) => entry.id === runner)?.machine ?? "",
      ...(unreadable === "" ? {} : { identifier_error: unreadable }),
    },
  });
}

/**
 * WHERE A CONVERSATION'S SESSION LIVES ON THIS MACHINE: the one rule, used by the launch below and by a move's export, import and cleanup
 * (`move-export.ts`, `move-import.ts`), so that what a handoff writes or removes is the directory a launch would use and never another.
 */
export function sessionDirFor(stateDir: string, person: string, agent: string, conversation: string): string {
  return join(stateDir, person, "sessions", agent, conversation);
}

/**
 * Configuration and filesystem work happen only when a session starts.
 *
 * THE SESSION DIRECTORY BELONGS TO THE CONVERSATION and not to the child: the
 * engine keeps its config, home and transcript there, so a child started again
 * for the same conversation resumes what the last one wrote. It used to be a
 * fresh directory per start, which is what made every start a stranger.
 * Transient output of one attempt does not go into it.
 */
async function launchFor(registry: Registry, agent: AgentEntry, presetName: string, purpose: "ordinary" | "harvest" | "triage",
  conversation: Conversation, hubMcp?: HubMcpServer) {
  const stateDir = String(readSetting(registry, "hub.state_dir") ?? "");
  const credential = credentialOfPreset(registry, presetName);
  return loopLaunch({ registry, agent, preset: getPreset(registry, presetName), purpose,
    ...(credential ? { credential: credentialSource(registry, presetName) } : {}),
    sessionDir: sessionDirFor(stateDir, agent.person, agent.id, conversation.id),
    box: boxContextFor(registry, agent.id),
    ...(hubMcp ? { hubMcp } : {}),
  });
}

/**
 * The runner: it claims a message, feeds it to a loop through the five-verb
 * seam, stamps what the loop reports, and settles the reply in one transaction.
 *
 * It is handed its adapters rather than importing them, so it can drive a loop
 * registered under a name no build could have enumerated, and it branches on
 * nothing but that map.
 */
export async function runRunner(options: {
  runner: string;
  registryFile: string;
  adapters: Record<string, Adapter>;
}): Promise<RunnerHandle> {
  // The file is read FOR THIS RUNNER'S MACHINE, every time it is read. Its
  // entry says which machine that is, and the view the loader hands back
  // carries that machine's own state directory, secrets and store address, and
  // each person's tree and vault there, so a runner on a spoke keeps its
  // session state on its own disk and files into the vault checkout that is
  // there, with nothing below this line knowing the difference.
  const machine = entryMachine(options.registryFile, options.runner);
  const load = () => loadRegistry(options.registryFile, { machine });
  const first = load();
  // The memory reader for this platform. Nothing else of the seam is used here:
  // a model child is a child of its runner with no unit of its own (D7).
  const os = thisOs();
  const stateDir = String(readSetting(first, "hub.state_dir"));
  // Connecting is the read that surfaces the rows that waited while this runner
  // was down. The notifications they emitted are long gone, so nothing asks.
  const store: Store = await openStore({
    // The runner names itself to the server once, at connect, so a silent
    // runner is DERIVED from the server's own view of its clients and no
    // heartbeat is written on any tick.
    url: storeUrlFor(first, "hub_runner", options.runner),
  });
  await requireSchema(store);
  // A store restored from a copy older than a deletion this machine recorded is not served from: the hub brings it forward, and the
  // manager starts this process again after it.
  const erasureHold = await erasureFence(store, stateDir);
  if (erasureHold !== null) { await store.close().catch(() => {}); throw new Error(`erasure-behind: ${erasureHold}`); }
  await sayWhichServer(store, first, options.runner);

  let stopping = false;
  let release: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    release = () => resolve("stopped");
  });

  /**
   * THIS PROCESS, as a fact the store can hold attempts against. An attempt is
   * owned by a runner incarnation, so what an earlier incarnation left is not
   * this one's to assume anything about: it is reconciled below, before
   * anything is claimed, and never run again by machinery.
   */
  const incarnation = crypto.randomUUID();
  const capabilities = capabilityReader();
  // Where and in which boot this runs, recorded with every attempt's processes: a
  // machine that started again is the one thing that proves an earlier boot's
  // whole tree gone.
  const here: Here = { machine, boot: bootId() };
  /**
   * THE SOURCE'S SIDE OF A TOPIC MOVE (`./move.ts`). The fences are per agent and synchronous: a spawn, a claim and an idle close
   * of a fenced agent read them in the step that decides. The ledger holds, per agent, every child THIS incarnation may still have
   * (made before the adapter is asked, kept after it is closed until it is shown gone), which is what a `no-child` assertion and a
   * drain intent are made from. `moves` is the watch over the store's notifications, opened before anything is served.
   */
  const moveFences = createFences();
  const children = createLedger();
  let moves: MoveWatch | undefined;
  /**
   * ONE CHAIN PER CONVERSATION ID, shared by everything on this process that writes or removes the conversation's session directory: the
   * launch of a child (`spawn`), a move's import and the removal of an import's copy (`move-import.ts`). NOT re-entrant (a call from inside
   * its own callback waits for itself): each caller takes it once. A failure of one callback is its caller's and never stops the chain.
   */
  const exclusiveTails = new Map<string, Promise<void>>();
  const exclusive = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (exclusiveTails.get(key) ?? Promise.resolve()).then(() => fn());
    const tail = run.then(() => undefined, () => undefined);
    exclusiveTails.set(key, tail);
    void tail.then(() => { if (exclusiveTails.get(key) === tail) exclusiveTails.delete(key); });
    return run;
  };
  // The protocol is activated BEFORE this incarnation is registered as current: a
  // store that still holds inputs a runner of protocol 1 may have fed refuses it by
  // name, and a runner that could not start must not have fenced the one that can.
  try { await activateProtocol(store); } catch (error) { await store.close().catch(() => {}); throw error; }
  await registerIncarnation(store, { runner: options.runner, incarnation, machine, bootId: here.boot });
  await appendEntry(store, { stream: "runner", subject: options.runner, kind: "incarnation", actor: "runner",
    detail: { incarnation, protocol: RUNNER_PROTOCOL, machine, boot: here.boot } });
  /**
   * Whether this runner has results journaled and not yet settled, and so has
   * something to try again on its tick. A settle that failed on a transient error
   * is retried from the journal, never turned into an interruption.
   */
  // What was measured about a native context before this start is not shown as current: it was measured
  // on an engine and a configuration that may have changed, and it is measured again below.
  await markContextPending(store, options.runner);
  let watchJournal = (await reconcileExecutions(store, { runner: options.runner, incarnation, registry: first, here })) > 0;
  /** Moves every time something comes to be owed, so a look that began before it cannot switch the watch off. */
  let journalMark = 0;
  const owesJournal = (): void => { watchJournal = true; journalMark += 1; };
  /**
   * Whether this runner has attempts whose ownership is unresolved and so has
   * something to look at again on its tick. The tick issues no statement at all
   * while it is false, which is what keeps a waiting runner silent.
   */
  /**
   * Whether a terminal hold of this runner's attempts has a native context still to be measured, or one
   * that may have changed. Raised wherever a hold appears or moves, and when the engine's answer flips;
   * lowered by a full look that measured every hold. A waiting runner with none issues no statement.
   */
  const contextWatch = markedWatch(false);
  const unresolvedWatch = markedWatch(false);
  // Looked at before anything is served, exactly as before: a runner that starts finds what the last one
  // left. `moved` is a hold that was waiting on proof that the old attempt is over.
  if ((await reevaluateUnknown(store, { runner: options.runner, registry: first, here, moved: () => contextWatch.raise() })) > 0) unresolvedWatch.raise();
  if (await hasContextsToMeasure(store, options.runner)) contextWatch.raise();
  /** The engine an agent of this runner runs on, measured (a probe is waited for, the last answer stands within its window), or null when it cannot be read now. */
  const readingFor = async (agentId: string): Promise<EngineReading | null> => {
    try {
      const registry = load();
      const agent = agentsFor(registry, { runner: options.runner }).find(one => one.id === agentId);
      if (!agent) return null;
      const preset = getPreset(registry, agent.preset);
      const adapter = options.adapters[preset.adapter];
      if (!adapter) return null;
      const caps = await capabilities.get(adapter, { registry, agent, preset: agent.preset });
      return { caps, engine: `${preset.adapter}:${agent.preset}:${caps.version ?? "unversioned"}` };
    } catch { return null; }
  };

  const retries = new Map<string, number>();
  for (const row of await readSheet(store, "agent_health")) {
    const due = Date.parse(String(row.data.retry_at));
    if (Number.isFinite(due)) retries.set(row.id, due);
  }
  /**
   * Whether this runner's copy of the registry is behind the store machine's.
   * A stale spoke keeps the sessions it has and claims nothing new, because the
   * agents it would claim for are the ones the file it cannot see has moved.
   * Measured against the store machine's own digest on every tick.
   */
  let stale = false;
  let reservations = 0;
  let measuredBytes = 0;
  let peakBytes = 0;
  const capacity = new Set<() => void>();
  const harvestSessions = new Map<AdapterSession, Live>();
  const readings = new Map<AdapterSession, number>();
  let capacityVersion = 0;
  const capacityChanged = () => {
    capacityVersion++;
    for (const wake of capacity) wake();
    capacity.clear();
  };
  const releaseCapacity = () => {
    reservations--;
    measuredBytes = [...readings.values()].reduce((sum, bytes) => sum + bytes, 0);
    capacityChanged();
  };
  const appendRunnerEntry = async (entry: NewEntry): Promise<number> => {
    // Standalone writes share the pool with concurrent claims and waits.
    // Hold their connection until the returning row has been consumed too.
    const connection = await store.sql.reserve();
    try {
      return await appendEntry({ ...store, sql: connection as unknown as Store["sql"] }, entry);
    } finally { connection.release(); }
  };
  /** One diary line about a move, once per thing said: a look that finds the same again says nothing. */
  const movesSaid = new Set<string>();
  const sayMove = async (kind: string, detail: Record<string, unknown>): Promise<void> => {
    const key = `${kind}|${JSON.stringify(detail)}`;
    if (movesSaid.has(key)) return;
    movesSaid.add(key);
    await appendRunnerEntry({ stream: "runner", subject: options.runner, kind, actor: "runner", detail });
  };
  /**
   * THE ONE PLACE A CHILD IS CLOSED, so what becomes of it is never lost with the handle. The ledger's record is marked closing
   * before the close begins, and closed after it with what the adapter could prove: a close that resolved is not proof, a
   * session pointer that was cleared is not proof, and a child that was not shown gone stays owed. `strict` rethrows what the
   * close threw, for the one caller that never swallowed it.
   */
  const closeChild = async (record: ChildRecord, how: { strict?: boolean } = {}): Promise<ExitEvidence | null> => {
    if (record.phase === "closed") return record.exit;
    const session = record.session;
    if (!session) return record.exit;
    children.closing(record);
    readings.delete(session);
    let failure: unknown = null;
    await session.close().catch((error: unknown) => { failure = error ?? new Error("close failed"); });
    let evidence: ExitEvidence | null = null;
    try { evidence = session.exitEvidence ? await session.exitEvidence() : null; } catch { evidence = null; }
    children.closed(record, evidence, failure !== null && evidence === null ? "the close failed and the session gave no exit evidence" : null);
    if (failure !== null && how.strict) throw failure;
    return evidence;
  };
  /** What the move watch queued for this loop, run by the loop itself at a point where it is holding nothing. */
  const runMoveJobs = async (own: Live): Promise<void> => {
    own.nudging = false;
    while (own.jobs.length > 0) {
      const job = own.jobs.shift()!;
      try { job.resolve(await job.run()); } catch (error) { job.reject(error); }
    }
  };
  /** Run `run` inside this agent's loop: queued, the loop woken, and refused at once when the loop is ending. */
  const inLoop = <T>(it: Live, run: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (it.ending) { reject(Object.assign(new Error("loop-ended"), { loopEnded: true })); return; }
    it.jobs.push({ run, resolve: resolve as (value: unknown) => void, reject });
    it.nudge();
  });
  const admitChild = async (registry: Registry, own: Live, reserve = true): Promise<boolean> => {
    let recorded = false;
    while (!stopping && !own.leaving) {
      // A worker is not admitted into the room an active council's master needs on this runner (`council/capacity.ts`), once per master
      // however many councils it has. THE STORE IS ASKED FIRST and everything this runner knows about itself is read AFTER it answers, in the
      // one synchronous step that decides and reserves (`runner/admission.ts`): the limits (read again on every pass, because a registry edit that
      // raises the count or the budget is one of the things this wait is woken for), the children reserved, the memory measured and the masters that
      // already hold a slot. Nothing else about admission changes, and nothing is stopped to make room.
      const decision = await admitOnce({
        store, runner: options.runner, registry, admitting: own.agent,
        now: () => ({
          reservations, measuredBytes,
          limits: runnerAdmission(listRunEntries(load()).find(one => one.id === options.runner) ?? {}),
          resident: agent => live.get(agent)?.reserved === true,
        }),
        take: () => { reservations++; },
      }, reserve);
      if (decision.admitted) {
        if (recorded) await own.noteWait(null);
        return true;
      }
      const { held, roomByCount, usedMb, limits } = decision;
      const reserveMb = limits.reserve_mb;
      own.settle();
      if (!recorded) {
        recorded = true;
        await appendRunnerEntry({ stream: "runner", subject: own.agent.id, kind: "admission.wait", actor: "runner",
          detail: { cause: "admission", children: reservations, reserved_mb: reservations * reserveMb, peak_bytes: peakBytes } });
        continue;
      }
      // What blocks, for the door's line. A count that is full names who
      // holds the slots: every agent with a child reserved and every resident
      // whose harvest has one of its own. A budget that is full with slots to
      // spare is a different sentence, with the numbers.
      await own.noteWait(roomByCount
        ? { kind: "memory", budget_mb: limits.child_memory_budget_mb, used_mb: Math.round(usedMb), reserve_mb: reserveMb,
            ...(held.length > 0 ? { held_for_master: held.length } : {}) }
        : { kind: "slots", count: limits.max_active_children, holders: [...new Set([
            ...[...live.values()].filter(other => other.reserved && other !== own).map(other => other.agent.id),
            ...[...harvestSessions.values()].map(owner => owner.agent.id),
            ...held,
          ])], ...(held.length > 0 ? { held_for_master: held.length, ...(limits.admits <= held.length ? { conflict: true } : {}) } : {}) });
      // Woken by a child starting or being released, by the tick seeing a
      // changed limit or a fallen aggregate reading, and by the tick itself
      // as the bound: the re-check above is in memory and reads no table, so
      // the bound costs the store nothing and a runner whose slots are all
      // held by residents still asks again within a tick.
      let wake!: () => void;
      const available = new Promise<void>(resolve => { wake = resolve; capacity.add(wake); });
      try { await Promise.race([available, stopped, own.left, own.nudged, Bun.sleep(setting(registry, "hub.tick_seconds") * 1000)]); }
      finally { capacity.delete(wake); }
      // The loop is holding nothing while it waits for room, so what the move watch has for it is done here, not behind the wait.
      await runMoveJobs(own);
    }
    if (recorded) await own.noteWait(null);
    return false;
  };
  const failedSession = (session: AdapterSession): Promise<never> => session.exited
    ? session.exited.then(exit => {
      throw Object.assign(new Error(safeValue((exit as { cause?: string })?.cause ?? "child-exited")), { childExited: true });
    })
    : new Promise<never>(() => {});
  // An agent whose door is on another machine reads its chat out of the store,
  // so there is no local path for it to be unavailable. What is checked here is
  // THIS machine's own state root: a path that exists and cannot be read as a
  // directory is a chat that would be served empty in silence.
  const preflight = (registry: Registry, agent: AgentEntry) => {
    for (const path of [stateDir, join(stateDir, agent.person), join(stateDir, agent.person, "chatlog"), join(stateDir, agent.person, "chatlog", agent.id)]) {
      try {
        if (!statSync(path).isDirectory()) throw new Error("not a directory");
        accessSync(path, constants.R_OK | constants.X_OK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("agent-state-unavailable");
      }
    }
  };

  const runAgent = async (agent: AgentEntry, own: Live): Promise<void> => {
    let startedWith = "";
    let lastWork = Date.now();
    let harvestYield: { row: string; until: number } | null = null;
    let claimed: string | null = null;
    /** Whether that claim is a person's message rather than a harvest. */
    let claimedHuman = false;
    /** Where a claimed JOB's notice goes, which is never this agent's own chat. */
    let claimedReturn: { agent: string; door: string; chat: string } | null = null;
    /** The claimed row itself when it is a council seat's job, for the give-up path. */
    let claimedSeat: EligibleRow | null = null;
    /** The digest of the profile a claimed council job was approved under and passed (`council/launch.ts`), or null for any other row. */
    let claimedProfile: string | null = null;
    /** The digest of the profile the live session was started under: what a council's job may be fed to must have been started under the accepted one. */
    let startedProfile: string | null = null;
    let unhealthy = retries.has(agent.id);
    /** The last answer to "can this engine resume an interrupted conversation", to notice it flip. */
    let lastResumeOk: boolean | null = null;
    let turn: OpenTurn | null = null;
    let waiter: Waiter | null = null;
    /**
     * Whether the engine may have been handed anything of the open attempt: true from
     * the moment a feed intent is committed until the attempt ends. A rejected feed does
     * NOT make it false; only the adapter's own proof that nothing was written
     * (`FeedNotWritten`), of a first feed with no effects, lets the attempt end as never
     * given the input.
     */
    let handed = false;
    /**
     * Whether the live session is a fresh MASTER child that has not yet been handed the
     * chat history it has no memory of. Set by `spawn` (never for a resumed session, a
     * worker or an agent with no chat) and cleared when the first real input's feed intent
     * is committed. It feeds nothing by itself: the history is read when that input is
     * claimed and rides on the same feed as background (`withBackground`), so there is no
     * model turn for history alone, and none at an eager start.
     */
    let contextOwed = false;
    let effects = { actions: 0, lastAction: "" };
    /** A move refused an attempt's first feed and the hand-back could not be written yet: done again before anything else the loop does. */
    let pendingBack: { error: MoveGated | MoveNoteRefused | SpawnFenced; row: EligibleRow } | null = null;
    /** The process tree of the open attempt, recorded so that a crash can be judged against it. */
    const noteTree = async (): Promise<void> => {
      const attempt = own.attempt;
      const tree = own.session?.processes?.() ?? null;
      const group = own.session?.group?.() ?? null;
      // What the child is, for the ledger as well as for the attempt: a child closed later without proof is still owed, with this.
      if (own.child && tree) children.record(own.child, { leader: own.session?.pid ?? null, group, pids: tree, partial: own.session?.partial?.() ?? false });
      if (attempt && tree) {
        await notePids(store, attempt.id, { leader: own.session?.pid ?? null, pids: tree, group,
          machine: here.machine, bootId: here.boot, partial: own.session?.partial?.() ?? false });
      }
    };
    /**
     * The recovery context a fresh turn was given to carry, recorded as delivered
     * only once the engine has it: at its receipt, or at the end of the turn it was
     * in. A crash between "the context was composed" and "the engine took it"
     * records nothing, so the next fresh turn tells it again rather than assuming a
     * context that never arrived.
     */
    let pendingContext: { conversation: string; source: string; body: string }[] = [];
    const flushContext = async (): Promise<void> => {
      const owed = pendingContext;
      pendingContext = [];
      for (const one of owed) await recordEntry(store, { conversation: one.conversation, source: one.source, kind: "recovery", body: one.body });
    };
    /**
     * End the open attempt without a result, in one transaction, from what is
     * known: the session is closed first, because an attempt cannot be called
     * over while its process may still be working, and what the adapter can
     * prove about the tree is the evidence. Nothing is retried from here.
     */
    const closeAttempt = async (cause: string, how: { requested?: boolean; notDelivered?: boolean } = {}) => {
      const attempt = own.attempt;
      if (!attempt) return null;
      let evidence: ExitEvidence | null = null;
      const session = own.session;
      if (session && own.child && own.child.session === session) {
        await settleFor(own);
        evidence = await closeChild(own.child);
        await settleFor(own);
      } else if (session) {
        readings.delete(session);
        await session.close().catch(() => {});
        evidence = session.exitEvidence ? await session.exitEvidence().catch(() => null) : null;
      }
      let known: Registry | null = null;
      try { known = load(); } catch { known = null; }
      const ended = await endAttempt(store, { execution: attempt.id, evidence, cause, effects,
        delivered: handed && !how.notDelivered, requested: how.requested, registry: known });
      if (ended.state === "unknown" || ended.state === "stop_unknown") unresolvedWatch.raise();
      // A hold was opened or moved: what its conversation is waiting for is measured on the next tick.
      if (ended.revision !== null) contextWatch.raise();
      own.attempt = null;
      handed = false;
      // A finished answer that could not be settled stays owned and journaled: it
      // is settled now if the store will take it, and on every tick until it does.
      if (ended.state === "journaled") {
        owesJournal();
        await settleStored(store, { runner: options.runner, only: attempt.id });
      }
      return ended;
    };
    /** The session is finished with: closed by whoever ended the attempt, and forgotten so the next claim starts a new child. */
    const forgetSession = async (): Promise<void> => {
      own.session = null;
      own.child = null;
      own.conversation = null;
      await own.facade?.close().catch(() => {});
      own.facade = null;
    };
    /**
     * Whether the session this loop holds is the one an accepted stop signalled. It is
     * never fed again: not the next queued input after the attempt it was signalled for,
     * and not an input whose attempt was opened while the stop was accepted. Bound to the session itself, so a
     * session started after it is not affected and nothing has to be cleared.
     */
    const retired = (): boolean => own.retiring !== null && own.retiring.session === own.session;
    /** Whether what ended the open attempt is the stop that was accepted for THAT attempt, and not something else. */
    const stoppedByRequest = (): boolean => own.retiring !== null && own.attempt !== null && own.retiring.execution === own.attempt.id;
    /**
     * A signalled session with no attempt left on it (the attempt it was signalled for
     * settled with its own result): once the stop is over the session is closed and
     * forgotten, and whatever is queued next starts a session of its own by the normal road.
     */
    const dropRetired = async (): Promise<void> => {
      const retiring = own.retiring;
      if (!retiring) return;
      await retiring.done.catch(() => {});
      if (own.session === retiring.session) {
        if (own.child && own.child.session === retiring.session) { await settleFor(own); await closeChild(own.child); await settleFor(own); }
        else { readings.delete(retiring.session); await retiring.session.close().catch(() => {}); }
        await forgetSession();
      }
      if (own.retiring === retiring) own.retiring = null;
    };
    /** This agent stopped claiming because the household's window is used up. */
    let heldByWindow = false;
    /** One notice per person, and never a second one for the same outage. */
    const sayOutage = async (
      registry: Registry,
      credential: string,
      outage: { cause: string; since: string },
    ): Promise<void> => {
      const every = retrySeconds(registry);
      for (const who of peopleOn(registry, credential)) {
        await appendNotice(store, {
          person: who.person,
          agent: who.agent,
          ...noticeRoute(registry, who.agent),
          body: outageNotice(
            languageOf(registry, who.person) as Language,
            outage.cause,
            every,
          ),
          noticeKey: noticeKey("outage", credential, outage.since, who.person),
        });
      }
    };

    /**
     * It works again, once per person, carrying that person's own count.
     *
     * THE COUNT IS TAKEN BEFORE THE CLEAR, and the order is what makes N right
     * across two runners. Count, then clear: the runner that wins the clear
     * counted before it, and a sibling only settles its own turn after its
     * clear came back empty, so no reply of anybody's can land between this
     * count and the line it produces.
     */
    const sayCatchUp = async (registry: Registry, credential: string): Promise<void> => {
      await store.sql.begin(async tx => {
        const inside = { ...store, sql: tx as unknown as Store["sql"] };
        const waiting = await waitingPerPerson(inside, registry, credential);
        const cleared = await clearOutage(inside, { credential });
        if (!cleared) return;
        for (const who of peopleOn(registry, credential)) {
          await appendNotice(inside, {
            person: who.person,
            agent: who.agent,
            ...noticeRoute(registry, who.agent),
            body: catchUpNotice(languageOf(registry, who.person) as Language, waiting.get(who.person) ?? 0),
            noticeKey: noticeKey("outage-over", credential, cleared.since, who.person),
          });
        }
      });
    };

    /** One line per person at the notice threshold, keyed on the reset. */
    const sayWindow = async (
      registry: Registry,
      credential: string,
      reading: { utilization: number; resets_at: string | null },
    ): Promise<void> => {
      const percent = percentOf(reading);
      for (const who of peopleOn(registry, credential)) {
        await appendNotice(store, {
          person: who.person,
          agent: who.agent,
          ...noticeRoute(registry, who.agent),
          body: windowNotice(languageOf(registry, who.person) as Language, percent),
          noticeKey: noticeKey(
            "window-notice",
            credential,
            String(reading.resets_at),
            who.person,
          ),
        });
      }
    };

    /**
     * This agent's unfinished rows wait for the window's own reset.
     *
     * The guard is what keeps it a write that happens once rather than one per
     * wake: a row already waiting for that reset is left alone, and a row that
     * arrived during the hold is picked up on the next one.
     */
    const holdRows = async (until: string): Promise<void> => {
      await store.sql`update inbound
                         set claimed_by = null, claim_deadline = null, retry_at = ${until}
                       where agent = ${agent.id}
                         and state not in ('answered', 'delivered')
                         and not hub_row_held(id)
                         and (retry_at is null or retry_at < ${until})`;
    };

    /**
     * The hold is off, so the rows are eligible NOW and not at the old reset.
     * Without this a released household would wait out a reset that has already
     * stopped meaning anything.
     */
    const releaseRows = async (): Promise<void> => {
      await store.sql`update inbound set retry_at = null
                       where agent = ${agent.id}
                         and state not in ('answered', 'delivered')
                         and retry_at is not null`;
    };

    // The stamps of a turn land in the order the loop reported them. The verbs
    // fire back to back and the writes are asynchronous, so without this chain
    // `started` can reach the diary before `acked` did.
    /** The resume blocks already said in the diary, so a claim that keeps giving the row back says it once. */
    const blockedNoted = new Set<string>();
    let writes = Promise.resolve();
    let writeFailed: Error | null = null;
    const write = (what: () => Promise<void>) => {
      writes = writes.then(what).catch((error: Error) => {
        writeFailed ??= error;
      });
    };

    /**
     * THE TRAILING WRITE of the turn's progress sheet. The sheet is written on the hub's
     * tick and never per event, so a burst of events followed by silence would leave the last
     * count and the last moment unwritten until the next event, which may be never. What the
     * cadence skipped is written once, when the cadence allows.
     *
     * It is a write of what the loop REPORTED. `activityAt` is taken in `onProgress` from a
     * real adapter event and nowhere else, so the timer's firing time is never a moment the
     * loop was seen doing anything, and a long silence after the burst still reads as one.
     * No event means no timer: nothing here beats, and an idle turn arms nothing.
     */
    const flushProgress = (open: OpenTurn): void => {
      if (open.flushTimer !== null) { clearTimeout(open.flushTimer); open.flushTimer = null; }
      if (turn !== open || open.sealed || open.held || !open.started || !open.unwritten) return;
      open.unwritten = false;
      // Only the sign-of-life stamp, as a write for a text event moves: a tool start that
      // follows is still written on its own cadence, with the attempt's evidence.
      open.activityWroteAt = Date.now();
      write(() => writeProgress(store, progressOf(open)));
    };
    const flushSoon = (open: OpenTurn, every: number): void => {
      open.unwritten = true;
      if (open.sealed || open.flushTimer !== null) return;
      const due = Math.max(open.wroteAt, open.activityWroteAt) + every;
      open.flushTimer = setTimeout(() => flushProgress(open), Math.max(1, due - Date.now()));
    };
    /** A write that just covered everything reported: nothing is left for the timer. */
    const covered = (open: OpenTurn): void => {
      open.unwritten = false;
      if (open.flushTimer !== null) { clearTimeout(open.flushTimer); open.flushTimer = null; }
    };
    /** The turn is over one way or another: its timer goes with it. */
    const cancelFlush = (): void => {
      const open = turn as OpenTurn | null;
      if (open) covered(open);
    };
    /** The sheet write of a turn, unless the error cleanup has begun: it clears the row and nothing may write it again. */
    const writeSheet = (open: OpenTurn): void => {
      if (!open.sealed && !open.held) write(() => writeProgress(store, progressOf(open)));
    };
    /**
     * The error cleanup's first act, before any await. The timer goes and no callback that is
     * still buffered can arm it or write the sheet again; what such a callback reports is still
     * counted into the evidence `closeAttempt` records, and the writes already queued drain first.
     */
    const sealTurn = (): void => {
      const open = turn as OpenTurn | null;
      if (!open) return;
      open.sealed = true;
      covered(open);
    };

    /**
     * AN ATTEMPT THE MOVE REFUSED BEFORE ITS FIRST FEED GOES BACK (`handBackFeed`, `./move.ts`), ended by the machinery that decides
     * from what the store holds under its own locks, never from what this loop believes: the claim is released with it, there is no
     * retry time, no health row and no notice, and the child is left open for the drain, which closes it after its intent. What this
     * loop keeps of the turn and of the claim is cleared only once that is durable and the writes still queued have landed; a
     * callback the adapter delivers late finds no turn and writes nothing. If the store cannot be written nothing is cleared (the
     * loop does it again before anything else), and nothing is closed or retried in its place.
     */
    const handBack = async (error: MoveGated | MoveNoteRefused | SpawnFenced, row: EligibleRow): Promise<void> => {
      sealTurn();
      await writes;
      const attempt = own.attempt;
      // The request is known here before its notification is: the fence goes up now, and the watch reads it as soon as it can.
      if (error instanceof MoveGated && !moveFences.has(agent.id)) moveFences.set({ agent: agent.id, move: error.move, kind: "move", stage: "waiting", after: null });
      let ended: { state: string; revision: number | null; observed: boolean } | null = null;
      if (attempt) {
        let known: Registry | null = null;
        try { known = load(); } catch { known = null; }
        ended = await handBackFeed(store, { error, execution: attempt.id, agent: agent.id, registry: known });
        if (ended.state === "unknown" || ended.state === "stop_unknown") unresolvedWatch.raise();
        if (ended.revision !== null) contextWatch.raise();
        if (ended.state === "journaled") {
          owesJournal();
          await settleStored(store, { runner: options.runner, only: attempt.id });
        }
      } else {
        await store.sql`update inbound set claimed_by = null, claim_deadline = null where id = ${row.id} and claimed_by = ${options.runner}`;
      }
      if (error instanceof MoveNoteRefused) {
        // The relocation note this feed was to carry is not the one the store owes: the feed rolled back, the row waits out the usual retry
        // (a refusal that repeats is a diagnosis, not a loop), and nobody is told the agent is retrying.
        if (ended === null || ended.state === "failed") {
          let registry: Registry | null = null;
          try { registry = load(); } catch { registry = null; }
          const retryAt = new Date(Date.now() + Number(registry ? readSetting(registry, "runner.task_retry_seconds") ?? 30 : 30) * 1000).toISOString();
          await store.sql`update inbound set retry_at = ${retryAt}::timestamptz
            where id = ${row.id} and claimed_by is null and state not in ('answered', 'delivered')`;
          await putRow(store, "agent_health", agent.id, { status: "retry", cause: `move-note-refused: ${error.answer}`, retry_at: retryAt });
        }
        await sayMove("move.note-refused", { agent: agent.id, move: error.move, answer: error.answer, execution: attempt?.id ?? null, state: ended?.state ?? null });
      } else {
        await sayMove("move.gated", { agent: agent.id, move: error.move, execution: attempt?.id ?? null,
          state: ended?.state ?? null, observed: ended?.observed ?? null, revision: ended?.revision ?? null });
      }
      // DURABLE. The local record of the turn and of the claim goes only now.
      turn = null;
      own.attempt = null;
      handed = false;
      pendingContext = [];
      claimed = null;
      claimedReturn = null;
      claimedSeat = null;
      claimedHuman = false;
      unreserve();
      moves?.refresh();
    };
    /** The store placed the conversation on another machine, which is not a failure of this agent. */
    const [engineHealth] = await store.sql`select data from state_row where sheet = 'agent_health' and id = ${agent.id}
      and data ->> 'cause' = 'conversation.engine-mismatch'`;
    let refusedEngine: string | null = typeof engineHealth?.data?.configured_engine === "string" ? engineHealth.data.configured_engine : null;
    const engineMismatch = async (configured: string, registry: Registry): Promise<void> => {
      refusedEngine = configured;
      const [master] = await store.sql`select adapter from conversation where agent = ${agent.id} and kind = 'master'`;
      const bound = String(master?.adapter ?? "unknown");
      const cause = `Master conversation is bound to ${bound}, but its preset configures ${configured}. Restore this agent's preset to ${bound}; restarting or fresh_context does not change its engine. Independent jobs and harvests can still run.`;
      await putRow(store, "agent_health", agent.id, { status: "blocked", cause: "conversation.engine-mismatch", bound_engine: bound, configured_engine: configured, remedy: cause });
      const said = noticeRoute(registry, agent.id);
      if (said) await appendNotice(store, { person: agent.person, agent: agent.id, ...said,
        body: cause, noticeKey: `engine-mismatch:${agent.id}:${bound}:${configured}` });
      await appendRunnerEntry({ stream: "runner", subject: options.runner, kind: "conversation.engine-mismatch", actor: "runner",
        detail: { agent: agent.id, bound_engine: bound, configured_engine: configured, remedy: cause } });
    };
    const elsewhere = (error: unknown): boolean => error instanceof ConversationRefused && error.refusal === "conversation elsewhere";
    /** Fenced from serving it (said once), until the store places it here again at a later generation (`./move.ts`). */
    const placedElsewhere = async (): Promise<void> => {
      const placed = await placementOf(store, agent.id);
      // A move's own fence, and the placement fence a move that went through left, are never replaced by what a refusal says.
      const held = moveFences.get(agent.id);
      if (!held || (held.kind === "placed" && held.move === null)) {
        moveFences.set({ agent: agent.id, move: null, kind: "placed", stage: "placed", after: placed?.generation ?? 0 });
      }
      await sayMove("conversation.elsewhere", { agent: agent.id, machine: placed?.machine ?? null, runner: placed?.runner ?? null, generation: placed?.generation ?? null });
    };

    /**
     * THE FIRST REAL TURN OF A MOVED CONVERSATION, once it ended without a refusal: the resumed session is verified and the relocation notes the
     * attempt carried are acknowledged. It consumes the turn that REALLY ran under the imported session: no model is started for it, nothing
     * is replayed and no fresh session ever takes its place.
     *
     * THE CHECK (`NativeSessionPort.checkResumed`, of the LAST move of the chain: the import in this machine's directory) is made from what the
     * destination's own copy recorded when it promoted. A refusal (`native_resume_unverified`: the transcript is not the imported bytes plus a
     * turn, another transcript appeared, the id the engine reported is not the conversation's) is THROWN from here into `oneTurn`, so the existing
     * path takes it: the attempt, which was fed, ends with the evidence there is and its input is HELD for the owner (`closeAttempt`), exactly
     * as for any turn that must not be trusted. The notes stay owed (nothing was acknowledged), so the next real input carries them again and is
     * checked again. A started conversation whose copy carries no complete record of its import has nothing to check against, and that is the same
     * refusal (the diary says why): a resume that cannot be verified is never acknowledged as one.
     *
     * IT IS MADE BEFORE ANYTHING THE TURN'S END WOULD SHOW (the totals of the progress line, the outage and window readings, the reply's journal
     * and settle), so a refusal leaves the owner no line that says the turn completed and no reply to answer from an unverified session. A turn
     * that carries a note writes no progress sheet while it runs either (`OpenTurn.held`): the door has no line for it before this check. What
     * the engine itself streamed to its own transcript cannot be taken back, and is not claimed to be.
     *
     * THE ACKNOWLEDGEMENT is the store's (`noteDelivered`): on evidence that the attempt that carried the notes was received (the state it is in
     * now), for exactly the notes it carried, with the bodies it carried; never on a queue or a send. A refusal or an error of it leaves the
     * notes owed (a repeated note is conservative) and never fails the turn.
     */
    const finishMoveNotes = async (attempt: ExecutionRow, notes: CarriedNote[], reported: string | null): Promise<void> => {
      const last = await readMove(store, notes[notes.length - 1].move);
      if (last && last.dest_runner === options.runner && last.dest_machine === machine && last.snapshot?.native_state !== "new") {
        const imported = await importedBy(store, last);
        if (imported === null) {
          await sayMove("move.resume-unverified", { move: last.id, execution: attempt.id, why: "no-import-record" });
          throw new NativeRefusal("native_resume_unverified");
        }
        const port = options.adapters[last.adapter]?.session;
        if (!port) throw new NativeRefusal("native_resume_unverified");
        port.checkResumed({
          sessionDir: sessionDirFor(stateDir, last.person, last.agent, last.conversation_id), imported, nativeSession: last.native_session,
          reportedSessionId: reported, limits: MOVE_NATIVE_LIMITS,
        });
        await sayMove("move.resume-verified", { move: last.id, execution: attempt.id });
      } else if (last && last.snapshot?.native_state !== "new") {
        // Not this runner's import (a chain whose last move went elsewhere): nothing here can check it, and the diary says so.
        await sayMove("move.resume-unchecked", { move: last.id, execution: attempt.id, why: "not-destination" });
      }
      let answer = "error";
      try { answer = await noteDelivered(store, { execution: attempt.id, notes: notes.map(({ move, body }) => ({ move, body })) }); } catch { /* left owed */ }
      if (answer !== "delivered" && answer !== "replay") await sayMove("move.note-unacknowledged", { execution: attempt.id, moves: notes.map(one => one.move), answer });
    };

    /**
     * ONE MODEL TURN FOR ONE CLAIMED INPUT. `message.text` is the input as the conversation records it
     * (and as the attempt's digest was taken over it), and it is never changed here. `about.background`
     * is the chat history a fresh master child is owed: it is added to what the ENGINE is handed
     * (`withBackground`) and to nothing else. It is not the conversation's entry, not part of the
     * attempt's input digest and not something a recovery or a replay can rebuild a turn from; the
     * feed intent only says that it rode along, and how big it was.
     */
    const oneTurn = async (
      message: { id: string; text: string },
      about: { preset: Preset; registry: Registry; source?: InboundSource | null; kind?: string; background?: string; notes?: CarriedNote[] },
    ): Promise<void> => {
      // The relocation notes this feed carries (`move-note.ts`): the WHOLE chain the store owes the conversation, composed by `notesOwedTo`.
      const notes = about.notes ?? [];
      let finish: (end: TurnEnd) => void = () => {};
      const ended = new Promise<TurnEnd>((resolve) => {
        finish = resolve;
      });
      turn = {
        id: message.id,
        person: agent.person,
        agent: agent.id,
        acked: false,
        started: false,
        actions: 0,
        lastAction: "",
        startedAt: new Date().toISOString(),
        wroteAt: 0,
        activityAt: null,
        activity: "",
        activityWroteAt: 0,
        unwritten: false,
        flushTimer: null,
        sealed: false,
        held: notes.length > 0,
        finish,
      };
      const opened = turn;
      // EVERY FEED goes to an attempt that is owned and whose feed intent is committed first. The
      // only feed there is is a claimed input's: there is no feed for history alone, and no feed to an
      // engine without an attempt.
      if (!own.attempt) throw new Error("feed-without-attempt");
      // A SESSION AN ACCEPTED STOP SIGNALLED IS NOT FED AGAIN, at the top of a feed and once more right
      // before the first byte: the stop can be accepted while the feed intent is being committed. What
      // the stop was accepted for ends the attempt as stopped; nothing else is fed to a session that
      // was ended for it.
      if (retired()) throw Object.assign(new Error("session-retired"), { retired: true });
      // WHAT IS KNOWN OF THE PROCESSES IS RECORDED FIRST, and only then the intent:
      // a crash between the two would otherwise leave an attempt that may have
      // reached the engine with no process, no group and no boot on record, and
      // nothing could ever show it over.
      await noteTree();
      // Whether anything was fed to THIS attempt before this feed. Nothing is fed ahead of an input any
      // more, so this is false on the first feed; it stays the rule for a rejection's meaning.
      const priorFeed = handed;
      // WHAT THE ENGINE IS HANDED: the input, behind the background when there is one.
      const background = about.background ?? "";
      // The notes go ahead of the input, on the wire only: never the conversation's own entry and never part of the attempt's digest. The
      // store records them in the conversation when it acknowledges their delivery (`finishMoveNotes`).
      const bare = background === "" ? message.text : withBackground(background, message.text);
      const wire = notes.length === 0 ? bare : `${noteBlock(notes)}\n\n${bare}`;
      // COMMITTED BEFORE THE FIRST BYTE, with the input as the conversation's
      // own entry (the RAW input: `message.text`, never `wire`), and fenced by the claim, the
      // incarnation and the placement. From here a crash, an exit or a killed child is uncertain:
      // the engine may have done any of it, and nothing feeds it again. The history that rides
      // with it is named in the same commit, so an attempt that carried it says so.
      await markFeedIntent(store, own.attempt, message.text, "input",
        background === "" ? undefined : { kind: "chat-tail", digest: taskDigest(background), chars: background.length },
        notes.length === 0 ? undefined : notes.map(({ move, digest }) => ({ move, digest })));
      handed = true;
      // From here the engine may have the history, so it is not owed again to this session.
      contextOwed = false;
      if (retired()) throw Object.assign(new Error("session-retired"), { retired: true });
      // A REJECTED FEED IS NOT PROOF THAT NOTHING WAS DELIVERED. Only the adapter's own `FeedNotWritten`
      // says so (it refused before a byte was written), and even that lets the input be tried again only
      // if nothing else was fed to this attempt first and it has done nothing. A write or a flush that
      // failed, a pipe that broke, a rejection with no name: any of them may have come after the engine
      // had some or all of it, and stay uncertain, held, exactly like a crash after the call.
      const delivering = Promise.resolve().then(() => own.session!.feed({ id: message.id, text: wire })).catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        throw error instanceof FeedNotWritten && !priorFeed && effects.actions === 0 ? Object.assign(failure, { notDelivered: true }) : failure;
      });
      delivering.catch(() => {});
      await Promise.race([delivering, stopped, own.left, failedSession(own.session!)]);
      const end = await Promise.race([ended, stopped, own.left, failedSession(own.session!)]);
      // The trailing write goes with the turn. A turn that ended has its own last write below;
      // one cut short by a stop writes what the loop last reported first, before its attempt is closed.
      if (end === "stopped") flushProgress(opened);
      else covered(opened);
      turn = null;
      if (end === "stopped") return;

      await writes;
      if (writeFailed) throw writeFailed;

      const record: TurnRecord = {
        agent: agent.id,
        runner: options.runner,
        preset: agent.preset,
        preset_id: presetId(about.preset),
        preset_settings: { ...about.preset },
        input_tokens: end.usage.input_tokens,
        cached_input_tokens: end.usage.cached_input_tokens,
        output_tokens: end.usage.output_tokens,
        price: priceFor(about.registry, {
          model: about.preset.model,
          at: new Date(),
          paid: about.preset.paid,
          usage: end.usage,
        }),
        plan_usage: end.usage.plan_usage,
        raw_usage: end.usage.raw,
        resolved_model_ids: end.usage.resolved_model_ids ?? [],
        primary_model_id: end.usage.primary_model_id ?? null,
        session_id: end.session_id,
        lacks: [...own.session!.lacks, ...(end.usage.resolved_model_ids?.length ? [] : ["resolved_model"])],
        // The record's field is kept for the turns already in the ledger; no turn is a tail's any more.
        tail: false,
      };

      const credential = credentialFor(about.registry, agent);
      const thresholds = windowThresholds(about.registry, agent.preset);
      const reading = end.usage.window ?? null;

      // The household's one row, written by whichever turn reported a
      // reading, and read by every runner before it claims. A turn that
      // reported nothing leaves it alone: a loop on a per-token key has no
      // window, and a missing report is not a reading of zero.
      if (reading) {
        await recordWindow(store, {
          credential,
          utilization: reading.utilization,
          resetsAt: reading.resets_at,
          runner: options.runner,
        });
        if (
          thresholds &&
          percentOf(reading) >= thresholds.notice_at &&
          readingStands(reading)
        ) {
          await sayWindow(about.registry, credential, reading);
        }
      }

      // A turn the loop refused writes NO chunk and NO stamp. The input the engine was handed is
      // HELD (below) and is not tried again by anything; the diary says why, and the person is told
      // once about the CAUSE rather than once about every message of theirs that is waiting on it.
      if (end.refused) {
        // Shared login failures may have closed the child. Local refusals
        // keep a usable session and never announce a credential outage.
        const scope = classifyRefusal({ credential, refused: end.refused, evidence: end.usage.raw.evidence, thresholds });
        own.killed = scope.scope === "credential";
        const every = retrySeconds(about.registry);
        const retryAt =
          end.refused.cause === "window" && reading?.resets_at
            ? reading.resets_at
            : new Date(Date.now() + every * 1000).toISOString();
        // A TURN THE ENGINE WAS HANDED AND REFUSED IS HELD, whether or not it produced anything. The
        // absence of output or of a receipt is not the absence of delivery: the input reached the engine
        // (its feed intent is committed and the adapter took it), it may already have run
        // tools, and a terminal failure of the adapter is not a reason to feed it again (design §4: the
        // engine's own retry and backoff happen inside the one attempt; once it reports a terminal
        // failure the assignment is not fed again without the owner's choice). A refusal ending the TURN
        // says nothing about the process: it is alive, and so may be anything it started, so it is no
        // proof that the attempt is over. The child is closed and what the process table says of it is
        // the evidence, exactly as for any other end; the next turn starts a child of its own. Confirmed
        // only if it really is gone. A council seat is held the same way and is not given up on: its
        // council waits for its owner. Only a row that was never fed is retried, and none gets here. The
        // history that rode with the input is not fed again either: the held input's own continuation
        // resumes the native session it was fed under, which has it.
        if (own.attempt) {
          await closeAttempt(`the loop refused the turn: ${end.refused.cause}`);
          await forgetSession();
        }
        // The refusal is written down for what it was; the held input carries NO retry (saying it does
        // would be false), and the row's claim and progress line are released with its attempt.
        // The diary names the refusal for what it is: only a
        // credential-scoped one opens an outage below, so only that one is
        // written as `refused.outage`. A local one keeps one agent on a
        // retry and nothing else, and a household counting its outages by
        // this line would otherwise count one that never opened.
        const refusedKind = scope.scope === "local" ? "refused.local" : "refused.outage";
        await refuseTurn(store, {
          inboundId: message.id,
          runner: options.runner,
          agent: agent.id,
          cause: end.refused.cause,
          said: end.refused.said,
          retryAt: null,
          kind: refusedKind,
        });
        // WHAT WAS NEVER FED WAITS. This agent's other unfinished rows were not handed to the engine, so
        // they are not held: they wait out the same retry interval (or the window's own reset) instead of
        // being fed one after another into an engine that has just said it will not answer, each of them
        // becoming a held input. After the interval the next of them is tried.
        await holdRows(retryAt);
        if (scope.scope === "local") return;
        const standing = await openOutage(store, {
          credential,
          cause: end.refused.cause,
          said: end.refused.said,
          runner: options.runner,
          retryAt,
        });
        await sayOutage(about.registry, credential, standing);
        return;
      }

      // THE FIRST REAL TURN AFTER A MOVE: the resumed session is checked once and the notes it carried are acknowledged (see `finishMoveNotes`).
      // It is the first thing a turn that ended without a refusal does, so a refused check is thrown before the totals are written, before a
      // reading is acted on, and before a reply is journaled or settled: the input is held (`closeAttempt`) with nothing that says it was answered.
      // The writes of this turn have all landed (`writes`, above), including the receipt the acknowledgement rests on.
      if (own.attempt && notes.length > 0) await finishMoveNotes(own.attempt, notes, end.session_id ?? own.session?.reportedSessionId ?? null);

      // The last write of the open turn: the totals, before the settle that takes the row
      // away, so the door's own line ends with them (L6). It goes in HERE and
      // not beside the settle on purpose: the write commits and announces
      // itself, and everything below it is what gives the door the room to read
      // it before the settling transaction removes the row.
      if (opened.started) await writeProgress(store, progressOf(opened));

      // Clear only with recovery evidence from this turn's selected source.
      const outage = await readOutage(store, credential);
      const evidence = end.usage.raw.evidence as Record<string, unknown> | undefined;
      const authenticated = evidence?.kind === "authenticated-response" && evidence.credential === credential &&
        typeof evidence.status === "number" && evidence.status >= 200 && evidence.status < 300;
      if (outage && (outage.cause === "window" ? reading && thresholds && reading.utilization * 100 < thresholds.hold_at : authenticated)) {
        await sayCatchUp(about.registry, credential);
      }

      if (unhealthy && refusedEngine === null) { await removeRow(store, "agent_health", agent.id); unhealthy = false; retries.delete(agent.id); }
      // A job's answer is the whole report and reaches no chat, so it is
      // never cut to a platform's size.
      const chunks = about.kind === "job" ? [end.text]
        : prepareReply(end.text, answerPlatform(about.source?.log_id) ?? noticeRoute(about.registry, agent.id)?.platform ?? "discord", languageOf(about.registry, agent.person));
      const attempt = own.attempt;
      // The engine answered, so it had the message and whatever recovery context
      // rode in it: only now is that context recorded as delivered.
      await flushContext();
      if (attempt) {
        // THE RESULT IS KEPT BEFORE IT IS SETTLED. The settle is one
        // transaction and a runner that dies inside it leaves nothing, so what
        // survives is this: the next start, or the next look, settles the reply from
        // it and does not feed the input again.
        await journalResult(store, attempt.id, { text: end.text, chunks, turn: record });
        if (attempt.native_session && end.session_id) {
          const seen = await verifyNative(store, attempt.conversation_id, attempt.native_session, end.session_id);
          if (seen === "mismatch") await noteExecution(store, attempt.id, "native.mismatch", { asked: attempt.native_session, reported: end.session_id });
        }
      }
      await settleTurn(store, {
        inboundId: message.id,
        person: agent.person,
        source: about.source,
        kind: about.kind,
        chunks,
        turn: record,
        ...(attempt ? { execution: { id: attempt.id, runner: options.runner, fence: { incarnation } } } : {}),
      });
      own.attempt = null;
      handed = false;
    };

    /**
     * A harvest turn, which touches the agent's own session not
     * at all.
     *
     * It opens a session of its OWN under the harvester's preset, in the
     * person's vault root, feeds it one message, closes it, files what came
     * back through the household's `imprnt`, and settles the watermark with the
     * turn. `own.session`, `own.killed`, `startedWith` and `turn` are never
     * read or written here, so nothing of the agent's turn machinery can see a
     * harvest: no receipt, no progress, no `acked` and no `started` stamp, and
     * therefore no typing, no progress line and no clock line about a row
     * nobody sent.
     */
    const harvestTurn = (row: EligibleRow, registry: Registry) => executeHarvest({
      store, registry, agent, row, runner: options.runner, stateDir, adapters: options.adapters,
      stopped: Promise.race([stopped, own.left]),
      opened: session => { harvestSessions.set(session, own); capacityChanged(); },
      closed: session => { harvestSessions.delete(session); readings.delete(session); },
    });

    /** A reservation with no child behind it goes back, so a row that was not started does not hold a slot. */
    const unreserve = () => {
      if (!own.session && own.reserved) { own.reserved = false; releaseCapacity(); }
    };

    /** Whether this agent's engine has shown it can resume an interrupted conversation safely. Never waits for a probe. */
    const resumeSafe = (registry: Registry): boolean => {
      try {
        const adapter = options.adapters[getPreset(registry, agent.preset).adapter];
        return adapter ? capabilities.peek(adapter, { registry, agent, preset: agent.preset }).safeResume : false;
      } catch { return false; }
    };

    /**
     * The native session a child of this conversation is started under, or
     * null for an engine that cannot be given one.
     *
     * IT IS THE CONVERSATION'S OWN AND IT IS STABLE, for a master as for a worker:
     * the id the conversation was created with, launched the first time and resumed
     * after, across an idle shutdown and across a restart of the runner. A master
     * whose engine took a message under its session is resumed, so a completed
     * master turn is never followed by a rebuilt context or a replayed tail.
     * Except when an interrupted assignment has to be discussed: then it resumes
     * the session of the attempt that was interrupted. Never `--continue`, never
     * "the latest".
     *
     * A SESSION THE ENGINE NEVER ACKNOWLEDGED IS NOT A NEW ONE. If a child was
     * started under the id and no message was ever taken under it (`launched`), the
     * id may already exist in the engine, so it is not launched as new again and it
     * is not resumed as known either: it is replaced by a fresh id, durably, and the
     * one given up on is said in the diary. Nothing the hub knew of was in it.
     */
    const planSession = async (conversation: Conversation, adapter: Adapter, registry: Registry, resumeFrom: string | null) => {
      const caps = await capabilities.get(adapter, { registry, agent, preset: agent.preset });
      if (!caps.stableSession) return null;
      if (resumeFrom) return { id: resumeFrom, resume: true };
      if (conversation.native_state === "launched") {
        const minted = await mintNativeSession(store, conversation.id);
        if (minted) {
          await appendRunnerEntry({ stream: "runner", subject: options.runner, kind: "native.replaced", actor: "runner",
            detail: { conversation: conversation.id, replaced: minted.replaced } });
          return { id: minted.id, resume: false };
        }
        // Something acknowledged it between the read and now: what the store holds is the truth.
        const [now] = (await store.sql`select native_session, native_state from conversation where id = ${conversation.id}`) as unknown as
          { native_session: string; native_state: string }[];
        return { id: now.native_session, resume: now.native_state !== "new" && now.native_state !== "launched" };
      }
      return { id: conversation.native_session, resume: conversation.native_state !== "new" };
    };

    /**
     * THE FENCE IS READ IN THE FIRST SYNCHRONOUS STEP, and the child this spawn may make is owed an account of in the same one: a
     * request that commits while the spawn is in preflight, in admission, in the adapter's start or in the engine's own
     * initialisation finds the record (the drain waits for it), and one that committed before it throws here, before anything is
     * reserved, launched or written. There is no await between the check and the record. A spawn that fails before the adapter was
     * asked made no child; one that fails after it was asked may have, and nothing here can say, so it stays owed.
     */
    const spawn = async (preset: Preset, registry: Registry, conversation: Conversation, plan: { id: string; resume: boolean } | null): Promise<void> => {
      const fence = moveFences.get(agent.id);
      if (fence) throw new SpawnFenced(agent.id, fence.move);
      const record = children.starting(agent.id, { conversation: conversation.id, nativeSession: plan?.id ?? null, placement: conversation.placement_generation });
      const seen = { invoked: false };
      try {
        // THE LAUNCH IS SERIALIZED WITH EVERY OTHER WRITER OF THIS CONVERSATION'S SESSION DIRECTORY (a move's import, the removal of an import's
        // copy: `exclusive`), and it is asked the store's word under that lock before it writes anything there: this incarnation is still the
        // runner's current one, and the conversation is still placed on this machine at the generation this attempt was opened for. The record
        // above was made before the wait, so a request that arrives meanwhile finds a child being started and the drain waits for it.
        await exclusive(conversation.id, async () => {
          const [now] = (await store.sql`select c.machine as machine, c.placement_generation as generation, r.incarnation as current
            from conversation c left join runner_incarnation r on r.runner = ${options.runner} where c.id = ${conversation.id}`) as unknown as
            { machine: string | null; generation: number | string; current: string | null }[];
          if (!now || now.current !== incarnation || Number(now.generation) !== Number(conversation.placement_generation)
              || (now.machine !== null && now.machine !== machine)) throw new SpawnFenced(agent.id, moveFences.get(agent.id)?.move ?? null);
          await startChild(preset, registry, conversation, plan, record, seen);
        });
      } catch (error) {
        if (record.phase === "starting") { if (seen.invoked) children.lost(record); else children.abandon(record); }
        throw error;
      }
    };

    const startChild = async (preset: Preset, registry: Registry, conversation: Conversation, plan: { id: string; resume: boolean } | null,
      record: ChildRecord, seen: { invoked: boolean }): Promise<void> => {
      preflight(registry, agent);
      const adapter = adapterFor(options.adapters, preset.adapter);
      if (own.session) {
        if (own.child && own.child.session === own.session) await closeChild(own.child);
        else { readings.delete(own.session); await own.session.close().catch(() => {}); }
        own.session = null;
        own.child = null;
        own.conversation = null;
      }
      await own.facade?.close().catch(() => {});
      own.facade = null;
      // The hunt's triage master launches with no tools, whatever its preset
      // or its fragment say: the role on its registry row is the truth.
      const purpose = agent.role === "triage" ? "triage" : "ordinary";
      // The hub's tool facade is bound to THIS conversation before the engine
      // starts, so the engine's calls carry it and nothing they say can change
      // it. Only an engine whose launch the adapter prepares can be told about
      // one, and a child with no tools is not given a tool server.
      if (adapter.prepareLaunch && purpose === "ordinary") {
        own.facade = await bindFacade({ store, person: agent.person, agent: agent.id, conversation: conversation.id, kind: conversation.kind,
          registry: () => load(), attempt: () => own.attempt?.id ?? null });
      }
      let launch: Awaited<ReturnType<typeof launchFor>>;
      let session: AdapterSession;
      try {
        launch = await launchFor(registry, agent, agent.preset, purpose, conversation, own.facade?.server);
        // The id may exist in the engine from the moment a child is started under
        // it, so that is written down BEFORE the child is: if this process dies
        // between here and the engine's first acknowledgement, the next start
        // knows the id was tried and does not launch it as new.
        if (plan && !plan.resume) await markLaunched(store, conversation.id);
        seen.invoked = true;
        session = await adapter.start({
          preset,
          sessionId: null,
          ...(plan ? { session: plan } : {}),
          ...launch,
        });
      } catch (error) {
        await own.facade?.close().catch(() => {});
        own.facade = null;
        throw error;
      }
      own.session = session;
      children.started(record, session);
      own.child = record;
      own.conversation = conversation.id;
      own.nativeSession = plan?.id ?? null;
      own.boxed = "wrap" in launch;
      // A child the watch killed is a session that is gone, and this is where
      // it comes back: before the next turn, with the runner never restarting.
      own.killed = false;
      startedWith = presetId(preset);
      startedProfile = launchProfileOf(registry, agent.id);

      session.onReceipt((messageId) => {
        const open = turn;
        if (!open || open.acked || messageId !== open.id) return;
        open.acked = true;
        write(() => stamp(store, { messageId: open.id, kind: "acked", actor: "runner" }));
        write(async () => {
          const attempt = own.attempt;
          if (!attempt) return;
          await markProgress(store, attempt.id, "received");
          // The engine has the message, and so the recovery context that rode in it.
          await flushContext();
          // The engine took a message under the session this conversation was
          // launched with. An engine that was given no session has none to say.
          if (attempt.native_session) await noteNative(store, attempt.conversation_id, "started");
          // As early as the engine says it: the session it reports is either the
          // one this conversation was launched under or it is not.
          const said = session.reportedSessionId;
          if (said && attempt.native_session) {
            const seen = await verifyNative(store, attempt.conversation_id, attempt.native_session, said);
            if (seen === "mismatch") await noteExecution(store, attempt.id, "native.mismatch", { asked: attempt.native_session, reported: said });
          }
          await noteTree();
        });
      });
      session.onProgress((event) => {
        const open = turn;
        if (!open) return;
        // WHAT THE LOOP JUST DID, as the loop said it. This is the only place the
        // moment is taken, so it moves with real events and with nothing else.
        open.activityAt = new Date().toISOString();
        open.activity = event.kind;
        if (!open.started) {
          open.started = true;
          open.startedAt = new Date().toISOString();
          write(() => stamp(store, { messageId: open.id, kind: "started", actor: "runner" }));
          write(async () => {
            const attempt = own.attempt;
            if (!attempt) return;
            await markProgress(store, attempt.id, "running");
            await noteTree();
          });
          // One write at `started`, which is what gives the door a line to post
          // for a turn that never calls a tool at all.
          open.wroteAt = Date.now();
          open.activityWroteAt = open.wroteAt;
          covered(open);
          writeSheet(open);
        }
        if (event.kind !== "action") {
          // Text and a tool's result are signs of life and never counts, so they
          // carry no effects and cost no extra write: the moment rides on the
          // sheet write the same cadence already makes, and at most one more per
          // tick when nothing else wrote it. What the cadence skips is written
          // once by the trailing write, so the last event is never lost to silence.
          const every = setting(registry, "hub.tick_seconds") * 1000;
          if (Date.now() - Math.max(open.wroteAt, open.activityWroteAt) >= every) {
            open.activityWroteAt = Date.now();
            covered(open);
            writeSheet(open);
          } else {
            flushSoon(open, every);
          }
          return;
        }
        open.actions += 1;
        open.lastAction = event.text;
        effects = { actions: open.actions, lastAction: open.lastAction };
        // THROTTLED BY TIME AND NEVER PER ACTION. A per-action rule
        // makes the store's write rate, the notification rate and the
        // platform's edit rate a function of how many tools a turn calls, and a
        // turn can call two hundred. Both platforms rate-limit edits. The
        // cadence is the hub's own, so no second setting exists to be the same
        // number.
        const every = setting(registry, "hub.tick_seconds") * 1000;
        if (Date.now() - open.wroteAt < every) {
          // Counted, and written once by the trailing write, never per action.
          flushSoon(open, every);
          return;
        }
        open.wroteAt = Date.now();
        open.activityWroteAt = open.wroteAt;
        covered(open);
        writeSheet(open);
        // What the attempt has done and which processes it has, on the same
        // cadence: it is all the evidence there will be after a crash.
        write(async () => {
          const attempt = own.attempt;
          if (!attempt) return;
          await noteEffects(store, attempt.id, effects);
          await noteTree();
        });
      });
      session.onTurnEnd((end) => turn?.finish(end));

      // A spawned session has no memory of what was said, so it is OWED the tail of the
      // log. Nothing is fed for it here: starting a child is not a reason to run a model, and
      // a tail fed as a turn of its own was one the loop could act on (it ran tools and rebuilt
      // files from history) for minutes before the message it was started for was accepted.
      // The tail is read when the first real input is claimed and rides with that input as
      // background (`readBackground`, `oneTurn`): one feed, one turn, one answer.
      //
      // AN AGENT WITH NO CHAT HAS NO TAIL, and its entry is what says so: it
      // takes jobs alone, and a job's body is its whole input. That is a
      // declared empty tail, and a different thing from an agent whose chat log
      // lives on another machine, which is read from the store. Whatever
      // sits where a chat log would be is not this agent's conversation,
      // because no door writes one for an agent with no door.
      //
      // A JOB'S CHILD IS NOT OWED THE TAIL EITHER, and neither is a resumed
      // one: a worker's context is its brief and its own transcript, and must not
      // include what a configured seat's chat said before this job; a resumed
      // session already has what it had.
      contextOwed = agent.chat !== undefined && conversation.kind === "master" && !plan?.resume;
    };

    /**
     * The history a fresh master child is owed, as the background of the input that was just
     * claimed: the tail in its existing format (`readTail`, or the store's own lines), or "" when
     * there is none. Read only for that claimed input, so it can leave that input out.
     */
    const readBackground = async (registry: Registry): Promise<string> => {
      // Where those lines are read from is the registry's answer: the file this
      // machine's door wrote, or the store when that door is somewhere else.
      const where = {
        person: agent.person,
        agent: agent.id,
        now: new Date(),
        hours: setting(registry, "hub.tail_hours"),
        tokens: setting(registry, "hub.tail_tokens"),
      };
      // A message still waiting for its answer is not in the tail. The door
      // wrote it down the moment it landed, and this session is about to be
      // handed it as a turn of its own (the claimed input is one of them), so
      // inside the tail it would be the same message twice: the loop is told
      // not to answer the tail, and a loop that reads a task there still runs it.
      //
      // ONE SNAPSHOT FOR BOTH READS. The waiting set and the store's own lines
      // are two statements, and a message the door commits between them, with
      // a platform time before the cutoff, would sit in the tail unexcluded and
      // then be claimed and fed again as a turn. Under repeatable read the
      // second statement sees exactly the rows the first did.
      return await store.sql.begin("isolation level repeatable read read only", async (tx) => {
        const inside = { ...store, sql: tx as unknown as Store["sql"] };
        const waiting = new Set<string>(((await inside.sql`
          select source ->> 'log_id' as log_id from inbound
          where agent = ${agent.id} and source is not null
            and state not in ('answered', 'delivered')`) as unknown as { log_id: string | null }[])
          .map(row => row.log_id).filter((id): id is string => typeof id === "string" && id !== ""));
        return chatStateFor(registry, agent.id) === "store"
          ? await deriveTail(inside, { registry, ...where, exclude: waiting, stateDir })
          : await readTail({ stateDir, ...where, exclude: waiting });
      });
    };

    try {
      // The LISTEN is opened before the first read of the table and held across
      // every wait after it, so a row committed between a read that found
      // nothing and the wait that follows is announced to a listener that
      // already exists. Opened after the read, that notification is emitted to
      // nobody and the row waits for the tick.
      waiter = await openWorkWaiter(store, { agent: agent.id });
      const initial = load();
      preflight(initial, agent);
      // A CLAIM IS NOT A RETRY BARRIER. A council member's job that an earlier loop of this runner (or the process before it) claimed and never got an
      // attempt for is a launch that did not finish, and the claim it left is what this very loop would take again first (`claimNext` takes the runner's
      // own claim back without waiting out a lease). Whether the failure was ever written down does not matter here: the store is asked, and every such
      // job is fenced (the failure fence the council reads as a member that failed before its input) and released BEFORE this loop claims anything. If the
      // store cannot be written the loop ends here, claims nothing, and is served again after the retry delay, where this runs first once more. Only a
      // council's job is looked at, and only when its runner holds the claim with nothing owned behind it.
      for (const one of await sweepAbandonedClaims(store, { runner: options.runner, agent: agent.id,
        cause: "the loop that claimed this input ended before an attempt was opened for it: nothing shows it was handed to an engine" })) {
        process.stderr.write(`council-claim-fenced: ${agent.id}: ${safeValue(one.id)}\n`);
      }
      // THE HOLD AFTER A RESTART. The hold outlives the process that opened it:
      // the rows keep the window's reset as their `retry_at`, and only the way
      // out of the hold clears it. A loop that started with the flag false
      // would find the window already fine, never take that way out, and leave
      // the rows waiting out a reset that no longer means anything.
      // The household's open window outage is the hold as the
      // store keeps it, so it is read back ONCE, here, and the first wake below
      // then releases or keeps holding exactly as it would for a loop that had
      // never stopped. An agent on a per-token key has no window and pays no
      // statement for it.
      //
      // One gap stays named rather than closed: a sibling runner that saw the
      // window come back first has already cleared the outage and released
      // only its own agents' rows, so a loop starting after that reads no hold
      // and its rows wait for their reset. A loop that never stopped keeps its
      // flag through the sibling's clear and does not have the gap.
      if (windowThresholds(initial, agent.preset)) {
        const standing = await readOutage(store, credentialFor(initial, agent));
        heldByWindow = standing?.cause === "window";
      }
      // A resident agent with a chat is started ahead of its first message, on
      // its master conversation. The start only brings the child up: it feeds
      // nothing, opens no attempt and runs no model turn, so a runner that is
      // ready has only said that its session exists. What the child is owed of
      // the chat's history is attached to the first real input it is claimed for.
      // One with no chat takes jobs alone, and every
      // job has a conversation of its own, so a child started now would only be
      // closed by the first of them: it starts with its first job.
      // NOR IS ONE STARTED BESIDE AN ATTEMPT THAT MAY STILL BE RUNNING, or beside
      // an interrupted assignment: another process for that conversation is
      // exactly what an unresolved attempt forbids, and what would be started
      // is not what is asked for anyway. The first row it can claim starts it.
      //
      // NOR ONE FOR AN AGENT A MOVE GATES OR THE STORE PLACES ELSEWHERE. The move's gate is read here with the rest (the watch had placed its
      // fence before anything was served, and the fence is read again at the spawn itself), and a conversation the store places on another
      // machine is refused by `conversationFor` and ends the start without a child, a retry or a finding.
      const [standing] = (await store.sql`select hub_agent_blocked(${agent.id}) as blocked,
        exists (select 1 from replay_hold h join conversation c on c.id = h.conversation_id
                 where c.agent = ${agent.id} and h.state <> 'released') as held,
        exists (select 1 from claim_gate g where g.state = 'open' and g.scope_kind = 'agent' and g.scope_id = ${agent.id} and g.cause = 'move') as moving`) as unknown as
        { blocked: boolean; held: boolean; moving: boolean }[];
      if (lifetimeFor(initial, agent.id).mode === "resident" && !lifetimeFor(initial, agent.id).sleeping && agent.chat !== undefined
          && !standing.blocked && !standing.held && !standing.moving && !moveFences.has(agent.id)) {
        if (!await admitChild(initial, own)) return;
        // A copy that fell behind during the admission wait spawns nothing:
        // the reservation goes back and the supervisor serves this agent
        // again once the copy is current.
        await measureRegistry();
        if (stale) { releaseCapacity(); return; }
        if (moveFences.has(agent.id)) {
          // A request committed while this waited for room: no child, and the reservation goes back.
          releaseCapacity();
        } else {
          own.reserved = true;
          await own.noteWait({ kind: "starting" });
          const eagerPreset = getPreset(initial, agent.preset);
          const eager = adapterFor(options.adapters, eagerPreset.adapter);
          const master = await conversationFor(store, { row: { id: agent.id, person: agent.person, agent: agent.id, kind: "human" }, adapter: eagerPreset.adapter, machine })
            .catch(async (error: unknown): Promise<Conversation | null> => {
              if (error instanceof ConversationRefused && error.refusal === "conversation engine mismatch") {
                await engineMismatch(eagerPreset.adapter, initial);
                return null;
              }
              if (!elsewhere(error)) throw error;
              await placedElsewhere();
              return null;
            });
          // A MOVED CONVERSATION'S NOTE STILL OWED (a runner that restarted after the serve and before the first input): this launch resumes the
          // imported session like the first input's does, so it is held to the same question (`moveConfigDrift`). A drifted or unreadable
          // configuration starts no child here; the first input's launch asks again and starts it once the files are what the move compared.
          const drift = master !== null && master.kind === "master" ? await moveConfigDrift(store, initial, options.runner, agent.id, master.id) : null;
          if (drift) await sayMove("move.note-refused", { agent: agent.id, move: drift.move, answer: drift.answer, execution: null, state: null });
          else if (master !== null) {
            try { await spawn(eagerPreset, initial, master, await planSession(master, eager, initial, null)); }
            catch (error) { if (!(error instanceof SpawnFenced)) throw error; }
          }
          unreserve();
          await own.noteWait(null);
        }
      }
      // An agent is served the moment its session is up (or at once, when it starts
      // none), and this is where it settles: no model turn stands between the two.
      own.settle();
      /**
       * WHY THIS LOOP STILL ASKS ON ITS BOUND.
       *
       * `docs/SPEC.md:17` says the runner reads its eligible rows on connect
       * and after every turn, wakes itself on a recorded deadline, and never
       * polls on a timer, and a bare timeout is none of those. Gating the
       * claim on the wake reason exactly as that reads makes the hub box fail
       * `test/runner-drain.test.ts` in THREE of four full suite runs while it
       * passes alone every time: a notification the runner has to hear does
       * not reach it under load there, and with no read on the bound the row
       * it announced is never claimed at all. The tick is the cover for that,
       * and taking the cover away without knowing what drops the notification
       * trades a statement a second for a message a household never gets an
       * answer to.
       */
      while (!stopping && !own.leaving) {
        // Before each turn, because a preset or a rate is a registry edit and
        // the agent picks it up on its next turn without anything restarting.
        // A session an accepted stop signalled, whose attempt has since settled with its own result, is
        // finished with: what is queued next is started on a session of its own, never fed to that one.
        if (own.attempt === null && retired()) await dropRetired();
        // WHAT THE MOVE WATCH HAS FOR THIS LOOP is done here, where the loop holds no attempt, no claim and no child in flight: the
        // drain closes this loop's child itself, in sequence with everything else the loop does to it.
        await runMoveJobs(own);
        const registry = load();
        // An attempt a move refused whose hand-back could not be written is handed back again before anything else: nothing is
        // claimed, started or closed around it, and a failure waits for the tick.
        if (pendingBack !== null) {
          try { await handBack(pendingBack.error, pendingBack.row); pendingBack = null; }
          catch (error) {
            process.stderr.write(`move-handback-failed: ${agent.id}: ${safeValue(String((error as Error)?.message ?? error)).slice(0, 300)}\n`);
            await Promise.race([Bun.sleep(setting(registry, "hub.tick_seconds") * 1000), stopped, own.left, own.nudged]);
            continue;
          }
        }
        agent = listAgents(registry).find(one => one.id === agent.id) ?? agent;
        const lifetime = lifetimeFor(registry, agent.id);
        // A FENCED AGENT'S CHILD IS NOT CLOSED BY THE IDLE TIMER: the drain closes it, and only after its intent is durable.
        if (own.session && !moveFences.has(agent.id)
            && (lifetime.sleeping || lifetime.mode === "on-demand" && Date.now() - lastWork >= lifetime.idle_seconds * 1000)) {
          if (own.child && own.child.session === own.session) await closeChild(own.child, { strict: true });
          else { readings.delete(own.session); await own.session.close(); }
          own.session = null;
          own.child = null;
          own.conversation = null;
          await own.facade?.close().catch(() => {});
          own.facade = null;
          if (own.reserved) { own.reserved = false; releaseCapacity(); }
        }
        if (lifetime.sleeping || stale) {
          await Promise.race([Bun.sleep(setting(registry, "hub.tick_seconds") * 1000), stopped, own.left, own.nudged]);
          continue;
        }
        /** Whether the work waiter itself woke it ("notified": a commit for this agent, or a listener that was lost and is open again). */
        const sleep = async (): Promise<boolean> => {
          // A job queued or a fence lifted since the loop last looked is seen here, before the wait begins: a nudge is never lost.
          if (own.nudging || own.jobs.length > 0) { own.nudging = false; return false; }
          let heard = false;
          await Promise.race([
            waiter!
              .wait(setting(registry, "hub.tick_seconds") * 1000)
              .then(why => { heard = why === "notified"; }, () => {}),
            stopped,
            own.left,
            own.nudged,
            ...(own.session && !own.killed ? [failedSession(own.session)] : []),
          ]);
          own.nudging = false;
          return heard;
        };
        // A FENCED AGENT CLAIMS NOTHING AND STARTS NOTHING (`./move.ts`): its queued input stays exactly where it is (the store's
        // gate holds it too), the turn that was already fed has finished by the time the loop is here, and the wait is the loop's
        // own (a notification, a nudge, the tick), woken when the fence is lifted.
        // A WITHDRAWAL WHOSE NOTIFICATION THIS RUNNER NEVER HEARD lifts nothing by itself: what the work waiter says (a commit for this
        // agent, a listener opened again) sends the watch to read the moves, which lifts the fence of a move that was withdrawn.
        if (moveFences.has(agent.id)) { if (await sleep()) moves?.refresh(); continue; }
        // Park only master work: jobs and harvests own independent contexts.
        if (refusedEngine !== null && refusedEngine !== getPreset(registry, agent.preset).adapter) {
          refusedEngine = null;
          await store.sql`delete from state_row where sheet = 'agent_health' and id = ${agent.id}
            and data ->> 'cause' = 'conversation.engine-mismatch'`;
        }
        const masterBlocked = refusedEngine !== null;

        // THE WINDOW IS READ HERE AND NOWHERE ELSE: beside the claim,
        // on a wake the runner was already having, and never on a timer of its
        // own. An agent on a per-token key has no window and this costs
        // it no statement at all.
        const credential = credentialFor(registry, agent);
        const thresholds: WindowThresholds | null = windowThresholds(registry, agent.preset);
        let maxRank: number | null = 1;
        if (thresholds) {
          const window: WindowRow | null = await readWindow(store, credential);
          maxRank = maxRankFor(window, thresholds);
          if (maxRank === null) {
            const every = retrySeconds(registry);
            const until =
              window?.resets_at ?? new Date(Date.now() + every * 1000).toISOString();
            if (!heldByWindow) {
              heldByWindow = true;
              const standing = await openOutage(store, {
                credential,
                cause: "window",
                said: `the plan window is ${percentOf(window!)}% used`,
                runner: options.runner,
                retryAt: until,
              });
              await sayOutage(registry, credential, standing);
            }
            // A row that arrived during the hold is put on the same reset, and
            // one already waiting for it is left alone.
            await holdRows(until);
            await sleep();
            continue;
          }
          if (heldByWindow) {
            heldByWindow = false;
            await releaseRows();
            // A reading that still stands and is back under the hold is the
            // household's window really coming back. A reading whose own reset
            // has passed says nothing yet: what releases THAT hold is the turn
            // this claim is about to let through, reporting a fresh one.
            if (readingStands(window)) {
              await sayCatchUp(registry, credential);
            }
          }
        }

        if (!own.reserved && !await admitChild(registry, own, false)) break;
        // The resident agents whose harvest could be claimed right now, which
        // is the question the RESIDENT's window answers and never this loop's:
        // a cold agent on a per-token key beside a paused plan is still next
        // to a harvest nothing will claim. A preset with no window always lets
        // its harvest run. Only a loop with no session ever yields, so only
        // that loop pays the reads, and residents on one credential share one.
        const residentHarvest: string[] = [];
        if (!own.session) {
          const windows = new Map<string, WindowRow | null>();
          for (const one of agentsFor(registry, { runner: options.runner })) {
            const life = lifetimeFor(registry, one.id);
            if (life.mode !== "resident" || life.sleeping) continue;
            const limits = windowThresholds(registry, one.preset);
            if (limits) {
              const key = credentialFor(registry, one);
              if (!windows.has(key)) windows.set(key, await readWindow(store, key));
              if (maxRankFor(windows.get(key) ?? null, limits) !== 1) continue;
            }
            residentHarvest.push(one.id);
          }
        }
        const observedCapacity = capacityVersion;
        // Whether a conversation with an interrupted assignment may be
        // continued on this engine. Read from the last answer and never waited
        // for, and "no" until the engine has shown it.
        const resumeOk = resumeSafe(registry);
        // The engine's answer flipped (it was measured, its build or its configuration changed): what every
        // held conversation of this runner is waiting for may have changed with it, and is measured again.
        if (lastResumeOk !== null && lastResumeOk !== resumeOk) contextWatch.raise();
        lastResumeOk = resumeOk;
        const connection = await store.sql.reserve();
        let next;
        let moving = false;
        try {
          // Every path that can pick a row asks the same three questions: is it
          // an interrupted input, does its agent have an attempt whose
          // ownership is unresolved, and does its conversation need a resume
          // this engine has not shown it can do. A lease that ran out answers
          // none of them.
          //
          // THE SAME STATEMENT SAYS WHETHER A MOVE'S GATE IS OPEN on this agent (`moving`, one row whatever the selection finds): a
          // request whose notification this runner never heard also closes the selection below (the gate is part of `hub_row_held`),
          // so without it nothing here would ever see the move. It costs no round trip of its own.
          const [picked] = await connection`select n.id, n.kind, n.needs_resume, n.harvest_waiting, g.moving
            from (select exists (select 1 from claim_gate gate where gate.state = 'open' and gate.scope_kind = 'agent'
                                   and gate.scope_id = ${agent.id} and gate.cause = 'move') as moving) g
            left join lateral (select id, kind, hub_row_needs_resume(id, agent, kind, source) as needs_resume, exists (
              select 1 from inbound h where h.agent in (select jsonb_array_elements_text(${JSON.stringify(residentHarvest)}::text::jsonb)) and h.kind = 'harvest'
                and h.log_ready and h.state not in ('answered', 'delivered') and h.claimed_by is null
                and (h.retry_at is null or h.retry_at <= now())
            ) as harvest_waiting from inbound where agent = ${agent.id}
              and log_ready and state not in ('answered', 'delivered') and rank <= ${maxRank}
              and (not ${masterBlocked}::boolean or kind in ('job', 'harvest'))
              and (claimed_by is null or claimed_by = ${options.runner}
                   or (claim_deadline is not null and claim_deadline <= now()))
              and (retry_at is null or retry_at <= now())
              and not hub_row_held(id)
              and not (case when kind = 'harvest' then hub_harvest_blocked(agent, ${options.runner}::text) else hub_agent_blocked(agent) end)
              and (${resumeOk}::boolean or not hub_row_needs_resume(id, agent, kind, source))
              order by rank, received_at, id limit 1) n on true`;
          moving = picked.moving === true;
          next = picked.id === null ? undefined : picked;
        } finally { connection.release(); }
        // An open gate of a move and no fence here: the request was not heard. The watch reads now (event-driven: only when the select said so).
        if (moving && !moveFences.has(agent.id)) moves?.refresh();
        // Capacity belongs to this selected row. A later arrival must go
        // through selection and reservation before it can start a child.
        if (!next) { harvestYield = null; await sleep(); continue; }
        if (harvestYield?.row !== next.id) harvestYield = null;
        // Give an already waiting resident harvest its extra child before a
        // cold session. A harvest counts as waiting only when its own agent's
        // window lets it run, which `residentHarvest` already decided, and a
        // cold agent at its own window's pause still yields to one that can.
        //
        // Capacity release is the normal wake: the harvest starting its child
        // is what lets this loop go. The tick is the bound for a harvest that
        // stops being claimable while this loop waits on it. The separate deadline
        // limits the total yield even if the resident never starts. A window that
        // crosses its pause during the resident's turn arrives with no
        // notification and starts no child, so without the bound this loop
        // would wait on a capacity change that never comes.
        if (next.kind !== "harvest" && next.harvest_waiting && !own.session &&
            (harvestYield === null || Date.now() < harvestYield.until)) {
          // One bounded courtesy per selected row, not a fresh wait every tick.
          // A resident stuck starting must not starve unrelated cold work.
          harvestYield ??= { row: next.id, until: Date.now() + 3 * setting(registry, "hub.tick_seconds") * 1000 };
          // The harvest can start while this read is in flight. Its capacity
          // signal must not be lost before this task subscribes to it.
          if (capacityVersion !== observedCapacity) continue;
          await own.noteWait({ kind: "harvest" });
          let wake!: () => void;
          const available = new Promise<void>(resolve => { wake = resolve; capacity.add(wake); });
          try { await Promise.race([available, stopped, own.left, Bun.sleep(setting(registry, "hub.tick_seconds") * 1000)]); }
          finally { capacity.delete(wake); }
          continue;
        }
        await own.noteWait(null);
        if (next && !own.reserved) {
          if (!await admitChild(registry, own)) break;
          own.reserved = true;
        }
        // A request that committed while this loop waited for room: nothing is claimed, and the reservation (with no child behind it) goes back.
        if (moveFences.has(agent.id)) { unreserve(); continue; }
        const extra = next?.kind === "harvest" && own.session !== null;
        if (extra && !await admitChild(registry, own)) break;
        // MEASURED AGAIN HERE, after the admission wait and right before the
        // claim, because a copy that fell behind while this loop waited for
        // capacity is a copy that must claim nothing. What it holds is given
        // back: a harvest's extra child, and a reservation with no session
        // behind it. The row it did not claim waits for a current copy.
        await measureRegistry();
        if (stale) {
          if (extra) releaseCapacity();
          if (!own.session && own.reserved) { own.reserved = false; releaseCapacity(); }
          await sleep();
          continue;
        }
        const row = await claimNext(store, {
          runner: options.runner,
          agent: agent.id,
          leaseMs: setting(registry, "hub.claim_lease_seconds") * 1000,
          maxRank,
          rowId: next.id,
          resumeOk,
          masterBlocked,
        });
        if (!row) {
          if (extra) releaseCapacity();
          if (!own.session && own.reserved) { own.reserved = false; releaseCapacity(); }
          await sleep();
          continue;
        }
        // A fence placed since the selection (a request that committed, a placement that moved): the claim goes straight back and
        // nothing is opened, started or fed for it.
        if (moveFences.has(agent.id)) {
          await store.sql`update inbound set claimed_by = null, claim_deadline = null where id = ${row.id} and claimed_by = ${options.runner}`;
          if (extra) releaseCapacity();
          unreserve();
          continue;
        }
        // THE BRANCH GOES ABOVE THE RESPAWN LINE, and the placement is
        // the contract. A harvest is served by a session of its own, so a build
        // that branched BELOW would kill and respawn the agent's resident
        // session on every harvest, throw away the session L2's whole tail
        // machinery exists to keep, and pay the tail's tokens again every quiet
        // period. `claimNext`'s `returning` already carries the kind, so the
        // branch costs no read.
        claimed = row.id;
        claimedHuman = row.kind !== "harvest";
        // WHETHER THIS IS A COUNCIL MEMBER'S JOB IS KNOWN BEFORE ANYTHING THAT CAN FAIL, from the provenance the claim itself returned. The failure
        // path fences by what the store shows (`fenceAbandonedClaims`), so it does not depend on this, but it names the member it lets the council see
        // and the notice it does not send, and it must not depend on a read (the profile check) having succeeded first.
        claimedSeat = row.kind === "job" && councilOfJob(row.source) !== null ? row : null;
        if (row.kind === "harvest") {
          // NOTHING A HARVEST DOES LEAVES THIS LOOP. `Bun.spawn`
          // throws SYNCHRONOUSLY on a command it cannot find (measured, bun
          // 1.3.14: `ENOENT: no such file or directory, posix_spawn '<path>'`),
          // and `hub.imprnt` is optional and falls back to the bare word
          // `imprnt`, which no rendered unit file puts on a PATH. Without this
          // try the throw leaves `harvestTurn`, leaves this `while`, and lands
          // in the outer catch, which writes one diary line about the AGENT and
          // falls through to the `finally`: the person's own messages stop
          // being answered and nothing in a chat says so.
          //
          // Every other throw site on that path meets the same net: the two
          // reads, the session start, the window record, the staging, the
          // apply, the notice and all three settles. The row goes back on its
          // retry with the failure in its own words, exactly as a note the
          // vault refused does, and the agent goes on serving.
          try {
            await harvestTurn(row, registry);
          } catch (error) {
            await refuseTurn(store, {
              inboundId: row.id,
              runner: options.runner,
              agent: agent.id,
              cause: "other",
              said: `the harvest failed: ${(error as Error).message}`.slice(0, SAID_CAP),
              retryAt: new Date(
                Date.now() + retrySeconds(registry) * 1000,
              ).toISOString(),
              kind: "refused.harvest",
            });
          } finally {
            claimed = null;
            if (extra) releaseCapacity();
            else if (!own.session && own.reserved) { own.reserved = false; releaseCapacity(); }
          }
          continue;
        }
        // THE GATE GOES ABOVE THE RESPAWN LINE, so a job nobody approved starts
        // no child at all. The whole of it is a hash over a string already in
        // hand, so it costs no statement between the claim and the feed.
        claimedProfile = null;
        if (row.kind === "job") {
          // A council's job is launched only under the profile its owner approved (`council/launch.ts`): the worker, its preset (the five settings and the
          // name), its tools, its instruction, settings and MCP files, its runner and its machine, and the conversation it names, compared against the registry
          // THIS launch uses, before a conversation is chosen or a child is started. Whatever the job is (a first input that waited for its machine, a later
          // round, a follow-up, a correction, a retry, a continuation the store queued), a worker that no longer matches is refused by name and nothing is fed.
          const approval = admitJob(row);
          const launch = approval === null ? await checkLaunch(store, { row, registry }) : null;
          const refusal = approval ?? launch?.refusal ?? null;
          if (refusal) {
            await refuseJob(store, { row, refusal, registry, runner: options.runner });
            claimed = null;
            claimedReturn = null;
            claimedSeat = null;
            continue;
          }
          claimedReturn = row.source?.dispatch?.return ?? null;
          // The digest of the accepted profile, kept for the launch below: the session that receives the bytes must have been started under it.
          claimedProfile = launch?.profile ?? null;
        }
        const preset = getPreset(registry, agent.preset);
        const adapter = adapterFor(options.adapters, preset.adapter);
        // WHAT CONVERSATION THIS ROW IS IN. A master has one for good. A new job
        // gets a fresh one, even when this worker served the last job, and a
        // follow-up is put into the one it names. A follow-up that cannot be
        // honoured is refused by name: it is never quietly made a new job.
        let conversation: Conversation;
        try {
          conversation = await conversationFor(store, { row, adapter: preset.adapter, machine });
        } catch (error) {
          // THE STORE PLACES THE CONVERSATION ON ANOTHER MACHINE (a move that went through, while a registry that has not caught up still
          // lists the agent here): not an error to retry and not a failure to tell anyone of. The claim goes back untouched (no retry time,
          // no health row, no notice), the diary says it once, and the agent is fenced from serving until the store places it here again.
          // Any other refusal, and one for a row of any other kind, is what it always was.
          if (elsewhere(error) && row.kind !== "job") {
            await store.sql`update inbound set claimed_by = null, claim_deadline = null where id = ${row.id} and claimed_by = ${options.runner}`;
            claimed = null;
            claimedReturn = null;
            claimedSeat = null;
            unreserve();
            await placedElsewhere();
            await sleep();
            continue;
          }
          if (error instanceof ConversationRefused && error.refusal === "conversation engine mismatch" && row.kind !== "job") {
            await engineMismatch(preset.adapter, registry);
            await store.sql`update inbound set claimed_by = null, claim_deadline = null where id = ${row.id} and claimed_by = ${options.runner}`;
            claimed = null; claimedReturn = null; claimedSeat = null; unreserve();
            await sleep();
            continue;
          }
          if (!(error instanceof ConversationRefused) || row.kind !== "job") throw error;
          await refuseJob(store, { row, refusal: { cause: error.refusal }, registry, runner: options.runner });
          claimed = null;
          claimedReturn = null;
          claimedSeat = null;
          unreserve();
          continue;
        }
        const caps = await capabilities.get(adapter, { registry, agent, preset: agent.preset });
        // A follow-up is a promise that the conversation's context is still
        // there. An engine that cannot be given a session cannot keep that
        // promise, and it says so here rather than answering from nothing.
        if (row.kind === "job" && row.source?.dispatch?.conversation !== undefined && !caps.stableSession) {
          await refuseJob(store, { row, refusal: { cause: "resume unsupported" }, registry, runner: options.runner });
          claimed = null;
          claimedReturn = null;
          claimedSeat = null;
          unreserve();
          continue;
        }
        // A conversation with an interrupted assignment held takes a fresh turn
        // only on a native context that resumes without replaying what was left
        // unfinished. Selection already asked; this is the answer at launch.
        // Where it is no longer yes, the claim goes back and nothing is built
        // from a transcript instead.
        const recoveryHolds = await openHoldsOf(store, conversation.id, true);
        const holds = recoveryHolds.filter(hold => hold.state !== "released");
        const resumeFrom = holds.length > 0 && holds[holds.length - 1].native_session === conversation.native_session
          ? holds[holds.length - 1].native_session : null;
        // A session the engine never acknowledged is not one it can be trusted to
        // resume either, so an uncertain native state blocks like an unvalidated
        // build does. Each block is said once, by name, in the diary.
        const uncertainNative = conversation.native_state === "new" || conversation.native_state === "launched";
        if (holds.length > 0 && (!caps.safeResume || !resumeFrom || uncertainNative)) {
          const why = !caps.safeResume ? "safe-resume-unvalidated" : !resumeFrom ? "no-native-session-recorded" : "native-state-uncertain";
          await store.sql`update inbound set claimed_by = null, claim_deadline = null where id = ${row.id} and claimed_by = ${options.runner}`;
          if (!blockedNoted.has(`${conversation.id}:${why}`)) {
            blockedNoted.add(`${conversation.id}:${why}`);
            // The launch found what selection could not: the owner is told what the conversation is waiting
            // for (once: the block itself repeats on every wake and must not make the tick look every time).
            contextWatch.raise();
            await appendRunnerEntry({ stream: "runner", subject: options.runner, kind: "resume.blocked", actor: "runner",
              detail: { agent: agent.id, conversation: conversation.id, cause: why, native_state: conversation.native_state } });
          }
          claimed = null;
          claimedReturn = null;
          claimedSeat = null;
          unreserve();
          await sleep();
          continue;
        }
        // What the person attached is a file on the door's machine. Served
        // from here, on another machine, the bytes come out of the store into
        // this machine's own inbox first, and the body names them there.
        let text = row.body;
        const attached = Array.isArray(row.source?.media) ? row.source!.media! : [];
        if (attached.length > 0 && chatStateFor(registry, agent.id) === "store") {
          const local = await materializeMedia(store, { stateDir, person: agent.person, inboundId: row.id, media: attached });
          text = rewriteMediaPaths(text, local);
        }
        // A fresh turn beside a held assignment is told about it once per
        // revision, in the conversation's own record, and told not to carry the
        // assignment on. The continuation the owner authorized is not such a
        // turn: it is what the hold was waiting for.
        //
        // IT IS RECORDED AS TOLD ONLY WHEN THE ENGINE HAS IT (`flushContext`, at the
        // receipt or the end of this turn), and not when it is composed: a crash
        // before the feed leaves it untold, and the next fresh turn carries it again.
        const told: string[] = [];
        pendingContext = [];
        for (const hold of recoveryHolds.filter(one => one.continuation_id !== row.id)) {
          const source = `hold:${hold.execution_id}:${hold.revision}`;
          if (await hasEntry(store, conversation.id, source, "recovery")) continue;
          const context = hold.state === "released"
            ? `[Hub recovery context] The owner explicitly chose fresh native context after attempt ${hold.execution_id} ended. Prior native context is unavailable. The interrupted input and its queued continuation remain excluded. Do not continue unfinished work or repeat actions unless the owner gives a new request. Known effects: ${JSON.stringify(hold.effects)}. Nothing was undone.`
            : recoveryContext(hold);
          told.push(context);
          pendingContext.push({ conversation: conversation.id, source, body: context });
        }
        if (told.length > 0) text = `${told.join("\n\n")}\n\n${text}`;
        // A session carries the preset it was started with, so a changed one is
        // a new child, and so is one whose child the memory watch killed. It is
        // also bound to ONE conversation: another's input is never fed to it.
        // The runner process itself never restarts for any of them.
        // A council's job is fed only to a session that was started under the profile its owner approved (`claimedProfile`): a resident child whose configuration
        // was another one (started before an edit and reused after it was undone, or the reverse) is replaced, in the same conversation, and never fed the job.
        const mustSpawn = !own.session || presetId(preset) !== startedWith || own.killed
          || own.conversation !== conversation.id || (caps.stableSession && own.nativeSession !== conversation.native_session) || holds.length > 0
          || (claimedProfile !== null && startedProfile !== claimedProfile);
        const plan = mustSpawn ? await planSession(conversation, adapter, registry, resumeFrom) : null;
        // THE ATTEMPT IS OWNED BEFORE ANYTHING LAUNCHES. The table allows one
        // that is running or unresolved per conversation, so a second launch is
        // refused here by the row and never by a clock: a claim that expired
        // is not evidence that the first process is gone.
        try {
          own.attempt = await openExecution(store, { row, conversation, runner: options.runner, incarnation, digest: taskDigest(text),
            nativeSession: mustSpawn ? plan?.id ?? null : own.nativeSession, evidence: { machine: here.machine, boot_id: here.boot } });
        } catch (error) {
          // Refused by the fence: another attempt of the agent holds the slot, or
          // this claim, this incarnation or this placement is no longer the current
          // one. Nothing was launched and nothing was fed. Only a claim that is
          // still this runner's is given back: it is never cleared for whoever
          // holds it now.
          if (!(error instanceof ExecutionBusy) && !(error instanceof ExecutionNotOwned)) throw error;
          pendingContext = [];
          await store.sql`update inbound set claimed_by = null, claim_deadline = null where id = ${row.id} and claimed_by = ${options.runner}`;
          await appendRunnerEntry({ stream: "runner", subject: options.runner, kind: error instanceof ExecutionBusy ? "execution.busy" : "execution.fenced", actor: "runner",
            detail: { agent: agent.id, conversation: conversation.id, row: row.id,
              ...(error instanceof ExecutionNotOwned ? { reason: error.reason } : {}) } });
          claimed = null;
          claimedReturn = null;
          claimedSeat = null;
          unreserve();
          // A gate placed after the claim may be a move's, whose notification this loop has not heard yet: the watch reads now.
          if (error instanceof ExecutionNotOwned && error.reason === "gate") moves?.refresh();
          await sleep();
          continue;
        }
        handed = false;
        effects = { actions: 0, lastAction: "" };
        try {
          // THE FIRST RESUMED LAUNCH OF A MOVED CONVERSATION re-reads the configuration the move sealed (`moveConfigDrift`): the launch inputs are
          // not left to what the preflight, the import and the serve once saw. A drifted or unreadable one is refused like any feed a move refuses
          // (`MoveNoteRefused`, handed back below): nothing is spawned, the input waits, and it launches once the files are what the move compared.
          // It is asked of every launch in the master conversation (what is owed is the store's: a conversation with none costs one small read). A job
          // is not asked because it cannot be in that conversation: it runs in a worker conversation of its own, or in the worker one it names
          // (`conversationFor` refuses any other), and only the master moves. The other launch of that conversation, the eager start below, asks it too.
          if (mustSpawn && conversation.kind === "master") {
            const drift = await moveConfigDrift(store, registry, options.runner, agent.id, conversation.id);
            if (drift) throw new MoveNoteRefused(drift.move, drift.answer);
          }
          if (mustSpawn) {
            await own.noteWait({ kind: "starting" });
            await spawn(preset, registry, conversation, plan);
            await own.noteWait(null);
          }
          // A session an accepted stop signalled while this attempt was being opened and started is not fed
          // the input that belongs to it; `oneTurn` asks again right before the first byte.
          if (retired()) throw Object.assign(new Error("session-retired"), { retired: true });
          // THE HISTORY A FRESH MASTER CHILD IS OWED RIDES WITH THIS INPUT, and is read now so that this input
          // (claimed, so still waiting) is left out of it. It is background for the engine and only that: `text`
          // stays the input the conversation records and the attempt's digest names.
          const background = contextOwed ? await readBackground(registry) : "";
          // THE RELOCATION NOTES a moved conversation still owes its next real input (never a job's): composed here, before the feed, from what the
          // store owes. A note that cannot be composed as declared is `MoveNoteRefused`, handed back below like any feed the move refused.
          const notes = row.kind === "job" ? [] : await notesOwedTo(store, agent.id, conversation.id);
          await oneTurn({ id: row.id, text }, { preset, registry, source: row.source, kind: row.kind, background, notes });
        } catch (error) {
          // A MOVE WAS REQUESTED BEFORE THIS ATTEMPT'S FIRST FEED (`MoveGated`, or a fence placed after the attempt was opened:
          // `SpawnFenced`): it is handed back, not failed. It must not reach the catch below, which would close the child before any
          // intent, set a retry time and a health row, tell the person the agent is retrying, and end the attempt as undelivered over
          // whatever the store holds. The child stays open for the drain.
          if (!(error instanceof MoveGated) && !(error instanceof SpawnFenced) && !(error instanceof MoveNoteRefused)) throw error;
          await own.noteWait(null);
          try { await handBack(error, row); }
          catch (failure) {
            pendingBack = { error, row };
            process.stderr.write(`move-handback-failed: ${agent.id}: ${safeValue(String((failure as Error)?.message ?? failure)).slice(0, 300)}\n`);
          }
          continue;
        }
        claimed = null;
        claimedReturn = null;
        claimedSeat = null;
        lastWork = Date.now();
      }
    } catch (error) {
      // An explicit stop is answered by the stop, and shutting down or leaving
      // is answered by the `finally` below: both end the attempt there.
      if (stopping || own.leaving || stoppedByRequest()) return;
      // BEFORE THE FIRST AWAIT: an armed trailing write, or an event the adapter still delivers
      // while this waits on the queue and the attempt, must not write the sheet after the
      // transaction below clears it.
      sealTurn();
      const registry = load();
      const taskRetrySeconds = Number(readSetting(registry, "runner.task_retry_seconds") ?? 30);
      const retryAt = new Date(Date.now() + taskRetrySeconds * 1000).toISOString();
      retries.set(agent.id, Date.parse(retryAt));
      await writes;
      const cause = safeValue(`${(error as Error).name}: ${(error as Error).message}`);
      process.stderr.write(finding("en", { code: "child-exit", target: agent.id, cause }) + "\n");
      // AN INPUT THAT REACHED THE ENGINE IS NOT TRIED AGAIN. Whatever ended this
      // turn, the engine may have done any part of it, so the attempt ends here
      // with what can be proved about its processes and the input is held for
      // the owner. Only a failure before the engine was handed the input, or a
      // feed that was rejected, leaves a row that is retried as it always was.
      const ended = await closeAttempt(cause, { notDelivered: (error as { notDelivered?: boolean }).notDelivered === true });
      const held = ended !== null && ended.state !== "failed";
      await store.sql.begin(async tx => {
        const inside = { ...store, sql: tx as unknown as Store["sql"] };
        if (claimed) await clearProgress(inside, claimed);
        // A council member whose attempt ended BEFORE the engine was handed its input is not tried again by
        // the runner as an ordinary job would be: it is the owner's to decide (retry it, replace it, do without
        // it), so its job is gated where it stands and the council names the failure. A member whose input
        // did reach the engine is held by the attempt's own hold, which the council reads the same way. Nothing
        // is given up on, stamped answered or merged, and nobody is told it will be tried again.
        //
        // A member whose attempt ended `failed` was fenced in that very transaction (`endAttempt`, mandatory). EVERY council job this runner still holds
        // for this agent with nothing owned (no attempt that may be running, no hold: it failed before an attempt existed, whichever step it was in,
        // the profile check, the conversation, the capabilities, the opening itself) is fenced HERE, from what the store shows and not from what this
        // loop remembers, first, in the transaction that releases the claims just below: if the fence cannot be written this transaction fails, no
        // claim is released onto a retry time, and the loop that ends by it is followed by a start that fences again before it claims anything
        // (`sweepAbandonedClaims`, at the top of the loop). The council is only shown it afterwards (optional).
        const abandoned = await fenceAbandonedClaims(inside, { runner: options.runner, agent: agent.id, cause });
        const fencedNow = (id: string | null): boolean => id !== null && abandoned.some(one => one.id === id);
        for (const one of abandoned) await noteJobFailed(inside, { job: one.id, source: one.source });
        const seat = claimedSeat && claimed === claimedSeat.id && !held && !fencedNow(claimed) ? claimedSeat : null;
        if (seat !== null) await noteJobFailed(inside, { job: seat.id, source: seat.source });
        if (seat !== null || fencedNow(claimed)) {
          claimedSeat = null;
          claimed = null;
          claimedReturn = null;
          claimedHuman = false;
        }
        await tx`update inbound set claimed_by = null, claim_deadline = null, retry_at = ${retryAt}::timestamptz
          where agent = ${agent.id} and claimed_by = ${options.runner} and state not in ('answered', 'delivered')`;
        await putRow(inside, "agent_health", agent.id, { status: "retry", cause, retry_at: retryAt });
        // The person whose message this child was working on
        // hears that it stopped and when it is tried again, once per message,
        // rather than nothing until the answered clock runs out. A harvest
        // failure tells nobody.
        if (claimed && claimedHuman && !held && listAgents(registry).some(one => one.id === agent.id)) {
          // A job is read back to the agent that dispatched it, which is the
          // only route it has: an agent that works jobs alone has no chat of
          // its own for a notice to land in. The words are cut for the
          // platform the return door speaks, which the dispatcher's own route
          // names, and the chat is the one the job pinned when it was asked.
          const said = claimedReturn
            ? { ...(noticeRoute(registry, claimedReturn.agent)
                ?? { platform: "discord", language: languageOf(registry, agent.person) }),
                route: { door: claimedReturn.door, chat: claimedReturn.chat } }
            : noticeRoute(registry, agent.id);
          // A memory kill reaches here as the child's exit. `own.killed` alone
          // is also set by a credential refusal, which closes the child itself.
          const why = !(error as { childExited?: boolean }).childExited ? "task failed"
            : own.killed ? "memory limit reached" : "child exited";
          if (said) {
            await appendNotice(inside, { person: agent.person, agent: agent.id, ...said,
              body: agentRetry(said.language as Language, { agent: agent.id, cause: why, seconds: taskRetrySeconds }),
              noticeKey: `agent-retry:${claimed}` });
          }
        }
        await appendEntry(inside, { stream: "refusal", subject: agent.id, kind: "refused.turn", actor: "runner",
          detail: { agent: agent.id, error: cause, retry_at: retryAt,
            ...(error instanceof AdapterMissing ? { adapter: safeValue(error.adapter) } : {}) } });
      });
    } finally {
      // NOTHING MORE IS QUEUED FOR A LOOP THAT IS ENDING, and what was queued is refused: the move watch that waits for it looks again
      // (it drains the agent itself once there is no loop).
      own.ending = true;
      const endJobs = (): void => { for (const job of own.jobs.splice(0)) job.reject(Object.assign(new Error("loop-ended"), { loopEnded: true })); };
      endJobs();
      cancelFlush();
      turn = null;
      await writes;
      // A fenced agent's open child is written down (best effort) before ANYTHING below closes it, the attempt's end included; the set
      // is settled again after the close (here, in `closeAttempt`, `dropRetired`), which is the only place it can be sealed.
      await settleFor(own);
      // An attempt still open here was cut off, by the runner stopping, by the
      // agent being dropped or recovered, or by the loop ending under it. It
      // ends with the evidence there is, and its input is held rather than run
      // again by whoever serves this agent next.
      if (own.attempt) {
        await closeAttempt(stopping ? "the runner was stopped" : own.leaving ? "the agent was stopped or recovered" : "the loop ended",
          { requested: stoppedByRequest() }).catch(() => {});
      }
      if (claimed && own.leaving) await clearProgress(store, claimed);
      await own.noteWait(null);
      own.settle();
      if (waiter) await waiter.close();
      if (own.session) {
        // Closed regardless of what the intent above found: this loop is over (a stop, a drop, an error) and nothing else holds the child.
        // If the intent could not be written the child is still owed (the ledger keeps it, and the drain records it late), and nothing
        // here says it is gone.
        const record = own.child && own.child.session === own.session ? own.child : null;
        if (record) { await closeChild(record).catch(() => {}); await settleFor(own); }
        else { readings.delete(own.session); await own.session.close().catch(() => {}); }
      }
      own.session = null;
      own.child = null;
      own.conversation = null;
      await own.facade?.close().catch(() => {});
      own.facade = null;
      if (own.reserved) { own.reserved = false; releaseCapacity(); }
      if (live.get(agent.id) === own) live.delete(agent.id);
      endJobs();
      // What the loop held is let go of: the watch looks at the agent again, now with no loop.
      moves?.refresh();
    }
  };

  const live = new Map<string, Live>();
  /** Loops that were dropped from `live` and are still finishing (closing their child, their harvest session, their last writes): nobody else is told the agent is quiet. */
  const ending = new Map<string, Live>();

  /**
   * THE DRAIN'S VIEW OF THIS PROCESS (`./move.ts`). `quiet` is the loop holding nothing: no attempt of its own, no stop in flight, no
   * harvest, and no child being started or closed (the ledger). `close` closes one open child (recording what became of it) and lets go
   * of it as an idle close does: the session, the conversation, the facade and the reservation. The drain runs inside the agent's loop
   * when it has one, so nothing else of that loop is running while it does.
   */
  const world: DrainWorld = {
    store,
    runner: options.runner,
    incarnation,
    here,
    ledger: children,
    fenced: agent => moveFences.has(agent),
    quiet: agent => {
      if (children.busy(agent) || ending.has(agent)) return false;
      const it = live.get(agent);
      return !it || (it.attempt === null && it.retiring === null && ![...harvestSessions.values()].includes(it));
    },
    async close(record) {
      const it = live.get(record.agent);
      await closeChild(record);
      if (it && it.child === record) {
        it.session = null;
        it.child = null;
        it.conversation = null;
        await it.facade?.close().catch(() => {});
        it.facade = null;
        if (it.reserved) { it.reserved = false; releaseCapacity(); }
      }
    },
    say: sayMove,
  };
  /**
   * AROUND ANY CLOSE THAT IS NOT THE DRAIN'S OWN (an attempt that ended badly, a stop, the loop ending), called BEFORE it and again AFTER
   * it: the SET of a fenced agent's children is settled (`settleSet`), best effort. Before the close the pre-close intents are written
   * (the children closed earlier without proof first, the open one last) and the set is NOT sealed, because the child is still open and
   * the close observes it once more; after the close the final known union (the exit evidence's processes included) is made durable and
   * only then is the set sealed. The close goes ahead whatever this finds (a stop or a shutdown is not held up by a store that cannot be
   * written), but what is written down is what a restarted runner finds of its predecessor, and a set that stopped part way (a crash
   * after the close and before the final write, a final document the store refuses, a failed seal) is never sealed, so the successor
   * does not take the intents it finds for all there was. What is not written stays in the ledger for as long as this process lives
   * and is never certified as gone.
   */
  const settleFor = async (own: Live): Promise<void> => {
    const fence = moveFences.get(own.agent.id);
    if (fence?.kind !== "move" || fence.move === null || children.of(own.agent.id).length === 0) return;
    try {
      const gating = await readMove(store, fence.move);
      if (gating && gating.stage === "waiting" && gating.source_runner === options.runner) await settleSet(world, gating);
    } catch { /* best effort: the children are still owed in the ledger */ }
  };
  /**
   * THE HANDOFF'S VIEW OF THIS PROCESS (`./move-handoff.ts`), what `exportSource`, `prepareDestination`, `importDestination` and `cleanupCopies`
   * are handed. Every fact is read when it is asked and none is remembered:
   * - `build` is a FRESH read of the engine (never the capability cache): its version is what the adapter's measured tables are keyed by;
   * - `sessionDir` is the launch's own rule for THIS machine (`sessionDirFor`);
   * - `scope` is the registry's answer, with a look at this machine's own tree and default instruction files, for what the move carries
   *   (`move-scope.ts`): a proof, or the named refusal of a dependency it does not carry or cannot verify; `localInstructions` is the same look
   *   for the destination's preflight;
   * - `profile` is the destination's binding (this runner's registry, which must be the one measured current), `sourceProfile` the same profile
   *   as the source reads it (`move-profile.ts`);
   * - `effectiveConfig` is what a launch of the agent would read here, as per-move digests (`move-config.ts`); `workspaceFacts`, `sourceWorkspace` and
   *   `destWorkspace` look at the person's declared repositories under the sync's own lock (`move-workspace.ts`). They replace the profile's
   *   unverified-file gates: the content is compared, before the release, before the import and at the serve;
   * - `exclusive` is the chain the launch (`spawn`) takes too;
   * - `idle` is the ledger's and the loop's: no live session, no child owed an account of, no loop still closing.
   */
  const freshBuild = async (agentId: string): Promise<EngineBuild | null> => {
    try {
      const registry = load();
      const agent = listAgents(registry).find(one => one.id === agentId);
      if (!agent) return null;
      const adapter = options.adapters[getPreset(registry, agent.preset).adapter];
      if (!adapter?.capabilities) return null;
      const caps = await adapter.capabilities({ registry, agent, preset: agent.preset });
      if (typeof caps?.version !== "string" || caps.version === "") return null;
      return { version: caps.version, capabilities: JSON.parse(JSON.stringify(caps)) as Record<string, unknown> };
    } catch { return null; }
  };
  const handoff: HandoffWorld = {
    store,
    runner: options.runner,
    incarnation,
    machine,
    port: adapter => options.adapters[adapter]?.session ?? null,
    build: freshBuild,
    sessionDir: move => sessionDirFor(stateDir, move.person, move.agent, move.conversation_id),
    scope: move => { try { return scopeOf(load(), move); } catch { return null; } },
    profile: move => {
      if (stale) return null;
      try {
        const profile = profileOf(load(), move.agent);
        return profile ? { move: move.id, agent: move.agent, runner: options.runner, machine, profile, basis: "this runner's registry: the agent's entry without its runner, and its preset" } : null;
      } catch { return null; }
    },
    sourceProfile: move => { try { return profileOf(load(), move.agent); } catch { return null; } },
    localInstructions: move => { try { return defaultInstructionsOf(load(), move.agent); } catch { return null; } },
    effectiveConfig: (move, registry) => { try { return effectiveConfigOf((registry as Registry | undefined) ?? load(), move.agent, move.id); } catch { return null; } },
    workspaceFacts: move => { try { return workspaceFactsOf(load(), move); } catch { return { refused: "registry" }; } },
    sourceWorkspace: move => observeSource({ registry: load(), storeUrl: store.url }, move),
    destWorkspace: move => observeDest({ registry: load(), storeUrl: store.url }, move),
    exclusive,
    idle: agent => !live.get(agent)?.session && children.of(agent).length === 0 && !ending.has(agent),
    say: sayMove,
  };
  /** What the destination's serve is handed beyond that: the registry file read once, whether the agent is up here, the person's language. */
  const serveWorld: ServeWorld = {
    ...handoff,
    loaded: () => {
      try {
        const digest = registryDigest(options.registryFile);
        const registry = load();
        return registryDigest(options.registryFile) === digest ? { digest, registry } : null;
      } catch { return null; }
    },
    serving: agent => !stale && live.get(agent)?.ending === false,
    language: person => { try { return languageOf(load(), person); } catch { return "en"; } },
  };

  /**
   * What a handoff step is to the watch: the move as the look READ it before deciding (`seen`: never read again after the look's awaits, which
   * would take a change the other side committed meanwhile for one already looked at), and who owes the next look (the store's notification, a
   * poll, or this machine's own facts).
   */
  const quietly = new Set(["dest-not-ready", "blocked", "released", "block-occupied"]);
  const stepOf = (step: HandoffStep, owed: Owed | null, seen: string | null): DrainStep => ({ state: "waiting", why: step.reason, owed, seen });
  /**
   * WHAT A REFUSAL FROM FACTS OF THIS MACHINE WAITS ON: the registry's bytes and whether this copy is measured current, whether the agent's loop is
   * up, and the default instruction files and top level of the person's tree (`localShapeOf`: names, never a content). No move row changes when one
   * of them does, so no notification comes; the tick compares (`Owed` `local`, nothing is asked of the store or of the engine until it differs).
   * The engine's build is NOT here: reading it asks the engine, which is not done on a tick, and nothing this machine's files say moves when it
   * does. A look that was decided from that probe (`probedEngine`: `dest_build_unknown`, `build-unreadable`, `serve_capabilities_changed`, ...) is
   * owed by the clock as well (`engineSlot`, `ENGINE_RECHECK`): one slot compared as a number on the tick, and one look, hence one probe, when it
   * changes. No other look is made again for the engine, and nothing is guessed about what it will say.
   * Taken BEFORE the look decides, so a fact that changed during the look is seen as changed by the debt.
   */
  const localFacts = (agent: string): string => {
    let digest = "";
    try { digest = registryDigest(options.registryFile); } catch { /* unreadable is a state too */ }
    let shape = "";
    try { shape = localShapeOf(load(), agent); } catch { shape = "unreadable"; }
    return `${digest}|${live.get(agent)?.ending === false}|${stale}|${shape}`;
  };
  const engineSlot = (): number => Math.floor(Date.now() / ENGINE_RECHECK.ms);
  const localOwed = (agent: string, was: string, slot: number, step: HandoffStep): Owed => {
    const probed = probedEngine(step);
    return { kind: "local", changed: () => localFacts(agent) !== was || (probed && engineSlot() !== slot) };
  };
  /**
   * The refusals this side sets from those facts, and only those: a `native_export_failed` or an import failure is never retried by this (the
   * owner's withdrawal is its way out), and another party's block is waited out by the store's notification. They are cleared by the same look
   * that sets them (`clearOwn`, only once its own proof succeeds), so a debt here is a re-look and never a clearing.
   */
  const LOCAL_BLOCKS: ReadonlySet<string> = new Set([
    "scope_unsupported", "scope_unproven", "profile_unverified", "source_profile_unbound", "profile_mismatch",
    "dest_profile_unbound", "dest_profile_unverified", "dest_local_unverified", "dest_build_unknown",
    // Facts of this machine's configuration files and checkouts (`localShapeOf`: stat of both, and a bounded re-look for what stat cannot see).
    "config_mismatch", "config_unverifiable", "workspace_unsynced", "workspace_unpushed", "workspace_branch", "workspace_unavailable", "workspace_plan_mismatch",
    "dest_config_unverifiable", "dest_workspace_unavailable",
  ]);
  const ownLocalBlock = (step: HandoffStep, side: "dest" | "source"): boolean =>
    (step.state === "blocked" && (LOCAL_BLOCKS.has(step.reason) || (side === "dest" && step.reason.startsWith("serve_")))) ||
    (side === "dest" && step.state === "waiting" && step.reason === "blocked" && step.detail?.by === "dest");
  /** One look at one move: in the agent's own loop when it has one, and here when it has none (nothing can start a child for a fenced agent). */
  const driveMove = async (request: { id: string; agent: string }): Promise<DrainStep> => {
    const it = live.get(request.agent);
    // A loop that was dropped is still closing what it holds: no look runs beside it. `drop` asks the watch to look again once it is over.
    if (!it && ending.has(request.agent)) return { state: "waiting", why: "loop-ending", owed: { kind: "store" }, seen: null };
    // THE EXPORT IS PART OF THE SAME LOOK THAT SAW THE DRAIN COMPLETE: in the loop's own job (or here with no loop), so nothing can start a
    // child, claim a row or feed between the observation of `drained` and the export's own final asks of fenced and quiet.
    const look = async (): Promise<DrainStep> => {
      const was = localFacts(request.agent);
      const slot = engineSlot();
      const step = await drainSource(world, request.id);
      if (step.state !== "drained") return step;
      const exported = await exportSource(handoff, { fenced: agent => moveFences.has(agent), quiet: agent => world.quiet(agent) }, request.id);
      // `step.seen` is the row the drain read, before the export decided anything: what the export read later, or the other side committed
      // meanwhile, is not taken for seen.
      const owed: Owed | null = exported.state === "waiting" && !quietly.has(exported.reason) ? { kind: "store" }
        : ownLocalBlock(exported, "source") || probedEngine(exported) ? localOwed(request.agent, was, slot, exported) : null;
      return stepOf(exported, owed, step.seen);
    };
    if (!it) return await look();
    try { return await inLoop(it, look); }
    catch (error) {
      if ((error as { loopEnded?: boolean }).loopEnded) return { state: "waiting", why: "loop-ended", owed: { kind: "store" }, seen: null };
      throw error;
    }
  };
  /**
   * One look at one move of which this runner is the DESTINATION: its preflight while the move waits, the import and the activation after the
   * source released, nothing while the hub writes the registry (the hub's notification brings the next look), and the serve once the receipt
   * is in. Nothing here falls back to anything: a destination that is not up never looks, and the move waits.
   */
  const driveDestination = async (request: { id: string; agent: string }): Promise<DrainStep> => {
    // What this look decides from is observed first: the local facts, then the row. Neither is read again to say what the look has seen.
    const was = localFacts(request.agent);
    const slot = engineSlot();
    const move = await readMove(store, request.id);
    if (!move) return { state: "ended", why: "unknown-move", owed: null, seen: null };
    const seen = digestOf(move);
    let step: HandoffStep;
    switch (move.stage) {
      case "waiting": step = await prepareDestination(handoff, move.id); break;
      case "source_released": case "importing": step = await importDestination(handoff, move.id); break;
      case "registry_written": step = await serveDestination(serveWorld, move.id); break;
      default: step = handoffWaiting(`stage:${move.stage}`);
    }
    if (step.state === "waiting" && step.detail?.owed === "local") return stepOf(step, localOwed(move.agent, was, slot, step), seen);
    // A preflight that was recorded is made from this machine's configuration files and checkouts, and the source compares what it recorded: while the
    // move still waits for the source's release, a change of those facts (or the bounded re-look) records it again, so a repair here reaches the source.
    if (move.stage === "waiting" && step.state === "done") return stepOf(step, localOwed(move.agent, was, slot, step), seen);
    // Only the preflight's and the serve's refusals of this machine's own facts, and of a probe of the engine (again by the clock, `ENGINE_RECHECK`),
    // are looked at again when those facts change: an import that failed is never retried by this, and the owner's withdrawal is still its way out.
    if (move.stage !== "source_released" && move.stage !== "importing" && (ownLocalBlock(step, "dest") || probedEngine(step))) return stepOf(step, localOwed(move.agent, was, slot, step), seen);
    // The refusals the import's fresh observations make from this machine's files and checkouts (`destGate`) are looked at again when those change
    // (or after the bounded re-look): the import itself is still never retried by this, only the gate that stands before it.
    if ((move.stage === "source_released" || move.stage === "importing") && step.state === "blocked" && DEST_GATE_CODES.has(step.reason)) return stepOf(step, localOwed(move.agent, was, slot, step), seen);
    const poll = step.state === "waiting" && !step.reason.startsWith("stage:") && !quietly.has(step.reason);
    return stepOf(step, poll ? { kind: "store" } : null, seen);
  };

  const serve = (agent: AgentEntry): void => {
    let release: () => void = () => {};
    const left = new Promise<"stopped">((resolve) => {
      release = () => resolve("stopped");
    });
    let settle: () => void = () => {};
    const serving = new Promise<void>((resolve) => {
      settle = () => resolve();
    });
    let wakeNudge: () => void = () => {};
    const freshNudge = () => new Promise<void>((resolve) => { wakeNudge = resolve; });
    const it: Live = {
      agent,
      reserved: false,
      session: null,
      killed: false,
      boxed: false,
      conversation: null,
      nativeSession: null,
      attempt: null,
      retiring: null,
      facade: null,
      child: null,
      jobs: [],
      ending: false,
      nudging: false,
      nudged: freshNudge(),
      nudge() { it.nudging = true; const woken = wakeNudge; it.nudged = freshNudge(); woken(); },
      leaving: false,
      left,
      release,
      done: Promise.resolve(),
      serving,
      settle,
      noteWait: waitRecorder(store, agent.id),
    };
    live.set(agent.id, it);
    // A loop that ends by a failure of its own (a write its failure path needed and the store refused, for one) is said, and the supervisor serves the
    // agent again after its retry delay; nothing is left as an unhandled rejection of the process, and the attempt it could not end stays owned in
    // the store, where the next start of this runner ends it (and, for a council's member, fences it) exactly as for any attempt.
    it.done = runAgent(agent, it).catch((error: unknown) => {
      process.stderr.write(`agent-loop-ended: ${agent.id}: ${safeValue(String((error as Error)?.message ?? error)).slice(0, 300)}\n`);
    });
  };

  const drop = async (id: string): Promise<void> => {
    const it = live.get(id);
    // An agent that leaves this runner's registry (or is recovered) is judged again from the store if it comes back: a placement fence made
    // from a refusal alone (`move` is null) is forgotten. A move's own fence is never forgotten here, and neither is the placement fence a
    // move that went through left (it names the move): a harvest never asks the conversation, so only that fence keeps a stale registry
    // from serving the agent.
    const fence = moveFences.get(id);
    if (fence?.kind === "placed" && fence.move === null) moveFences.lift(id);
    if (!it) return;
    live.delete(id);
    // It stays tracked until it is fully done: `quiet` and `driveMove` see it ending, so the drain never runs beside its close.
    ending.set(id, it);
    it.leaving = true;
    it.release();
    try { await it.done.catch(() => {}); }
    finally {
      if (ending.get(id) === it) ending.delete(id);
      // The look that was refused while it ended (and any that was owed) is made now, with no loop left.
      moves?.refresh();
    }
  };

  /**
   * On the tick the runner reads each child's memory and kills the one
   * over the limit its OWN `[[run]]` entry carries, with ONE ledger line
   * naming the child, the reading and the limit, because L4 words that line as
   * "killed the transcriber at 2.1 GB" and a line with only one of the two
   * cannot be read.
   *
   * The reading is `/proc/<pid>/status` on linux and `ps -o rss=` on macOS,
   * through the OS seam, which converts kilobytes to bytes at its own edge. It
   * touches no table, so a runner that is waiting still issues nothing.
   *
   * Every descendant contributes to the limit on both supported platforms.
   */
  const watchChildren = async (registry: Registry): Promise<void> => {
    const own = listRunEntries(registry).find((entry) => entry.id === options.runner);
    const limitMb = own?.child_memory_limit_mb;
    if (!limitMb || limitMb <= 0) return;
    const before = measuredBytes;
    measuredBytes = 0;
    for (const it of [...live.values(), ...[...harvestSessions].map(([session, owner]) => ({ ...owner, session, killed: false }))]) {
      const session = it.session;
      const pid = session?.pid ?? null;
      // A hosted loop has no local child for this hub to watch, and a child
      // already killed is not killed twice.
      if (!pid || pid <= 0 || it.killed) continue;
      let bytes = 0;
      try {
        bytes = (await os.memory(pid)).current_bytes;
      } catch {
        continue;
      }
      {
        for (const under of descendantsOf(pid)) {
          try {
            const reading = (await os.memory(under)).current_bytes;
            bytes += reading;
          } catch {
            // It left while the tree was being read, and a process that is
            // gone is using nothing.
          }
        }
      }
      if (it.session !== session) continue;
      readings.set(session!, bytes);
      measuredBytes += bytes;
      peakBytes = Math.max(peakBytes, measuredBytes);
      const budgetMb = own?.child_memory_budget_mb ?? 2048;
      if (bytes <= limitMb * 1024 * 1024 && measuredBytes <= budgetMb * 1024 * 1024) continue;
      // Commit the enforcement record before a child exit can be observed.
      await appendRunnerEntry({
        stream: "memory",
        subject: it.agent.id,
        kind: "killed.child",
        actor: "runner",
        detail: {
          agent: it.agent.id,
          pid,
          reading_bytes: bytes,
          peak_bytes: peakBytes,
          aggregate_bytes: measuredBytes,
          limit_mb: limitMb,
          runner: options.runner,
        },
      });
      it.killed = true;
      try {
        for (const child of descendantsOf(pid).reverse()) { try { process.kill(child, 9); } catch {} }
        process.kill(pid, 9);
      } catch {
        // It went away between the reading and the signal, which is the same
        // outcome by another route.
      }
    }
    // A reading that fell is room an agent may have been waiting for.
    if (measuredBytes < before) capacityChanged();
  };

  /**
   * The copy of the registry this runner reads, measured against the store
   * machine's on every tick. One diary line on each change, so a spoke that
   * went quiet says why, and none at all while nothing changes.
   */
  const measureRegistry = async (): Promise<void> => {
    // The registry as it is NOW, because the authority is a setting in it.
    const standing = await registryStanding(store, { registry: load(), machine, file: options.registryFile });
    if (standing.stale === stale) return;
    stale = standing.stale;
    await appendRunnerEntry({ stream: "runner", subject: options.runner, kind: stale ? "registry.stale" : "registry.current", actor: "runner",
      detail: { machine, file: options.registryFile, ...(stale ? { reason: standing.reason } : {}) } });
  };
  await measureRegistry();
  // THE MOVES THIS RUNNER IS THE SOURCE OF ARE READ, AND THEIR FENCES PLACED, BEFORE ANYTHING IS SERVED: no child is started, no row claimed
  // and no eager start made for an agent a request already gates. A runner that cannot read them does not serve (the schema was checked
  // for migration 16 before anything was opened).
  try {
    moves = await watchMoves(store, { runner: options.runner, machine, fences: moveFences, drive: driveMove,
      driveDest: driveDestination, cleanup: () => cleanupCopies(handoff),
      lifted: agent => live.get(agent)?.nudge(), say: sayMove });
  } catch (error) { await store.close().catch(() => {}); throw error; }
  for (const agent of agentsFor(first, { runner: options.runner })) {
    if (!stale && Date.now() >= (retries.get(agent.id) ?? 0)) serve(agent);
  }
  // Ready means SERVING, so a caller that is handed this runner is handed one
  // whose agents are up and fed rather than one that is still starting, and its
  // startup work lands before anything that was waiting on it starts watching.
  await Promise.all([...live.values()].map((it) => it.serving));

  const recovering = new Set<string>();
  /** The runner's end of the store's stop requests, opened below; the tick asks it to look again only while a request is owed. */
  let stops: Awaited<ReturnType<typeof watchStops>> | undefined;
  let seenLimits = JSON.stringify(runnerAdmission(listRunEntries(first).find(one => one.id === options.runner) ?? {}));
  const supervise = (async () => {
    while (!stopping) {
      await Promise.race([Bun.sleep(setting(first, "hub.tick_seconds") * 1000), stopped]);
      if (stopping) break;
      let registry: Registry;
      try {
        registry = load();
      } catch {
        // A file half written by an editor is one this tick cannot read. The
        // next tick reads the finished one and nothing is dropped meanwhile.
        continue;
      }
      try {
        await measureRegistry();
        const wanted = agentsFor(registry, { runner: options.runner });
        for (const agent of wanted) if (!stale && !live.has(agent.id) && !recovering.has(agent.id) && Date.now() >= (retries.get(agent.id) ?? 0)) serve(agent);
        for (const id of [...live.keys()]) {
          if (!wanted.some((agent) => agent.id === id)) await drop(id);
        }
        // A registry edit that changes what this runner admits takes effect
        // within a tick, the way every routine edit does: the agents waiting
        // on admission are woken to read the new numbers.
        const limits = JSON.stringify(runnerAdmission(listRunEntries(registry).find(one => one.id === options.runner) ?? {}));
        if (limits !== seenLimits) {
          seenLimits = limits;
          capacityChanged();
        }
        await watchChildren(registry);
        // A process that was not shown to be gone may be by now. Looked at
        // only while there is one, and only proof moves an attempt. The watch goes down only on a
        // look during which no other attempt was left unresolved (`unknownWatch`).
        if (unresolvedWatch.watching) await unresolvedWatch.look(() => reevaluateUnknown(store, { runner: options.runner, registry, here, moved: () => contextWatch.raise() }));
        // A stop request that was deferred, or whose look failed (a read, a write, the stop itself), is owed
        // another look, and the notification that announced it is not repeated. Asked to look only while one
        // is owed, and not waited for: a stop can take as long as its grace, and the tick goes on. Nothing is
        // read while nothing is owed.
        if (stops?.owed) stops.retry();
        // A move's drain that is owed another look: the store's answer, or evidence that may have moved on this machine (read by the process
        // table alone: nothing is read from the store unless it did). Nothing is asked while nothing is owed.
        if (moves?.owed) moves.tick();
        // A held conversation's native context is measured whether or not any row of it can be claimed
        // (an engine not shown able to resume is filtered out of every claim), so the owner is told what
        // it is waiting for. Only while there is one to measure; a full look that measured them all lowers it.
        if (contextWatch.watching) await contextWatch.look(() => reconcileContexts(store, { runner: options.runner, registry, readingFor }));
        // A result the model finished and the store would not take is settled from
        // its journal as soon as the store will. An attempt a live turn is settling
        // itself is left to that turn.
        // THE WATCH IS SWITCHED OFF ONLY BY A LOOK AT EVERY ATTEMPT OF THIS RUNNER, and
        // only when nothing came to be owed while that look was in progress. A settle
        // of one attempt says nothing about another that still owes its answer.
        if (watchJournal) {
          const mark = journalMark;
          const settling = new Set<string>([...live.values()].map(it => it.attempt?.id).filter((id): id is string => typeof id === "string"));
          const owed = await settleStored(store, { runner: options.runner, skip: settling });
          if (owed === 0 && mark === journalMark) watchJournal = false;
        }
      } catch {
        // A tick that could not finish is a tick. The next one runs.
      }
    }
  })();

  const recovered = new Set<string>();
  const recoverAgent = async (request: { id: string; agent: string }) => {
    if (recovered.has(request.id)) return;
    const registry = load();
    const agent = agentsFor(registry, { runner: options.runner }).find(one => one.id === request.agent);
    if (!agent) throw new Error("unknown-agent");
    recovering.add(agent.id);
    try {
      await drop(agent.id);
      // The owner's recovery frees what the runner held, and does not feed a council member's input that never reached an engine: it is fenced first.
      await sweepAbandonedClaims(store, { runner: options.runner, agent: agent.id, cause: "the agent was recovered before an attempt was opened for this input: nothing shows it was handed to an engine" });
      await store.sql`update inbound set claimed_by = null, claim_deadline = null, retry_at = null
        where agent = ${agent.id} and (claimed_by = ${options.runner} or claimed_by is null)
          and state not in ('answered', 'delivered')`;
      retries.delete(agent.id);
      // The session is gone and the claims are released, which is the whole
      // of what was asked. A copy that is behind starts nothing in its place:
      // the supervisor serves the agent again once the copy is current.
      await measureRegistry();
      if (!stale) serve(agent);
      recovered.add(request.id);
    } finally { recovering.delete(agent.id); }
  };
  /** The end of an attempt whose session was signalled, from what the signal proved. It can be made again: it is only writes. */
  const endStopped = async (execution: string, evidence: Promise<ExitEvidence | null>): Promise<{ state: string; revision: number | null }> => {
    let known: Registry | null = null;
    try { known = load(); } catch { known = null; }
    const ended = await endAttempt(store, { execution, evidence: await evidence, cause: "stop requested", requested: true, registry: known });
    if (ended.state === "stop_unknown" || ended.state === "unknown") unresolvedWatch.raise();
    if (ended.revision !== null) contextWatch.raise();
    if (ended.state === "journaled") {
      // The stop landed after the model finished. What is owed is the settle of the
      // answer it produced, not an interruption of it: it is settled from the
      // journal now if the store will take it, and on every tick until it does.
      owesJournal();
      await settleStored(store, { runner: options.runner, only: execution });
      const after = await readExecution(store, execution);
      return { state: after?.state ?? "journaled", revision: null };
    }
    return { state: ended.state, revision: ended.revision };
  };
  /**
   * Stop the attempt an agent is running, if this process is running it. The answer is
   *   `none`     this process is not running that attempt, or it is running it but the store does not
   *              say it is in a state a stop applies to (it settled, ended, or another caller's stop
   *              is not this one's to repeat): NOTHING was signalled and nothing was marked, and the
   *              caller judges the request from the store;
   *   `opening`  the attempt is this process's and is passing from claimed to fed: either the store still
   *              says claimed (its loop has not yet handed it to a session, and the resident session that
   *              may still be there belongs to whatever ran before), or the statement below met it claimed
   *              and the loop fed it before the read that followed. Not signalled, not marked; the request
   *              is looked at again, and the next look finds it fed and stops it;
   *   otherwise  the attempt's own state after the stop.
   *
   * THE ORDER, and why. (1) The store decides: the attempt is moved to `stop_requested` only from a
   * fed state, and only what that statement RETURNS says it was moved (a row already `stop_requested`
   * is a stop accepted earlier and not yet signalled, and is accepted again). (2) What was read before
   * the await is read again after it: the same Live, running the same attempt. The attempt can settle
   * and the next input can be opened during the await, and the attempt is then somebody else's.
   * (3) THE SESSION IS THE ONE THE ACCEPTED ATTEMPT HAS WHEN THE ACCEPTANCE IS SEEN, read after the
   * await and never before it. An attempt that is only claimed has no session of its own yet: a fresh
   * child is installed (`spawn`) and fed while this statement is in flight, and the session read before
   * it was the previous one or none. The loop installs the session before it feeds, and it does not
   * replace the session of an attempt it has fed (a new session belongs to the next attempt, which the
   * attempt check rejects), so the store's acceptance of a fed attempt names the session the Live holds
   * once the answer is back. That session is read in the same synchronous step as the check, and the
   * retirement is recorded in that step, naming the attempt and that session; it is what forbids any
   * later feed to that session, and the one signal is sent to it, by the value read here and not by
   * whatever `it.session` is later. A stop that fails at (1) records nothing at all, so a database
   * failure leaves no intent behind, and one that loses at (2) clears nothing that another caller accepted.
   */
  const stopExecution = async (request: { agent: string; execution?: string; graceMs?: number }): Promise<{ state: string; revision: number | null }> => {
    const none = { state: "none", revision: null };
    const opening = { state: "opening", revision: null };
    const it = live.get(request.agent);
    const attempt = it?.attempt ?? null;
    if (!it || !attempt || (request.execution !== undefined && attempt.id !== request.execution)) return none;
    /**
     * A stop already accepted for this very attempt on the session named is that same stop, waited for (and its
     * ending made again if it failed). The session is an argument, so each caller says which one it means.
     */
    const standing = (session: AdapterSession | null): Promise<{ state: string; revision: number | null }> | null => {
      const held = it.retiring;
      return held && session !== null && held.execution === attempt.id && held.session === session
        ? held.done.catch(() => (held.done = endStopped(attempt.id, held.evidence)))
        : null;
    };
    // Only a shortcut: a stop that was accepted for what is running now is waited for and the store is not asked again.
    const again = standing(it.session);
    if (again) return await again;
    const moved = await store.sql`update execution set state = 'stop_requested'
      where id = ${attempt.id} and state in ('feed_intent', 'received', 'running') returning id`;
    if (moved.length === 0) {
      const now = await readExecution(store, attempt.id);
      if (now?.state === "claimed") return opening;
      // The statement met the attempt claimed and the loop fed it before this read: it is still this process's, still
      // passing from claimed to fed, and not "not held here". Saying `none` would have the caller end a live, held
      // attempt from its record without signalling it. Asked again by the caller's own bounded look, with the same checks.
      if ((now?.state === "feed_intent" || now?.state === "received" || now?.state === "running")
          && live.get(request.agent) === it && it.attempt?.id === attempt.id) return opening;
      if (now?.state !== "stop_requested") return none;
    }
    // What was read before an await is only good if it is still the case.
    const accepted = it.session;
    if (live.get(request.agent) !== it || it.attempt?.id !== attempt.id || accepted === null) return none;
    const meanwhile = standing(accepted);
    if (meanwhile) return await meanwhile;
    // Only an engine that can say what it left behind can be stopped truthfully;
    // one that cannot is asked nothing and reported as not proved. The signal is sent
    // ONCE, here, to the session accepted above, and only after the retirement is recorded.
    const evidence = accepted.interrupt ? Promise.resolve().then(() => accepted.interrupt!({ graceMs: request.graceMs ?? 5000 })).catch(() => null) : Promise.resolve(null);
    const retiring: NonNullable<Live["retiring"]> = { execution: attempt.id, session: accepted, evidence, done: undefined as never };
    it.retiring = retiring;
    retiring.done = endStopped(attempt.id, evidence);
    return await retiring.done;
  };
  const controls = await watchControls(store, "runner", data => data.target_kind === "agent" &&
    agentsFor(load(), { runner: options.runner }).some(a => a.id === data.target_id),
    async data => { await recoverAgent({ id: String(data.id), agent: String(data.target_id) }); },
    { registry: () => load() });
  // Durable stop requests for the attempts this runner owns: read at start and on the
  // store's own notification, and stopped with `stopExecution` above (see `./stops.ts`).
  const watching = await watchStops(store, { runner: options.runner, incarnation, here, registry: () => load(),
    stop: request => stopExecution(request),
    moved: what => { if (what === "unresolved") unresolvedWatch.raise(); else if (what === "hold") contextWatch.raise(); else owesJournal(); } });
  stops = watching;
  return {
    runner: options.runner,
    recoverAgent,
    stopExecution,
    async stop() {
      stopping = true;
      release();
      await controls.close();
      await watching.close();
      // The loops are ending (`release`), and a look that waits for one is released by it ending: closing waits for every consumer.
      await moves?.close();
      await supervise;
      await Promise.allSettled([...live.values(), ...ending.values()].map((it) => it.done));
      // Nobody is measuring any more, so nothing measured is left standing as current.
      await markContextPending(store, options.runner).catch(() => {});
      if (peakBytes > 0) await appendRunnerEntry({ stream: "memory", subject: options.runner,
        kind: "peak.children", actor: "runner", detail: { peak_bytes: peakBytes } });
      await store.close();
    },
  };
}
