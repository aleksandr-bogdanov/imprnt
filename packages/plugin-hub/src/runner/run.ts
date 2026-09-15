import { adapterFor } from "../adapters/index.ts";
import type { Adapter, AdapterSession, TurnEnd } from "../adapters/types.ts";
import { readTail } from "../chatlog.ts";
import { thisOs } from "../os/index.ts";
import { appendEntry } from "../records/diary.ts";
import { stamp } from "../records/stamps.ts";
import { agentsFor, listRunEntries } from "../registry/entries.ts";
import { loadRegistry, readSetting, type AgentEntry, type Registry } from "../registry/load.ts";
import { getPreset, presetId, priceFor, type Preset } from "../registry/presets.ts";
import { openStore, storeUrlAs, type Store } from "../store/connect.ts";
import { openWorkWaiter, type Waiter } from "../store/wake.ts";
import { claimNext } from "./claim.ts";
import { settleTurn, type TurnRecord } from "./settle.ts";

export interface RunnerHandle {
  runner: string;
  stop(): Promise<void>;
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
  /** The loop the agent is talking to, for the memory watch to read and kill. */
  session: AdapterSession | null;
  /** The watch killed this child, so the next turn starts a new session first. */
  killed: boolean;
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
  tail: boolean;
  acked: boolean;
  started: boolean;
  finish(end: TurnEnd): void;
}

