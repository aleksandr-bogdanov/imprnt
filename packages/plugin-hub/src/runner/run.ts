import { executeHarvest } from "../harvest/execute.ts";
import { watchControls } from "../hub/control.ts";
import { prepareReply } from "../door/reply.ts";
import type { InboundSource } from "../store/inbound.ts";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { adapterFor, loopLaunch } from "../adapters/index.ts";
import { AdapterMissing, type Adapter, type AdapterSession, type TurnEnd } from "../adapters/types.ts";
import { credentialSource } from "../adapters/launch.ts";
import { boxContextFor } from "../box/index.ts";
import { readTail } from "../chatlog.ts";
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
  lifetimeFor,
  runnerLimitsFor,
  languageOf,
  listAgents,
  listRunEntries,
} from "../registry/entries.ts";
import { loadRegistry, readSetting, type AgentEntry, type Registry } from "../registry/load.ts";
import {
  credentialOfPreset,
  getPreset,
  presetId,
  priceFor,
  windowThresholds,
  type Preset,
  type WindowThresholds,
} from "../registry/presets.ts";
import { openStore, storeUrlAs, type Store } from "../store/connect.ts";
import { appendNotice } from "../store/outbox.ts";
import { openWorkWaiter, type EligibleRow, type Waiter } from "../store/wake.ts";
import { claimNext } from "./claim.ts";
import { clearProgress, writeProgress } from "./progress.ts";
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
}

/**
 * One agent this runner is serving right now.
 *
 * The set is reconciled on the tick (D-87), so adding an agent to the registry
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
   * pid it holds (03b item 1's own regression, REVIEW.md D3).
   */
  boxed: boolean;
  leaving: boolean;
  /** Resolves when this agent alone is asked to leave. */
  left: Promise<"stopped">;
  release(): void;
  done: Promise<void>;
  /** Resolves once this agent's loop is up, or has given up trying. */
  serving: Promise<void>;
  settle(): void;
}

/** The turn that is open right now. One message per turn, never two. */
interface OpenTurn {
  id: string;
  person: string;
  agent: string;
  tail: boolean;
  acked: boolean;
  started: boolean;
  /** D-124. What the loop has done so far, and when it started doing it. */
  actions: number;
  lastAction: string;
  startedAt: string;
  /** When the sheet was last written, for the throttle that is a TIME. */
  wroteAt: number;
  finish(end: TurnEnd): void;
}

function setting(registry: Registry, key: string): number {
  return Number(readSetting(registry, key));
}

function noticeRoute(registry: Registry, id: string) {
  const agent = listAgents(registry).find(one => one.id === id)!;
  const door = (registry.data.run as { id: string; platform?: string }[]).find(one => one.id === agent.door);
  return { route: { door: agent.door, chat: agent.chat }, platform: door?.platform ?? "discord", language: languageOf(registry, agent.person) };
}

/**
 * D-112. How long a runner waits before it tries a refused credential again.
 * L10 rule 3's fixed interval, and v2's own was five minutes.
 */
function retrySeconds(registry: Registry): number {
  const said = readSetting(registry, "hub.outage_retry_seconds");
  return typeof said === "number" && said > 0 ? said : 300;
}

/** D-124. The open turn, as the sheet the door reads it off. */
function progressOf(open: {
  id: string;
  person: string;
  agent: string;
  actions: number;
  lastAction: string;
  startedAt: string;
}): {
  messageId: string;
  person: string;
  agent: string;
  actions: number;
  lastAction: string;
  startedAt: string;
} {
  return {
    messageId: open.id,
    person: open.person,
    agent: open.agent,
    actions: open.actions,
    lastAction: open.lastAction,
    startedAt: open.startedAt,
  };
}

/** D-121. The credential this agent's outage is keyed by, from the agent in hand. */
function credentialFor(registry: Registry, agent: AgentEntry): string {
  return credentialOfPreset(registry, agent.preset) ?? `preset:${agent.preset}`;
}

