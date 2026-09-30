import { executeHarvest } from "../harvest/execute.ts";
import { watchControls } from "../hub/control.ts";
import { prepareReply } from "../door/reply.ts";
import type { InboundSource } from "../store/inbound.ts";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { bootId, descendantsOf } from "../os/tree.ts";
import { adapterFor, loopLaunch } from "../adapters/index.ts";
import { AdapterMissing, FeedNotWritten, type Adapter, type AdapterSession, type ExitEvidence, type TurnEnd } from "../adapters/types.ts";
import { credentialSource, type HubMcpServer } from "../adapters/launch.ts";
import { boxContextFor } from "../box/index.ts";
import { readTail } from "../chatlog.ts";
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
import { entryMachine, loadRegistry, readSetting, type AgentEntry, type Registry } from "../registry/load.ts";
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
  activateProtocol,
  completeTail,
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
  openTailExecution,
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
import { abandonJob, admitJob, refuseJob } from "./job.ts";
import { clearProgress, writeProgress, type TurnProgress } from "./progress.ts";
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
   * nothing is retried.
   */
  stopExecution(request: { agent: string; graceMs?: number }): Promise<{ state: string; revision: number | null }>;
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
  /** An explicit stop is in progress: the loop ending under it is the stop, not a failure. */
  stopRequested: boolean;
  /** The hub's tool facade bound to this child's launch, closed with it. */
  facade: FacadeBinding | null;
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
  tail: boolean;
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
    sessionDir: join(stateDir, agent.person, "sessions", agent.id, conversation.id),
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
  const admitChild = async (registry: Registry, own: Live, reserve = true): Promise<boolean> => {
    let recorded = false;
    while (!stopping && !own.leaving) {
      // Read again on every pass, because a registry edit that raises the
      // count or the budget is one of the things this wait is woken for.
      const entry = listRunEntries(load()).find(one => one.id === options.runner);
      const limits = runnerAdmission(entry ?? {});
      const reserveMb = limits.reserve_mb;
      const usedMb = Math.max(reservations * reserveMb, measuredBytes / 1048576);
      const roomByCount = reservations < limits.max_active_children;
      if (roomByCount && usedMb + reserveMb <= limits.child_memory_budget_mb) {
        if (reserve) reservations++;
        if (recorded) await own.noteWait(null);
        return true;
      }
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
        ? { kind: "memory", budget_mb: limits.child_memory_budget_mb, used_mb: Math.round(usedMb), reserve_mb: reserveMb }
        : { kind: "slots", count: limits.max_active_children, holders: [...new Set([
            ...[...live.values()].filter(other => other.reserved && other !== own).map(other => other.agent.id),
            ...[...harvestSessions.values()].map(owner => owner.agent.id),
          ])] });
      // Woken by a child starting or being released, by the tick seeing a
      // changed limit or a fallen aggregate reading, and by the tick itself
      // as the bound: the re-check above is in memory and reads no table, so
      // the bound costs the store nothing and a runner whose slots are all
      // held by residents still asks again within a tick.
      let wake!: () => void;
      const available = new Promise<void>(resolve => { wake = resolve; capacity.add(wake); });
      try { await Promise.race([available, stopped, own.left, Bun.sleep(setting(registry, "hub.tick_seconds") * 1000)]); }
      finally { capacity.delete(wake); }
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
    let unhealthy = retries.has(agent.id);
    /** The last answer to "can this engine resume an interrupted conversation", to notice it flip. */
    let lastResumeOk: boolean | null = null;
    let turn: OpenTurn | null = null;
    let waiter: Waiter | null = null;
    /**
     * Whether the engine may have been handed anything of the open attempt (the
     * priming tail counts, as the input does): true from the moment a feed intent
     * is committed until the attempt ends. A rejected feed does NOT make it false;
     * only the adapter's own proof that nothing was written (`FeedNotWritten`), of
     * a first feed with no effects, lets the attempt end as never given the input.
     */
    let handed = false;
    let effects = { actions: 0, lastAction: "" };
    /** The process tree of the open attempt, recorded so that a crash can be judged against it. */
    const noteTree = async (): Promise<void> => {
      const attempt = own.attempt;
      const tree = own.session?.processes?.() ?? null;
      if (attempt && tree) {
        await notePids(store, attempt.id, { leader: own.session?.pid ?? null, pids: tree, group: own.session?.group?.() ?? null,
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
      if (session) {
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
      own.conversation = null;
      await own.facade?.close().catch(() => {});
      own.facade = null;
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
      if (turn !== open || open.sealed || !open.started || !open.unwritten) return;
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
      if (!open.sealed) write(() => writeProgress(store, progressOf(open)));
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

    const oneTurn = async (
      message: { id: string; text: string },
      about: { preset: Preset; tail: boolean; registry: Registry; source?: InboundSource | null; kind?: string },
    ): Promise<void> => {
      let finish: (end: TurnEnd) => void = () => {};
      const ended = new Promise<TurnEnd>((resolve) => {
        finish = resolve;
      });
      turn = {
        id: message.id,
        person: agent.person,
        agent: agent.id,
        tail: about.tail,
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
        finish,
      };
      const opened = turn;
      // EVERY FEED, of an input or of a priming tail, goes to an attempt that is owned
      // and whose feed intent is committed first. A tail is a model turn and can do
      // things, so the tail of a claimed row's fresh child is a feed of that row's
      // attempt (`stage: "tail"`), and the tail an eager start owns has an attempt of
      // its own. There is no feed to an engine without one.
      if (!own.attempt) throw new Error("feed-without-attempt");
      // WHAT IS KNOWN OF THE PROCESSES IS RECORDED FIRST, and only then the intent:
      // a crash between the two would otherwise leave an attempt that may have
      // reached the engine with no process, no group and no boot on record, and
      // nothing could ever show it over.
      await noteTree();
      // Whether anything was fed to THIS attempt before this feed: the priming tail of a claimed row's fresh
      // child is a feed of that row's attempt, and a model turn that may have done things.
      const priorFeed = handed;
      // COMMITTED BEFORE THE FIRST BYTE, with the input as the conversation's
      // own entry, and fenced by the claim, the incarnation and the placement. From
      // here a crash, an exit or a killed child is uncertain: the engine may have
      // done any of it, and nothing feeds it again.
      await markFeedIntent(store, own.attempt, message.text, about.tail && own.attempt.purpose === "turn" ? "tail" : "input");
      handed = true;
      // A REJECTED FEED IS NOT PROOF THAT NOTHING WAS DELIVERED. Only the adapter's own `FeedNotWritten`
      // says so (it refused before a byte was written), and even that lets the input be tried again only
      // if nothing else was fed to this attempt first and it has done nothing. A write or a flush that
      // failed, a pipe that broke, a rejection with no name: any of them may have come after the engine
      // had some or all of it, and stay uncertain, held, exactly like a crash after the call.
      const delivering = Promise.resolve().then(() => own.session!.feed(message)).catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        throw error instanceof FeedNotWritten && !priorFeed && effects.actions === 0 ? Object.assign(failure, { notDelivered: true }) : failure;
      });
      delivering.catch(() => {});
      await Promise.race([delivering, stopped, own.left, failedSession(own.session!)]);
      // The agent is SERVED from here: its session is up and it has been handed
      // the tail of its own log. What the loop answers to that tail can take as
      // long as a loop takes, and a runner that reported itself ready only
      // after it would be a runner a service manager waits on for a model.
      if (about.tail) own.settle();
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
        tail: about.tail,
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

      // The tail's own answer is not a reply to anybody, so it is recorded and
      // dropped. Only a turn fed from an inbound row reaches the outbox. A tail the
      // loop REFUSED is not an answered tail: it is ended below, like any refused turn.
      if (about.tail && !end.refused) {
        await appendRunnerEntry({
          stream: "turn",
          subject: agent.id,
          kind: "turn",
          actor: "runner",
          detail: record as unknown as Record<string, unknown>,
        });
        // The tail an eager start owned is over, and the agent is free.
        if (own.attempt?.purpose === "tail") {
          await completeTail(store, own.attempt);
          own.attempt = null;
          handed = false;
        }
        return;
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
        // (its feed intent is committed and the adapter took it), a riding tail may already have run
        // tools, and a terminal failure of the adapter is not a reason to feed it again (design §4: the
        // engine's own retry and backoff happen inside the one attempt; once it reports a terminal
        // failure the assignment is not fed again without the owner's choice). A refusal ending the TURN
        // says nothing about the process: it is alive, and so may be anything it started, so it is no
        // proof that the attempt is over. The child is closed and what the process table says of it is
        // the evidence, exactly as for any other end; the next turn starts a child of its own. Confirmed
        // only if it really is gone. A council seat is held the same way and is not given up on: its
        // council waits for its owner. Only a row that was never fed is retried, and none gets here.
        //
        // A REFUSED PRIMING TAIL IS THE SAME, and is never completed: it was a model turn the engine was
        // handed, so its attempt ends with the evidence of its processes (an eager tail's attempt is
        // `interrupted` only if they are shown gone, otherwise `unknown` and the agent's slot stays taken;
        // a riding tail holds the claimed row, with the effects seen). A tail asks nothing of anybody, so an
        // eager one has no input to hold and no owner to ask, and nothing is fed after a refused riding one.
        const heldRow = about.tail ? own.attempt?.inbound_id ?? null : message.id;
        if (own.attempt) {
          await closeAttempt(`the loop refused the ${about.tail ? "priming tail" : "turn"}: ${end.refused.cause}`);
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
        if (heldRow !== null) {
          await refuseTurn(store, {
            inboundId: heldRow,
            runner: options.runner,
            agent: agent.id,
            cause: end.refused.cause,
            said: end.refused.said,
            retryAt: null,
            kind: refusedKind,
          });
        } else {
          // An eager tail has no row: the line is about the agent.
          await appendRunnerEntry({
            stream: "refusal",
            subject: agent.id,
            kind: refusedKind,
            actor: "runner",
            detail: { agent: agent.id, runner: options.runner, cause: end.refused.cause, said: end.refused.said, retry_at: null, purpose: "tail" },
          });
        }
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

      if (unhealthy) { await removeRow(store, "agent_health", agent.id); unhealthy = false; retries.delete(agent.id); }
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

    const spawn = async (preset: Preset, registry: Registry, conversation: Conversation, plan: { id: string; resume: boolean } | null): Promise<void> => {
      preflight(registry, agent);
      const adapter = adapterFor(options.adapters, preset.adapter);
      if (own.session) { readings.delete(own.session); await own.session.close().catch(() => {}); own.session = null; own.conversation = null; }
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
      own.conversation = conversation.id;
      own.nativeSession = plan?.id ?? null;
      own.boxed = "wrap" in launch;
      // A child the watch killed is a session that is gone, and this is where
      // it comes back: before the next turn, with the runner never restarting.
      own.killed = false;
      startedWith = presetId(preset);

      session.onReceipt((messageId) => {
        const open = turn;
        if (!open || open.acked || messageId !== open.id) return;
        open.acked = true;
        if (open.tail) {
          // The engine took the tail: the session it was launched under is one it
          // has acknowledged, so a restart resumes it instead of starting it over.
          write(async () => {
            if (own.attempt?.purpose === "tail") await markProgress(store, own.attempt.id, "received");
            if (plan) await noteNative(store, conversation.id, "started");
          });
          return;
        }
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
        if (open.tail) {
          // A tail is a model turn and may start tools of its own: what it starts is
          // recorded on the progress cadence, as for any turn, so a crash inside it is
          // judged against every process it was seen to start.
          if (event.kind === "action" && Date.now() - open.wroteAt >= setting(registry, "hub.tick_seconds") * 1000) {
            open.wroteAt = Date.now();
            write(noteTree);
          }
          return;
        }
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

      // A spawned session has no memory of what was said, so the tail of the
      // log is the first thing it is fed and a human message is never the first.
      //
      // AN AGENT WITH NO CHAT HAS NO TAIL, and its entry is what says so: it
      // takes jobs alone, and a job's body is its whole input. That is a
      // declared empty tail, and a different thing from an agent whose chat log
      // lives on another machine, which is read from the store below. Whatever
      // sits where a chat log would be is not this agent's conversation,
      // because no door writes one for an agent with no door.
      //
      // A JOB'S CHILD IS NOT GIVEN THE TAIL EITHER, and neither is a resumed
      // one: a worker's context is its brief and its own transcript, and must not
      // include what a configured seat's chat said before this job; a resumed
      // session already has what it had.
      if (agent.chat === undefined || conversation.kind !== "master" || plan?.resume) return;
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
      // handed it as a turn of its own, so inside the tail it would be the same
      // message twice: the loop is told not to answer the tail, and a loop
      // that reads a task there still runs it.
      //
      // ONE SNAPSHOT FOR BOTH READS. The waiting set and the store's own lines
      // are two statements, and a message the door commits between them, with
      // a platform time before the cutoff, would sit in the tail unexcluded and
      // then be claimed and fed again as a turn. Under repeatable read the
      // second statement sees exactly the rows the first did.
      const tail = await store.sql.begin("isolation level repeatable read read only", async (tx) => {
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
      if (tail !== "") {
        // PRIMING THE TAIL IS A MODEL TURN, so it is owned like one. A start that no
        // claimed row is behind (the eager start of a resident) opens an attempt of
        // its own for it, fenced by the incarnation and the placement, and the table
        // allows one attempt per agent: a child that has been handed the tail
        // beside another attempt of the agent cannot exist. A start that a claimed
        // row asked for is already inside that row's attempt.
        //
        // FOR EVERY ENGINE, WHATEVER IT CAN REPORT. An engine that cannot show what it
        // left behind is not primed unowned: it is owned like any other, and a tail
        // that completes releases its own attempt (nothing is claimed about a process
        // it was never asked about). One that is cut off is `unknown` for as long as
        // nothing shows its process gone (a reboot does, by the boot recorded here), so
        // the agent's slot stays taken and nobody else starts beside it.
        if (own.attempt === null) {
          handed = false;
          effects = { actions: 0, lastAction: "" };
          try {
            own.attempt = await openTailExecution(store, { agent: agent.id, conversation, runner: options.runner, incarnation,
              digest: taskDigest(tail), nativeSession: plan?.id ?? null, evidence: { machine: here.machine, boot_id: here.boot } });
          } catch (error) {
            if (!(error instanceof ExecutionBusy) && !(error instanceof ExecutionNotOwned)) throw error;
            // REFUSED BY NAME BEFORE ANYTHING WAS GENERATED: another attempt of the agent holds the
            // slot, or this incarnation or placement is no longer current. The child was never
            // handed a byte, so it is closed and the first row that can be claimed starts one.
            await appendRunnerEntry({ stream: "runner", subject: options.runner, kind: "tail.refused", actor: "runner",
              detail: { agent: agent.id, conversation: conversation.id, cause: error.message } });
            readings.delete(session);
            await session.close().catch(() => {});
            own.session = null;
            own.conversation = null;
            await own.facade?.close().catch(() => {});
            own.facade = null;
            return;
          }
        }
        await oneTurn({ id: agent.id, text: tail }, { preset, tail: true, registry });
      }
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
      // its master conversation. One with no chat takes jobs alone, and every
      // job has a conversation of its own, so a child started now would only be
      // closed by the first of them: it starts with its first job.
      // NOR IS ONE STARTED BESIDE AN ATTEMPT THAT MAY STILL BE RUNNING, or beside
      // an interrupted assignment: another process for that conversation is
      // exactly what an unresolved attempt forbids, and what would be started
      // is not what is asked for anyway. The first row it can claim starts it.
      const [standing] = (await store.sql`select hub_agent_blocked(${agent.id}) as blocked,
        exists (select 1 from replay_hold h join conversation c on c.id = h.conversation_id
                 where c.agent = ${agent.id} and h.state <> 'released') as held`) as unknown as { blocked: boolean; held: boolean }[];
      if (lifetimeFor(initial, agent.id).mode === "resident" && !lifetimeFor(initial, agent.id).sleeping && agent.chat !== undefined
          && !standing.blocked && !standing.held) {
        if (!await admitChild(initial, own)) return;
        // A copy that fell behind during the admission wait spawns nothing:
        // the reservation goes back and the supervisor serves this agent
        // again once the copy is current.
        await measureRegistry();
        if (stale) { releaseCapacity(); return; }
        own.reserved = true;
        await own.noteWait({ kind: "starting" });
        const eagerPreset = getPreset(initial, agent.preset);
        const eager = adapterFor(options.adapters, eagerPreset.adapter);
        const master = await conversationFor(store, { row: { id: agent.id, person: agent.person, agent: agent.id, kind: "human" }, adapter: eagerPreset.adapter, machine });
        await spawn(eagerPreset, initial, master, await planSession(master, eager, initial, null));
        await own.noteWait(null);
      }
      // An agent whose log had no tail to feed is served the moment its session
      // is up, and this is where that one settles.
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
        const registry = load();
        agent = listAgents(registry).find(one => one.id === agent.id) ?? agent;
        const lifetime = lifetimeFor(registry, agent.id);
        if (own.session && (lifetime.sleeping || lifetime.mode === "on-demand" && Date.now() - lastWork >= lifetime.idle_seconds * 1000)) {
          readings.delete(own.session);
          await own.session.close();
          own.session = null;
          own.conversation = null;
          await own.facade?.close().catch(() => {});
          own.facade = null;
          if (own.reserved) { own.reserved = false; releaseCapacity(); }
        }
        if (lifetime.sleeping || stale) {
          await Promise.race([Bun.sleep(setting(registry, "hub.tick_seconds") * 1000), stopped, own.left]);
          continue;
        }
        const sleep = async (): Promise<void> => {
          await Promise.race([
            waiter!
              .wait(setting(registry, "hub.tick_seconds") * 1000)
              .catch(() => "timeout" as const),
            stopped,
            own.left,
            ...(own.session && !own.killed ? [failedSession(own.session)] : []),
          ]);
        };

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
        try {
          // Every path that can pick a row asks the same three questions: is it
          // an interrupted input, does its agent have an attempt whose
          // ownership is unresolved, and does its conversation need a resume
          // this engine has not shown it can do. A lease that ran out answers
          // none of them.
          [next] = await connection`select id, kind, hub_row_needs_resume(id, agent, kind, source) as needs_resume, exists (
            select 1 from inbound h where h.agent in (select jsonb_array_elements_text(${JSON.stringify(residentHarvest)}::text::jsonb)) and h.kind = 'harvest'
              and h.log_ready and h.state not in ('answered', 'delivered') and h.claimed_by is null
              and (h.retry_at is null or h.retry_at <= now())
          ) as harvest_waiting from inbound where agent = ${agent.id}
            and log_ready and state not in ('answered', 'delivered') and rank <= ${maxRank}
            and (claimed_by is null or claimed_by = ${options.runner}
                 or (claim_deadline is not null and claim_deadline <= now()))
            and (retry_at is null or retry_at <= now())
            and not hub_row_held(id)
            and not (case when kind = 'harvest' then hub_harvest_blocked(agent, ${options.runner}::text) else hub_agent_blocked(agent) end)
            and (${resumeOk}::boolean or not hub_row_needs_resume(id, agent, kind, source))
            order by rank, received_at, id limit 1`;
        } finally { connection.release(); }
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
        });
        if (!row) {
          if (extra) releaseCapacity();
          if (!own.session && own.reserved) { own.reserved = false; releaseCapacity(); }
          await sleep();
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
        if (row.kind === "job") {
          const refusal = admitJob(row);
          if (refusal) {
            await refuseJob(store, { row, refusal, registry, runner: options.runner });
            claimed = null;
            claimedReturn = null;
            continue;
          }
          claimedReturn = row.source?.dispatch?.return ?? null;
          claimedSeat = row.source?.dispatch?.approved?.source === "council" ? row : null;
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
        const holds = next.needs_resume ? await openHoldsOf(store, conversation.id) : [];
        const resumeFrom = holds.length > 0 ? holds[holds.length - 1].native_session : null;
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
        for (const hold of holds.filter(one => one.continuation_id !== row.id)) {
          const source = `hold:${hold.execution_id}:${hold.revision}`;
          if (await hasEntry(store, conversation.id, source, "recovery")) continue;
          const context = recoveryContext(hold);
          told.push(context);
          pendingContext.push({ conversation: conversation.id, source, body: context });
        }
        if (told.length > 0) text = `${told.join("\n\n")}\n\n${text}`;
        // A session carries the preset it was started with, so a changed one is
        // a new child, and so is one whose child the memory watch killed. It is
        // also bound to ONE conversation: another's input is never fed to it.
        // The runner process itself never restarts for any of them.
        const mustSpawn = !own.session || presetId(preset) !== startedWith || own.killed
          || own.conversation !== conversation.id || holds.length > 0;
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
          await sleep();
          continue;
        }
        handed = false;
        effects = { actions: 0, lastAction: "" };
        if (mustSpawn) {
          await own.noteWait({ kind: "starting" });
          await spawn(preset, registry, conversation, plan);
          await own.noteWait(null);
        }
        // A priming tail the loop refused has ended this attempt and held the row (`oneTurn`): the
        // input is not fed after it, to a child that was closed or to a new one.
        if (!own.attempt) {
          pendingContext = [];
          claimed = null;
          claimedReturn = null;
          claimedSeat = null;
          lastWork = Date.now();
          continue;
        }
        await oneTurn({ id: row.id, text }, { preset, tail: false, registry, source: row.source, kind: row.kind });
        claimed = null;
        claimedReturn = null;
        claimedSeat = null;
        lastWork = Date.now();
      }
    } catch (error) {
      // An explicit stop is answered by the stop, and shutting down or leaving
      // is answered by the `finally` below: both end the attempt there.
      if (stopping || own.leaving || own.stopRequested) return;
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
        // A council seat whose turn failed after the council's grace has run
        // out is given up on rather than retried: the person has already read
        // that the council is late, and a seat retried for ever holds the
        // merge back for ever. Settled here, so the retry below never sees it.
        if (claimedSeat && claimed === claimedSeat.id) {
          const grace = Number(readSetting(registry, "hub.job_grace_seconds") ?? 300) * 1000;
          const convened = Date.parse(String(claimedSeat.source?.dispatch?.approved?.at ?? ""));
          // A seat whose input reached the engine is held, or its ownership is
          // unresolved: `abandonJob` leaves it alone, and the council waits for
          // its attempt or its owner instead of merging without it.
          if (Number.isFinite(convened) && Date.now() > convened + grace
              && await abandonJob(inside, { row: claimedSeat, runner: options.runner, cause })) {
            // Settled, so nothing below may say it stopped and will be tried
            // again: that line would be false, and it would carry the seat's
            // id into the chat that asked the question.
            claimedSeat = null;
            claimed = null;
            claimedReturn = null;
            claimedHuman = false;
          }
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
      cancelFlush();
      turn = null;
      await writes;
      // An attempt still open here was cut off, by the runner stopping, by the
      // agent being dropped or recovered, or by the loop ending under it. It
      // ends with the evidence there is, and its input is held rather than run
      // again by whoever serves this agent next.
      if (own.attempt) {
        await closeAttempt(stopping ? "the runner was stopped" : own.leaving ? "the agent was stopped or recovered" : "the loop ended",
          { requested: own.stopRequested }).catch(() => {});
      }
      if (claimed && own.leaving) await clearProgress(store, claimed);
      await own.noteWait(null);
      own.settle();
      if (waiter) await waiter.close();
      if (own.session) { readings.delete(own.session); await own.session.close().catch(() => {}); }
      own.session = null;
      own.conversation = null;
      await own.facade?.close().catch(() => {});
      own.facade = null;
      if (own.reserved) { own.reserved = false; releaseCapacity(); }
      if (live.get(agent.id) === own) live.delete(agent.id);
    }
  };

  const live = new Map<string, Live>();

  const serve = (agent: AgentEntry): void => {
    let release: () => void = () => {};
    const left = new Promise<"stopped">((resolve) => {
      release = () => resolve("stopped");
    });
    let settle: () => void = () => {};
    const serving = new Promise<void>((resolve) => {
      settle = () => resolve();
    });
    const it: Live = {
      agent,
      reserved: false,
      session: null,
      killed: false,
      boxed: false,
      conversation: null,
      nativeSession: null,
      attempt: null,
      stopRequested: false,
      facade: null,
      leaving: false,
      left,
      release,
      done: Promise.resolve(),
      serving,
      settle,
      noteWait: waitRecorder(store, agent.id),
    };
    live.set(agent.id, it);
    it.done = runAgent(agent, it);
  };

  const drop = async (id: string): Promise<void> => {
    const it = live.get(id);
    if (!it) return;
    live.delete(id);
    it.leaving = true;
    it.release();
    await it.done.catch(() => {});
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
  for (const agent of agentsFor(first, { runner: options.runner })) {
    if (!stale && Date.now() >= (retries.get(agent.id) ?? 0)) serve(agent);
  }
  // Ready means SERVING, so a caller that is handed this runner is handed one
  // whose agents are up and fed rather than one that is still starting, and its
  // startup work lands before anything that was waiting on it starts watching.
  await Promise.all([...live.values()].map((it) => it.serving));

  const recovering = new Set<string>();
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
  const stopExecution = async (request: { agent: string; graceMs?: number }): Promise<{ state: string; revision: number | null }> => {
    const it = live.get(request.agent);
    const attempt = it?.attempt ?? null;
    if (!it || !attempt) return { state: "none", revision: null };
    it.stopRequested = true;
    await store.sql`update execution set state = 'stop_requested'
      where id = ${attempt.id} and state in ('feed_intent', 'received', 'running')`;
    // Only an engine that can say what it left behind can be stopped truthfully;
    // one that cannot is asked nothing and reported as not proved.
    const evidence = it.session?.interrupt ? await it.session.interrupt({ graceMs: request.graceMs ?? 5000 }).catch(() => null) : null;
    let known: Registry | null = null;
    try { known = load(); } catch { known = null; }
    const ended = await endAttempt(store, { execution: attempt.id, evidence, cause: "stop requested", requested: true, registry: known });
    if (ended.state === "stop_unknown" || ended.state === "unknown") unresolvedWatch.raise();
    if (ended.revision !== null) contextWatch.raise();
    if (ended.state === "journaled") {
      // The stop landed after the model finished. What is owed is the settle of the
      // answer it produced, not an interruption of it: it is settled from the
      // journal now if the store will take it, and on every tick until it does.
      owesJournal();
      await settleStored(store, { runner: options.runner, only: attempt.id });
      const after = await readExecution(store, attempt.id);
      return { state: after?.state ?? "journaled", revision: null };
    }
    return { state: ended.state, revision: ended.revision };
  };
  const controls = await watchControls(store, "runner", data => data.target_kind === "agent" &&
    agentsFor(load(), { runner: options.runner }).some(a => a.id === data.target_id),
    async data => { await recoverAgent({ id: String(data.id), agent: String(data.target_id) }); },
    { registry: () => load() });
  return {
    runner: options.runner,
    recoverAgent,
    stopExecution,
    async stop() {
      stopping = true;
      release();
      await controls.close();
      await supervise;
      await Promise.allSettled([...live.values()].map((it) => it.done));
      // Nobody is measuring any more, so nothing measured is left standing as current.
      await markContextPending(store, options.runner).catch(() => {});
      if (peakBytes > 0) await appendRunnerEntry({ stream: "memory", subject: options.runner,
        kind: "peak.children", actor: "runner", detail: { peak_bytes: peakBytes } });
      await store.close();
    },
  };
}