function setting(registry: Registry, key: string): number {
  return Number(readSetting(registry, key));
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
 */
async function sayWhichServer(
  store: Store,
  registry: Registry,
  runner: string,
): Promise<void> {
  // `system_identifier` is a 64 bit value well past what a double holds, so it
  // crosses as text and is compared as text everywhere after this.
  const [server] = (await store.sql.unsafe(
    `select system_identifier::text as system_identifier, version() as server_version
       from pg_control_system()`,
  )) as { system_identifier: string; server_version: string }[];
  await appendEntry(store, {
    stream: "runner",
    subject: runner,
    kind: "connected",
    actor: "runner",
    detail: {
      system_identifier: String(server?.system_identifier ?? ""),
      server_version: String(server?.server_version ?? ""),
      machine: listRunEntries(registry).find((entry) => entry.id === runner)?.machine ?? "",
    },
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

  const runAgent = async (agent: AgentEntry, own: Live): Promise<void> => {
    let startedWith = "";
    let turn: OpenTurn | null = null;
    let waiter: Waiter | null = null;

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
      about: { preset: Preset; tail: boolean; registry: Registry },
    ): Promise<void> => {
      let finish: (end: TurnEnd) => void = () => {};
      const ended = new Promise<TurnEnd>((resolve) => {
        finish = resolve;
      });
      turn = { id: message.id, tail: about.tail, acked: false, started: false, finish };
      await own.session!.feed(message);
      // The agent is SERVED from here: its session is up and it has been handed
      // the tail of its own log. What the loop answers to that tail can take as
      // long as a loop takes, and a runner that reported itself ready only
      // after it would be a runner a service manager waits on for a model.
      if (about.tail) own.settle();
      const end = await Promise.race([ended, stopped, own.left]);
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
        session_id: end.session_id,
        lacks: [...own.session!.lacks],
        tail: about.tail,
      };

      // The tail's own answer is not a reply to anybody, so it is recorded and
      // dropped. Only a turn fed from an inbound row reaches the outbox.
      if (about.tail) {
        await appendEntry(store, {
          stream: "turn",
          subject: agent.id,
          kind: "turn",
          actor: "runner",
          detail: record as unknown as Record<string, unknown>,
        });
        return;
      }
      await settleTurn(store, {
        inboundId: message.id,
        chunks: [end.text],
        turn: record,
      });
    };

    const spawn = async (preset: Preset, registry: Registry): Promise<void> => {
      const adapter = adapterFor(options.adapters, preset.adapter);
      if (own.session) await own.session.close().catch(() => {});
      own.session = await adapter.start({ preset, sessionId: null });
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
      session.onProgress(() => {
        const open = turn;
        if (!open || open.tail || open.started) return;
        open.started = true;
        write(() => stamp(store, { messageId: open.id, kind: "started", actor: "runner" }));
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
      await spawn(getPreset(first, agent.preset), first);
      // An agent whose log had no tail to feed is served the moment its session
      // is up, and this is where that one settles.
      own.settle();
      while (!stopping && !own.leaving) {
        // Before each turn, because a preset or a rate is a registry edit and
        // the agent picks it up on its next turn without anything restarting.
        const registry = loadRegistry(options.registryFile);
        const row = await claimNext(store, {
          runner: options.runner,
          agent: agent.id,
          leaseMs: setting(registry, "hub.claim_lease_seconds") * 1000,
        });
        if (!row) {
          await Promise.race([
            waiter
              .wait(setting(registry, "hub.tick_seconds") * 1000)
              .catch(() => "timeout" as const),
            stopped,
            own.left,
          ]);
          continue;
        }
        const preset = getPreset(registry, agent.preset);
        // A session carries the preset it was started with, so a changed one is
        // a new child, and so is one whose child the memory watch killed. The
        // runner process itself never restarts for either.
        if (presetId(preset) !== startedWith || own.killed) await spawn(preset, registry);
        await oneTurn({ id: row.id, text: row.body }, { preset, tail: false, registry });
      }
    } catch (error) {
      if (stopping || own.leaving) return;
      // Loud, never a silent wait: a household that hears nothing all day has no
      // way to tell a quiet agent from a broken one.
      await appendEntry(store, {
        stream: "refusal",
        subject: agent.id,
        kind: "refused.turn",
        actor: "runner",
        detail: {
          adapter: (error as { adapter?: string }).adapter ?? null,
          agent: agent.id,
          error: `${(error as Error).name}: ${(error as Error).message}`,
        },
      });
    } finally {
      own.settle();
      if (waiter) await waiter.close();
      const session = own.session;
      own.session = null;
      if (session) {
        if (stopping) {
          await session.close().catch(() => {});
        } else {
          // The agent left the FILE while this runner kept running, which is
          // RUN-09's routine operation and not a shutdown. A loop host shares
          // state across the sessions it is serving, so closing one of them
          // mid-life can disturb the agents that are still being served. What
          // this agent owned exclusively is its child, and that is released
          // here. The session handle itself is closed when the runner stops.
          if (session.pid && session.pid > 0) {
            try {
              process.kill(session.pid, 9);
            } catch {
              // It went away on its own, which is the same outcome.
            }
          }
          retired.push(session);
        }
      }
    }
  };

  const live = new Map<string, Live>();
  /** Sessions of agents that left the file. Closed when the runner stops. */
  const retired: AdapterSession[] = [];

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
      session: null,
      killed: false,
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
   */
  const watchChildren = async (registry: Registry): Promise<void> => {
    const own = listRunEntries(registry).find((entry) => entry.id === options.runner);
    const limitMb = own?.child_memory_limit_mb;
    if (!limitMb || limitMb <= 0) return;
    for (const it of live.values()) {
      const pid = it.session?.pid ?? null;
      // A hosted loop has no local child for this hub to watch, and a child
      // already killed is not killed twice.
      if (!pid || pid <= 0 || it.killed) continue;
      let bytes = 0;
      try {
        bytes = (await os.memory(pid)).current_bytes;
      } catch {
        continue;
      }
      if (bytes <= limitMb * 1024 * 1024) continue;
      it.killed = true;
      try {
        process.kill(pid, 9);
      } catch {
        // It went away between the reading and the signal, which is the same
        // outcome by another route.
      }
      await appendEntry(store, {
        stream: "memory",
        subject: it.agent.id,
        kind: "killed.child",
        actor: "runner",
        detail: {
          agent: it.agent.id,
          pid,
          reading_bytes: bytes,
          limit_mb: limitMb,
          runner: options.runner,
        },
      });
    }
  };

  for (const agent of agentsFor(first, { runner: options.runner })) serve(agent);
  // Ready means SERVING, so a caller that is handed this runner is handed one
  // whose agents are up and fed rather than one that is still starting, and its
  // startup work lands before anything that was waiting on it starts watching.
  await Promise.all([...live.values()].map((it) => it.serving));

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
        for (const agent of wanted) if (!live.has(agent.id)) serve(agent);
        for (const id of [...live.keys()]) {
          if (!wanted.some((agent) => agent.id === id)) await drop(id);
        }
        await watchChildren(registry);
      } catch {
        // A tick that could not finish is a tick. The next one runs.
      }
    }
  })();

  return {
    runner: options.runner,
    async stop() {
      stopping = true;
      release();
      await supervise;
      await Promise.allSettled([...live.values()].map((it) => it.done));
      for (const session of retired) await session.close().catch(() => {});
      await store.close();
    },
  };
}