/**
 * D-122. One line per PERSON, and the agent on the row is the FIRST agent of
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
  const rows = (await store.sql`select person, agent from inbound
                                where state not in ('answered', 'delivered')`) as unknown as {
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
 * D-98's residue: the household's own check that two runners share one store
 * could observe one server and could not rule out a second hidden one, because
 * `application_name` says who connected and nothing says WHERE. `initdb`
 * generates a `system_identifier` per cluster, so a runner that writes the one
 * it sees has said which cluster it is talking to in a way nothing on the
 * client side could have invented, and `check` compares it with the identifier
 * of the store IT is reading.
 *
 * It is stream `runner` and not `machine`, because `machine` is the hub's and
 * `ledger_event_hub_writes` fences it. It is ONE statement pair at connect,
 * which D-85 already allows and which lands long before any wait window opens,
 * so a waiting runner still issues nothing at all.
 *
 * A RUNNER THAT COULD NOT READ THE IDENTIFIER SAYS WHY. It used to write an
 * empty one, and an empty identifier is the one value `check` cannot tell from
 * a healthy runner, so a runner pointing at the wrong cluster could go on
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

/** Configuration and filesystem work happen only when a session starts. */
async function launchFor(registry: Registry, agent: AgentEntry, presetName: string, purpose: "ordinary" | "harvest") {
  const stateDir = String(readSetting(registry, "hub.state_dir") ?? "");
  const credential = credentialOfPreset(registry, presetName);
  return loopLaunch({ registry, agent, preset: getPreset(registry, presetName), purpose,
    ...(credential ? { credential: credentialSource(registry, presetName) } : {}),
    sessionDir: join(stateDir, agent.person, "sessions", agent.id, crypto.randomUUID()),
    box: boxContextFor(registry, agent.id),
  });
}

/**
 * Every process under this one, on linux, host pids.
 *
 * THE BOX TOOL IS NOT THE LOOP (REVIEW.md D3, the regression 03b item 1
 * introduced). `bwrap` spawns the command inside a new pid namespace and stays
 * outside it, so the pid the adapter hands up is the wrapper's, its resident
 * size is a megabyte or two, and a `child_memory_limit_mb` read off it can
 * never trip. The tree is not one level deep either: without `--as-pid-1` the
 * namespace's pid 1 is bwrap's own reaper and the loop is the reaper's child,
 * so a watch that took "the child" literally would read the reaper and be just
 * as blind. This walks the whole tree.
 *
 * `/proc/<pid>/task/<pid>/children` is the kernel's own list and is one read.
 * A kernel built without it answers nothing, so the fallback is the walk every
 * process table tool does: every numeric entry under `/proc` whose `stat` names
 * this pid as its parent. The `comm` field is parenthesised and may hold spaces
 * and parentheses of its own, so the fields are taken from after the LAST close
 * parenthesis, which is the only parse of that file that is not a guess.
 */
function childrenOf(pid: number): number[] {
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    return result.stdout.toString().trim().split("\n").map(line => line.trim().split(/\s+/).map(Number))
      .filter(row => row[1] === pid).map(row => row[0]);
  }
  try {
    const listed = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (listed !== "") {
      return listed
        .split(/\s+/)
        .map((one) => Number(one))
        .filter((one) => Number.isFinite(one) && one > 0);
    }
    return [];
  } catch {
    // This kernel does not publish the list, so it is read off the table below.
  }
  const out: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      // After the comm field come state and then ppid.
      if (Number(fields[1]) === pid) out.push(Number(entry));
    } catch {
      // A process that left between the listing and the read, which is a
      // process that is not under anything any more.
    }
  }
  return out;
}

