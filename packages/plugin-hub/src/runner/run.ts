import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { adapterFor } from "../adapters/index.ts";
import type { Adapter, AdapterSession, TurnEnd } from "../adapters/types.ts";
import { boxCommand, boxContextFor } from "../box/index.ts";
import { readTail } from "../chatlog.ts";
import { thisOs } from "../os/index.ts";
import { appendEntry } from "../records/diary.ts";
import { stamp } from "../records/stamps.ts";
import { catchUpNotice, outageNotice, windowNotice, type Language } from "../door/lines.ts";
import { agentsFor, languageOf, listAgents, listRunEntries } from "../registry/entries.ts";
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
import { openWorkWaiter, type Waiter } from "../store/wake.ts";
import { claimNext } from "./claim.ts";
import { writeProgress } from "./progress.ts";
import {
  clearOutage,
  maxRankFor,
  noticeKey,
  openOutage,
  percentOf,
  readingStands,
  readWindow,
  recordWindow,
  type WindowRow,
} from "./outage.ts";
import { refuseTurn, settleTurn, type TurnRecord } from "./settle.ts";

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

/**
 * The agent's box, ready to hand to a loop (03b item 1, D-92, D-93).
 *
 * The RUNNER decides the boxing, because the box is derived from the registry
 * and the registry is what the runner already reads. The loop is handed a hook
 * and spawns what comes back, so a new adapter inherits the fence without
 * knowing a box exists.
 *
 * THE PROFILE IS WRITTEN HERE, before the hook is handed over. `boxCommand`
 * computes the path and the text and writes nothing, and `sandbox-exec` refuses
 * to start on a profile it cannot open, so a wiring that forgot the write gets
 * a child that never runs.
 *
 * A person with no tree is UNBOXED and is not a refusal: whether a person has a
 * tree is a question about a machine, not about the file (D-93), so the agent
 * runs and `check` reports `agent-unboxed` about it.
 */
function boxFor(
  registry: Registry,
  agentId: string,
): { wrap: (argv: string[]) => string[]; cwd: string | undefined } | null {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  let ctx;
  try {
    ctx = boxContextFor(registry, agentId);
  } catch {
    // An agent the registry no longer carries is one this runner is dropping.
    return null;
  }
  if (ctx.tree === "") return null;
  const ready = boxCommand([], ctx);
  if (ready.profile) {
    mkdirSync(dirname(ready.profile.path), { recursive: true });
    writeFileSync(ready.profile.path, ready.profile.text, "utf8");
  }
  return {
    wrap: (argv: string[]) => boxCommand(argv, ctx).argv,
    // The agent WORKS in its own tree, which is the directory the box is drawn
    // around. A declared tree that is not on this machine yet is left alone
    // rather than made a spawn that cannot start.
    cwd: existsSync(ctx.tree) ? ctx.tree : undefined,
  };
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

  const runAgent = async (agent: AgentEntry, own: Live): Promise<void> => {
    let startedWith = "";
    let turn: OpenTurn | null = null;
    let waiter: Waiter | null = null;
    /** This agent stopped claiming because the household's window is used up. */
    let heldByWindow = false;
    /**
     * This agent has refused a turn or held its rows since its last success, so
     * an outage may be standing. It is what keeps the clear off the hot path: a
     * runner that has never met one issues no delete on a healthy turn.
     */
    let sawOutage = false;
    /** The standing outage's own `since`, so a loser writes the same key. */
    let outageSince = "";

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
      // The count comes first, then the clear, then the lines, and only then
      // does the caller settle. Every runner that lived through the outage
      // writes them, not only the one that won the delete: a loser that wrote
      // nothing would settle its own reply into the chat BETWEEN the winner's
      // delete and the winner's lines, and the person would read the answer
      // above "it works again". The key is the same for all of them, so the
      // second write lands nothing.
      const waiting = sawOutage
        ? await waitingPerPerson(store, registry, credential)
        : null;
      const cleared = await clearOutage(store, { credential });
      // A runner that restarted through the outage remembers nothing, and the
      // row it deletes here is how it finds out there was one at all.
      const since = cleared?.since ?? (sawOutage ? outageSince : "");
      if (!since) return;
      const counts = waiting ?? (await waitingPerPerson(store, registry, credential));
      for (const who of peopleOn(registry, credential)) {
        await appendNotice(store, {
          person: who.person,
          agent: who.agent,
          body: catchUpNotice(
            languageOf(registry, who.person) as Language,
            counts.get(who.person) ?? 0,
          ),
          noticeKey: noticeKey("outage-over", credential, since, who.person),
        });
      }
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
      about: { preset: Preset; tail: boolean; registry: Registry },
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
        await appendEntry(store, {
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
        });
        const standing = await openOutage(store, {
          credential,
          cause: end.refused.cause,
          said: end.refused.said,
          runner: options.runner,
          retryAt,
        });
        sawOutage = true;
        outageSince = standing.since;
        await sayOutage(about.registry, credential, standing);
        return;
      }

      // D-124's last write: the totals, before the settle that takes the row
      // away, so the door's own line ends with them (L6). It goes in HERE and
      // not beside the settle on purpose: the write commits and announces
      // itself, and everything below it is what gives the door the room to read
      // it before the settling transaction removes the row.
      if (opened.started) await writeProgress(store, progressOf(opened));

      // It works again. The catch-up goes in BEFORE the reply, so a person
      // reads "it stopped", then "it works again", then their answers. It is
      // asked on EVERY successful turn and not only when this runner remembers
      // an outage, because a runner restarted through one remembers nothing and
      // would otherwise leave the row standing and the household never told.
      await sayCatchUp(about.registry, credential);
      sawOutage = false;
      outageSince = "";

      await settleTurn(store, {
        inboundId: message.id,
        chunks: [end.text],
        turn: record,
      });
    };

    const spawn = async (preset: Preset, registry: Registry): Promise<void> => {
      const adapter = adapterFor(options.adapters, preset.adapter);
      if (own.session) await own.session.close().catch(() => {});
      const box = boxFor(registry, agent.id);
      own.session = await adapter.start({
        preset,
        sessionId: null,
        ...(box ? { wrap: box.wrap, ...(box.cwd ? { cwd: box.cwd } : {}) } : {}),
      });
      own.boxed = box !== null;
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
      await spawn(getPreset(first, agent.preset), first);
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
        const sleep = async (): Promise<void> => {
          await Promise.race([
            waiter!
              .wait(setting(registry, "hub.tick_seconds") * 1000)
              .catch(() => "timeout" as const),
            stopped,
            own.left,
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
              sawOutage = true;
              const standing = await openOutage(store, {
                credential,
                cause: "window",
                said: `the plan window is ${percentOf(window!)}% used`,
                runner: options.runner,
                retryAt: until,
              });
              outageSince = standing.since;
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
              sawOutage = false;
            }
          }
        }

        const row = await claimNext(store, {
          runner: options.runner,
          agent: agent.id,
          leaseMs: setting(registry, "hub.claim_lease_seconds") * 1000,
          maxRank,
        });
        if (!row) {
          await sleep();
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
   * A BOXED AGENT ON LINUX IS READ THROUGH ITS BOX. The pid the adapter hands
   * up is `bwrap`'s and the loop is under it, so the reading is the largest of
   * the wrapper and every process below it: a wrapper with nothing under it yet
   * is still its own reading, so a loop that has not started is watched rather
   * than skipped. The largest rather than the sum, because the limit is the one
   * the unboxed path reads, a single process's resident size, and the box tool
   * and its reaper are a megabyte between them. macOS is untouched: there
   * `sandbox-exec` execs in place and the pid the runner holds IS the loop's
   * (BUILD-NOTES 5), and an unboxed agent is untouched on both, so what the
   * watch reads for the loops the checks exercise is the same number it was.
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
      if (it.boxed && process.platform === "linux") {
        for (const under of descendantsOf(pid)) {
          try {
            const reading = (await os.memory(under)).current_bytes;
            if (reading > bytes) bytes = reading;
          } catch {
            // It left while the tree was being read, and a process that is
            // gone is using nothing.
          }
        }
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