/** The same tree, flattened, with a depth bound so a cycle cannot spin it. */
function descendantsOf(pid: number): number[] {
  const seen = new Set<number>();
  let frontier = childrenOf(pid);
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const one of frontier) {
      if (seen.has(one) || one === pid) continue;
      seen.add(one);
      next.push(...childrenOf(one));
    }
    frontier = next;
  }
  return [...seen];
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
  const first = loadRegistry(options.registryFile);
  // The memory reader for this platform. Nothing else of the seam is used here:
  // a model child is a child of its runner with no unit of its own (D7).
  const os = thisOs();
  const stateDir = String(readSetting(first, "hub.state_dir"));
  // Connecting is the read that surfaces the rows that waited while this runner
  // was down. The notifications they emitted are long gone, so nothing asks.
  const store: Store = await openStore({
    // D-85. The runner names itself to the server once, at connect, so a silent
    // runner is DERIVED from the server's own view of its clients and no
    // heartbeat is written on any tick.
    url: storeUrlAs(String(readSetting(first, "hub.store_url")), "hub_runner", options.runner),
  });
  await sayWhichServer(store, first, options.runner);

  let stopping = false;
  let release: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    release = () => resolve("stopped");
  });

  const retries = new Map<string, number>();
  for (const row of await readSheet(store, "agent_health")) {
    const due = Date.parse(String(row.data.retry_at));
    if (Number.isFinite(due)) retries.set(row.id, due);
  }
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
    const entry = listRunEntries(registry).find(one => one.id === options.runner);
    const limits = entry ? runnerLimitsFor(registry, options.runner) : { max_active_children: 4, child_memory_budget_mb: 2048 };
    const limitMb = entry?.child_memory_limit_mb ?? limits.child_memory_budget_mb;
    // Reserve the smaller per-child ceiling where possible; a ceiling equal
    // to the fleet budget shares that budget across its declared slots. The
    // monitor also enforces actual aggregate use, including descendants.
    const reserveMb = limitMb < limits.child_memory_budget_mb ? limitMb : limits.child_memory_budget_mb / limits.max_active_children;
    let recorded = false;
    while (!stopping && !own.leaving) {
      if (reservations < limits.max_active_children && Math.max(reservations * reserveMb, measuredBytes / 1048576) + reserveMb <= limits.child_memory_budget_mb) {
        if (reserve) reservations++;
        return true;
      }
      own.settle();
      if (!recorded) {
        recorded = true;
        await appendRunnerEntry({ stream: "runner", subject: own.agent.id, kind: "admission.wait", actor: "runner",
          detail: { cause: "admission", children: reservations, reserved_mb: reservations * reserveMb, peak_bytes: peakBytes } });
        continue;
      }
      let wake!: () => void;
      const available = new Promise<void>(resolve => { wake = resolve; capacity.add(wake); });
      try { await Promise.race([available, stopped, own.left]); }
      finally { capacity.delete(wake); }
    }
    return false;
  };
  const failedSession = (session: AdapterSession): Promise<never> => session.exited
    ? session.exited.then(exit => {
      throw Object.assign(new Error(safeValue((exit as { cause?: string })?.cause ?? "child-exited")), { childExited: true });
    })
    : new Promise<never>(() => {});
  const preflight = (registry: Registry, agent: AgentEntry) => {
    const entries = listRunEntries(registry);
    if (entries.find(one => one.id === agent.door) && entries.find(one => one.id === agent.door)?.machine !== entries.find(one => one.id === agent.runner)?.machine)
      throw new Error("agent-state-unavailable");
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
    let claimed: string | null = null;
    /** Whether that claim is a person's message rather than a harvest. */
    let claimedHuman = false;
    let unhealthy = retries.has(agent.id);
    let turn: OpenTurn | null = null;
    let waiter: Waiter | null = null;
    /** This agent stopped claiming because the household's window is used up. */
    let heldByWindow = false;
    /** RUN-18. One notice per person, and never a second one for the same outage. */
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
     * RUN-18. It works again, once per person, carrying that person's own count.
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

    /** RUN-19. One line per person at the notice threshold, keyed on the reset. */
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
     * RUN-19. This agent's unfinished rows wait for the window's own reset.
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
                         and (retry_at is null or retry_at < ${until})`;
    };

    /**
     * The hold is off, so the rows are eligible NOW and not at the old reset.
     * Without this a released household would wait out a reset that has already
     * stopped meaning anything (04-CONTEXT's harness amendment to D-123).
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
    let writes = Promise.resolve();
    let writeFailed: Error | null = null;
    const write = (what: () => Promise<void>) => {
      writes = writes.then(what).catch((error: Error) => {
        writeFailed ??= error;
      });
    };

    const oneTurn = async (
      message: { id: string; text: string },
      about: { preset: Preset; tail: boolean; registry: Registry; source?: InboundSource | null },
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
        finish,
      };
      const opened = turn;
      await Promise.race([own.session!.feed(message), stopped, own.left, failedSession(own.session!)]);
      // The agent is SERVED from here: its session is up and it has been handed
      // the tail of its own log. What the loop answers to that tail can take as
      // long as a loop takes, and a runner that reported itself ready only
      // after it would be a runner a service manager waits on for a model.
      if (about.tail) own.settle();
      const end = await Promise.race([ended, stopped, own.left, failedSession(own.session!)]);
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

      // RUN-19. The household's one row, written by whichever turn reported a
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
      // dropped. Only a turn fed from an inbound row reaches the outbox.
      if (about.tail) {
        await appendRunnerEntry({
          stream: "turn",
          subject: agent.id,
          kind: "turn",
          actor: "runner",
          detail: record as unknown as Record<string, unknown>,
        });
        return;
      }

      // RUN-18. A turn the loop refused writes NO chunk and NO stamp. The row
      // goes back on a recorded retry, the diary says why, and the person is
      // told once about the CAUSE rather than once about every message of
      // theirs that is waiting on it.
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
        await refuseTurn(store, {
          inboundId: message.id,
          runner: options.runner,
          agent: agent.id,
          cause: end.refused.cause,
          said: end.refused.said,
          retryAt,
          // D-156, D-177. The diary names the refusal for what it is: only a
          // credential-scoped one opens an outage below, so only that one is
          // written as `refused.outage`. A local one keeps one agent on a
          // retry and nothing else, and a household counting its outages by
          // this line would otherwise count one that never opened.
          kind: scope.scope === "local" ? "refused.local" : "refused.outage",
        });
        if (scope.scope === "local") {
          unhealthy = true;
          await putRow(store, "agent_health", agent.id, { status: "retry", cause: safeValue(end.refused.said), retry_at: retryAt });
          return;
        }
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

      // D-124's last write: the totals, before the settle that takes the row
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
      await settleTurn(store, {
        inboundId: message.id,
        person: agent.person,
        source: about.source,
        chunks: prepareReply(end.text, about.source?.log_id.split(":")[0] ?? noticeRoute(about.registry, agent.id).platform, languageOf(about.registry, agent.person)),
        turn: record,
      });
    };

    /**
     * D-148 to D-159. A harvest turn, which touches the agent's own session not
     * at all.
     *
     * It opens a session of its OWN under the harvester's preset, in the
     * person's vault root, feeds it one message, closes it, files what came
     * back through the household's `imprnt`, and settles the watermark with the
     * turn. `own.session`, `own.killed`, `startedWith` and `turn` are never
     * read or written here, so nothing of the agent's turn machinery can see a
     * harvest: no receipt, no progress, no `acked` and no `started` stamp, and
     * therefore no typing, no progress line and no clock line about a row
     * nobody sent (D-155, and D-143 is its belt and braces).
     */
    const harvestTurn = (row: EligibleRow, registry: Registry) => executeHarvest({
      store, registry, agent, row, runner: options.runner, stateDir, adapters: options.adapters,
      stopped: Promise.race([stopped, own.left]),
      opened: session => { harvestSessions.set(session, own); capacityChanged(); },
      closed: session => { harvestSessions.delete(session); readings.delete(session); },
    });

    const spawn = async (preset: Preset, registry: Registry): Promise<void> => {
      preflight(registry, agent);
      const adapter = adapterFor(options.adapters, preset.adapter);
      if (own.session) { readings.delete(own.session); await own.session.close().catch(() => {}); }
      const launch = await launchFor(registry, agent, agent.preset, "ordinary");
      own.session = await adapter.start({
        preset,
        sessionId: null,
        ...launch,
      });
      own.boxed = "wrap" in launch;
      // A child the watch killed is a session that is gone, and this is where
      // it comes back: before the next turn, with the runner never restarting.
      own.killed = false;
      const session = own.session;
      startedWith = presetId(preset);

      session.onReceipt((messageId) => {
        const open = turn;
        if (!open || open.tail || open.acked || messageId !== open.id) return;
        open.acked = true;
        write(() => stamp(store, { messageId: open.id, kind: "acked", actor: "runner" }));
      });
      session.onProgress((event) => {
        const open = turn;
        if (!open || open.tail) return;
        if (!open.started) {
          open.started = true;
          open.startedAt = new Date().toISOString();
          write(() => stamp(store, { messageId: open.id, kind: "started", actor: "runner" }));
          // One write at `started`, which is what gives the door a line to post
          // for a turn that never calls a tool at all (MSG-10's own case).
          open.wroteAt = Date.now();
          write(() => writeProgress(store, progressOf(open)));
        }
        if (event.kind !== "action") return;
        open.actions += 1;
        open.lastAction = event.text;
        // D-124. THROTTLED BY TIME AND NEVER PER ACTION. A per-action rule
        // makes the store's write rate, the notification rate and the
        // platform's edit rate a function of how many tools a turn calls, and a
        // turn can call two hundred. Both platforms rate-limit edits. The
        // cadence is the hub's own, so no second setting exists to be the same
        // number.
        const every = setting(registry, "hub.tick_seconds") * 1000;
        if (Date.now() - open.wroteAt < every) return;
        open.wroteAt = Date.now();
        write(() => writeProgress(store, progressOf(open)));
      });
      session.onTurnEnd((end) => turn?.finish(end));

      // A spawned session has no memory of what was said, so the tail of the
      // log is the first thing it is fed and a human message is never the first.
      const tail = await readTail({
        stateDir,
        person: agent.person,
        agent: agent.id,
        now: new Date(),
        hours: setting(registry, "hub.tail_hours"),
        tokens: setting(registry, "hub.tail_tokens"),
      });
      if (tail !== "") await oneTurn({ id: agent.id, text: tail }, { preset, tail: true, registry });
    };

    try {
      // The LISTEN is opened before the first read of the table and held across
      // every wait after it, so a row committed between a read that found
      // nothing and the wait that follows is announced to a listener that
      // already exists. Opened after the read, that notification is emitted to
      // nobody and the row waits for the tick.
      waiter = await openWorkWaiter(store, { agent: agent.id });
      const initial = loadRegistry(options.registryFile);
      preflight(initial, agent);
      // RUN-19 AFTER A RESTART. The hold outlives the process that opened it:
      // the rows keep the window's reset as their `retry_at`, and only the way
      // out of the hold clears it. A loop that started with the flag false
      // would find the window already fine, never take that way out, and leave
      // the rows waiting out a reset that no longer means anything (phase 4's
      // own residue). The household's open window outage is the hold as the
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
      if (lifetimeFor(initial, agent.id).mode === "resident" && !lifetimeFor(initial, agent.id).sleeping) {
        if (!await admitChild(initial, own)) return;
        own.reserved = true;
        await spawn(getPreset(initial, agent.preset), initial);
      }
      // An agent whose log had no tail to feed is served the moment its session
      // is up, and this is where that one settles.
      own.settle();
      /**
       * WHY THIS LOOP STILL ASKS ON ITS BOUND (03b row 6, D-70, and the reason
       * it is NOT closed).
       *
       * `docs/SPEC.md:17` says the runner reads its eligible rows on connect
       * and after every turn, wakes itself on a recorded deadline, and never
       * polls on a timer, and a bare timeout is none of those. This round
       * gated the claim on the wake reason exactly as that reads, and the hub
       * box then failed `test/runner-drain.test.ts` in THREE of four full suite
       * runs while passing it alone every time: a notification the runner has
       * to hear does not reach it under load there, and with no read on the
       * bound the row it announced is never claimed at all. The tick was
       * covering that, which nobody had written down, and taking the cover away
       * without knowing what is dropping the notification trades a statement a
       * second for a message a household never gets an answer to.
       *
       * So the gate is reverted and the debt is recorded rather than closed.
       * What ships from that work is the half that stands on its own: the
       * statement probe that could not see a bound query at all, and a waiter
       * with no listener answering its caller `notified` instead of `timeout`
       * (`src/store/wake.ts`), which the door needed too and had no tick
       * behind it.
       */
      while (!stopping && !own.leaving) {
        // Before each turn, because a preset or a rate is a registry edit and
        // the agent picks it up on its next turn without anything restarting.
        const registry = loadRegistry(options.registryFile);
        agent = listAgents(registry).find(one => one.id === agent.id) ?? agent;
        const lifetime = lifetimeFor(registry, agent.id);
        if (own.session && (lifetime.sleeping || lifetime.mode === "on-demand" && Date.now() - lastWork >= lifetime.idle_seconds * 1000)) {
          readings.delete(own.session);
          await own.session.close();
          own.session = null;
          if (own.reserved) { own.reserved = false; releaseCapacity(); }
        }
        if (lifetime.sleeping) {
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

        // RUN-19. THE WINDOW IS READ HERE AND NOWHERE ELSE: beside the claim,
        // on a wake the runner was already having, and never on a timer of its
        // own (D-123). An agent on a per-token key has no window and this costs
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
        const residentHarvest = agentsFor(registry, { runner: options.runner })
          .filter(one => lifetimeFor(registry, one.id).mode === "resident" && !lifetimeFor(registry, one.id).sleeping)
          .map(one => one.id);
        const observedCapacity = capacityVersion;
        const connection = await store.sql.reserve();
        let next;
        try {
          [next] = await connection`select id, kind, exists (
            select 1 from inbound h where h.agent in (select jsonb_array_elements_text(${JSON.stringify(residentHarvest)}::text::jsonb)) and h.kind = 'harvest'
              and h.log_ready and h.state not in ('answered', 'delivered') and h.claimed_by is null
              and (h.retry_at is null or h.retry_at <= now())
          ) as harvest_waiting from inbound where agent = ${agent.id}
            and log_ready and state not in ('answered', 'delivered') and rank <= ${maxRank}
            and (claimed_by is null or claimed_by = ${options.runner}
                 or (claim_deadline is not null and claim_deadline <= now()))
            and (retry_at is null or retry_at <= now())
            order by rank, received_at, id limit 1`;
        } finally { connection.release(); }
        // Capacity belongs to this selected row. A later arrival must go
        // through selection and reservation before it can start a child.
        if (!next) { await sleep(); continue; }
        // Give an already waiting resident harvest its extra child before a
        // cold session. Capacity release, rather than a queue poll, wakes us.
        if (next && next.kind !== "harvest" && next.harvest_waiting && !own.session) {
          // The harvest can start while this read is in flight. Its capacity
          // signal must not be lost before this task subscribes to it.
          if (capacityVersion !== observedCapacity) continue;
          let wake!: () => void;
          const available = new Promise<void>(resolve => { wake = resolve; capacity.add(wake); });
          try { await Promise.race([available, stopped, own.left]); }
          finally { capacity.delete(wake); }
          continue;
        }
        if (next && !own.reserved) {
          if (!await admitChild(registry, own)) break;
          own.reserved = true;
        }
        const extra = next?.kind === "harvest" && own.session !== null;
        if (extra && !await admitChild(registry, own)) break;
        const row = await claimNext(store, {
          runner: options.runner,
          agent: agent.id,
          leaseMs: setting(registry, "hub.claim_lease_seconds") * 1000,
          maxRank,
          rowId: next.id,
        });
        if (!row) {
          if (extra) releaseCapacity();
          if (!own.session && own.reserved) { own.reserved = false; releaseCapacity(); }
          await sleep();
          continue;
        }
        // D-148. THE BRANCH GOES ABOVE THE RESPAWN LINE, and the placement is
        // the contract. A harvest is served by a session of its own, so a build
        // that branched BELOW would kill and respawn the agent's resident
        // session on every harvest, throw away the session L2's whole tail
        // machinery exists to keep, and pay the tail's tokens again every quiet
        // period. `claimNext`'s `returning` already carries the kind, so the
        // branch costs no read.
        claimed = row.id;
        claimedHuman = row.kind !== "harvest";
        if (row.kind === "harvest") {
          // REVIEW M1. NOTHING A HARVEST DOES LEAVES THIS LOOP. `Bun.spawn`
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
        const preset = getPreset(registry, agent.preset);
        // A session carries the preset it was started with, so a changed one is
        // a new child, and so is one whose child the memory watch killed. The
        // runner process itself never restarts for either.
        if (!own.session || presetId(preset) !== startedWith || own.killed) await spawn(preset, registry);
        await oneTurn({ id: row.id, text: row.body }, { preset, tail: false, registry, source: row.source });
        claimed = null;
        lastWork = Date.now();
      }
    } catch (error) {
      if (stopping || own.leaving) return;
      const registry = loadRegistry(options.registryFile);
      const taskRetrySeconds = Number(readSetting(registry, "runner.task_retry_seconds") ?? 30);
      const retryAt = new Date(Date.now() + taskRetrySeconds * 1000).toISOString();
      retries.set(agent.id, Date.parse(retryAt));
      await writes;
      const cause = safeValue(`${(error as Error).name}: ${(error as Error).message}`);
      process.stderr.write(finding("en", { code: "child-exit", target: agent.id, cause }) + "\n");
      await store.sql.begin(async tx => {
        const inside = { ...store, sql: tx as unknown as Store["sql"] };
        if (claimed) await clearProgress(inside, claimed);
        await tx`update inbound set claimed_by = null, claim_deadline = null, retry_at = ${retryAt}::timestamptz
          where agent = ${agent.id} and claimed_by = ${options.runner} and state not in ('answered', 'delivered')`;
        await putRow(inside, "agent_health", agent.id, { status: "retry", cause, retry_at: retryAt });
        // IMP-160, D-183. The person whose message this child was working on
        // hears that it stopped and when it is tried again, once per message,
        // rather than nothing until the answered clock runs out. A harvest
        // failure tells nobody (D-155, D-156).
        if (claimed && claimedHuman && listAgents(registry).some(one => one.id === agent.id)) {
          const said = noticeRoute(registry, agent.id);
          // A memory kill reaches here as the child's exit. `own.killed` alone
          // is also set by a credential refusal, which closes the child itself.
          const why = !(error as { childExited?: boolean }).childExited ? "task failed"
            : own.killed ? "memory limit reached" : "child exited";
          await appendNotice(inside, { person: agent.person, agent: agent.id, ...said,
            body: agentRetry(said.language as Language, { agent: agent.id, cause: why, seconds: taskRetrySeconds }),
            noticeKey: `agent-retry:${claimed}` });
        }
        await appendEntry(inside, { stream: "refusal", subject: agent.id, kind: "refused.turn", actor: "runner",
          detail: { agent: agent.id, error: cause, retry_at: retryAt,
            ...(error instanceof AdapterMissing ? { adapter: safeValue(error.adapter) } : {}) } });
      });
    } finally {
      turn = null;
      await writes;
      if (claimed && own.leaving) await clearProgress(store, claimed);
      own.settle();
      if (waiter) await waiter.close();
      if (own.session) { readings.delete(own.session); await own.session.close().catch(() => {}); }
      own.session = null;
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
      leaving: false,
      left,
      release,
      done: Promise.resolve(),
      serving,
      settle,
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
   * RUN-12. On the tick the runner reads each child's memory and kills the one
   * over the limit its OWN `[[run]]` entry carries (D-81), with ONE ledger line
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
  };

  for (const agent of agentsFor(first, { runner: options.runner })) {
    if (Date.now() >= (retries.get(agent.id) ?? 0)) serve(agent);
  }
  // Ready means SERVING, so a caller that is handed this runner is handed one
  // whose agents are up and fed rather than one that is still starting, and its
  // startup work lands before anything that was waiting on it starts watching.
  await Promise.all([...live.values()].map((it) => it.serving));

  const recovering = new Set<string>();
  const supervise = (async () => {
    while (!stopping) {
      await Promise.race([Bun.sleep(setting(first, "hub.tick_seconds") * 1000), stopped]);
      if (stopping) break;
      let registry: Registry;
      try {
        registry = loadRegistry(options.registryFile);
      } catch {
        // A file half written by an editor is one this tick cannot read. The
        // next tick reads the finished one and nothing is dropped meanwhile.
        continue;
      }
      try {
        const wanted = agentsFor(registry, { runner: options.runner });
        for (const agent of wanted) if (!live.has(agent.id) && !recovering.has(agent.id) && Date.now() >= (retries.get(agent.id) ?? 0)) serve(agent);
        for (const id of [...live.keys()]) {
          if (!wanted.some((agent) => agent.id === id)) await drop(id);
        }
        await watchChildren(registry);
      } catch {
        // A tick that could not finish is a tick. The next one runs.
      }
    }
  })();

  const recovered = new Set<string>();
  const recoverAgent = async (request: { id: string; agent: string }) => {
    if (recovered.has(request.id)) return;
    const registry = loadRegistry(options.registryFile);
    const agent = agentsFor(registry, { runner: options.runner }).find(one => one.id === request.agent);
    if (!agent) throw new Error("unknown-agent");
    recovering.add(agent.id);
    try {
      await drop(agent.id);
      await store.sql`update inbound set claimed_by = null, claim_deadline = null, retry_at = null
        where agent = ${agent.id} and (claimed_by = ${options.runner} or claimed_by is null)
          and state not in ('answered', 'delivered')`;
      retries.delete(agent.id);
      serve(agent);
      recovered.add(request.id);
    } finally { recovering.delete(agent.id); }
  };
  const controls = await watchControls(store, "runner", data => data.target_kind === "agent" &&
    agentsFor(loadRegistry(options.registryFile), { runner: options.runner }).some(a => a.id === data.target_id),
    async data => { await recoverAgent({ id: String(data.id), agent: String(data.target_id) }); },
    { registry: () => loadRegistry(options.registryFile) });
  return {
    runner: options.runner,
    recoverAgent,
    async stop() {
      stopping = true;
      release();
      await controls.close();
      await supervise;
      await Promise.allSettled([...live.values()].map((it) => it.done));
      if (peakBytes > 0) await appendRunnerEntry({ stream: "memory", subject: options.runner,
        kind: "peak.children", actor: "runner", detail: { peak_bytes: peakBytes } });
      await store.close();
    },
  };
}
