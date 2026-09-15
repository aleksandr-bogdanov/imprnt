// Test infrastructure: a loop the test drives, through the five-verb seam.
//
// D-34 and D-59. The runner is handed its adapter registry as a parameter, so a
// check can register this under a name generated at run time and drive a turn
// to any point. It implements the `Adapter` interface pinned in the seam
// contract and NOTHING else: there is no tool verb of any kind on it, which is
// what makes it the probe for "a reply that depends on the model calling
// anything" (SPEC section 2 Forbidden, L1).
//
// It answers deterministically, `reply to <the fed text>`, so a check asserts
// the exact reply and an invented or empty answer fails.
//
// Three independent gates. Each one stops the turn at its own step and the test
// resumes it:
//
//   holdReceipt   the second verb. The loop has the message and has not said so.
//   holdProgress  the third verb. The loop has said so and has produced nothing.
//   holdTurnEnd   the fourth verb. The loop has produced text and has not ended.
//
// With a gate off, that step runs on its own and the turn continues to the next
// gate, so the default is a whole turn and a check only names what it holds.
//
// `openSession()` is the session opening, and it deliberately reaches NONE of
// the three handlers. A loop's own session opening (the verified Claude Code
// toolchain emits a `system` event of subtype `init` at the start of every
// turn) is not progress, so an adapter that reported it as progress would be
// the adapter's own bug, and that is the Claude Code adapter's acceptance
// criterion rather than this one's. What this fixture probes is the RUNNER: with
// progress held, a session is open, a message is fed and acknowledged, and no
// `started` stamp may exist.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Adapter,
  AdapterProgress,
  AdapterSession,
  AdapterUsage,
  TurnEnd,
} from "../../src/adapters/types.ts";
import type { Preset } from "../../src/registry/presets.ts";

export interface FedMessage {
  id: string;
  text: string;
  at: number;
}

export interface StartRecord {
  sessionId: string | null;
  preset: Preset | null;
  at: number;
  /** 03b item 1. Whether the runner handed this start a boxing hook. */
  wrapped?: boolean;
}

/** 03b item 1. One real child spawn, as the adapter really made it. */
export interface SpawnRecord {
  /** The argv the child was spawned with, after the runner's hook. */
  argv: string[];
  /** Whether a hook was supplied at all. */
  wrapped: boolean;
  pid: number;
  /** The `-f` profile in that argv, when there is one. */
  profile: string | null;
  /** Whether that profile was on disk AT THE MOMENT of the spawn. */
  profileExisted: boolean | null;
  /** The child itself, so a check can read what it reported. */
  child: HeldChild;
}

/**
 * The `-f <profile>` of a `sandbox-exec` argv, and null for anything else.
 *
 * The fixture's own copy of one shape, the way `test/helpers/units.ts` keeps its
 * own copy of the two prefixes: an oracle that asked the boxing code where it
 * put the profile would agree with a build that never wrote one.
 */
function profileOf(argv: string[]): string | null {
  const at = argv.indexOf("-f");
  if (at < 0 || at + 1 >= argv.length) return null;
  if (!/sandbox-exec$/.test(argv[0] ?? "")) return null;
  return argv[at + 1];
}

export interface ScriptedOptions {
  name?: string;
  /** What this loop does not have. An adapter that lacks "stream" sends one
   *  progress event carrying the whole text just before the end of turn. */
  lacks?: readonly string[];
  usage?: AdapterUsage;
  sessionId?: string;
  /**
   * D-82. With this, `start` spawns a REAL child that holds memory on command
   * and the session's `pid` is that process's id. Without it `pid` is null and
   * every phase 2 check behaves exactly as it does today, which is what keeps
   * the 65 green. A scripted adapter with a FAKE pid would make the memory kill
   * check unable to fail, which is why the child is real.
   */
  child?: boolean;
  /**
   * 03b item 1. A path the real child tries to READ the moment it starts, and
   * reports on its own stdout.
   *
   * The child is what "wear the box" is about, and a child that is boxed cannot
   * reach another person's tree. Nothing outside the process can see that on
   * macOS (`sandbox-exec` execs in place, so the process's own argv is the
   * TARGET's and never names the tool), so the child says what it saw and the
   * check reads the answer. The channel is an inherited stdout pipe rather than
   * a file, because an already-open descriptor needs no rule in any profile.
   */
  probePath?: string;
}

// ---------------------------------------------------------------------------
// The real child: a `bun -e` that holds memory on command and reports nothing.
//
// It is spawned by whoever owns the SESSION, which for a runner under test is
// the runner's own process, so `ps -o ppid=` on it names the runner. That is
// what check 12 reads, and it is why the child cannot live on the scripted
// adapter's server side: the server runs inside the test process and its pid
// would be the wrong parent.
//
// It is told how much to hold through a file it derives from its OWN pid, so
// nothing has to be plumbed through argv and a test in another process can
// reach it with the pid it already has. A file rather than a signal because
// standard signals do not queue: two SIGUSR2 in flight can coalesce into one,
// and a coalesced grow is a flaky check.
// ---------------------------------------------------------------------------

/** Where a child of this pid reads the number of megabytes it should hold. */
export function growFileFor(pid: number): string {
  return join(tmpdir(), `hub-child-${pid}.grow`);
}

const HOLDER = `
const fs = require("fs");
const os = require("os");
const file = os.tmpdir() + "/hub-child-" + process.pid + ".grow";
// 03b item 1. One line on stdout before anything else: what this child could
// read of the path it was pointed at. Outside a box it reads it; inside one it
// does not, and that difference is what "the agent's process wears the box"
// means from where a check stands.
const probe = process.env.HUB_BOX_PROBE || "";
if (probe !== "") {
  let saw = null;
  let refused = null;
  try { saw = fs.readFileSync(probe, "utf8"); } catch (e) { refused = String(e.code || e.message); }
  try {
    process.stdout.write(JSON.stringify({ probe: probe, saw: saw, refused: refused }) + "\\n");
  } catch (e) {}
}
const CHUNK = 16 * 1024 * 1024;
const held = [];
setInterval(() => {
  // A child whose parent went away is a leak, and a suite that leaks one of
  // these leaks the memory it was told to hold.
  if (process.ppid === 1) process.exit(0);
  let want = 0;
  try { want = Number(fs.readFileSync(file, "utf8").trim()) || 0; } catch (e) {}
  while (held.length * 16 < want) {
    const b = Buffer.alloc(CHUNK);
    b.fill(1);
    held.push(b);
  }
}, 100);
setInterval(() => {}, 1000000000);
`;

export interface BoxProbe {
  /** The path the child was told to read. */
  probe: string;
  /** Its contents, when the child could read them. */
  saw: string | null;
  /** The errno the box refused it with, when it could not. */
  refused: string | null;
}

export interface HeldChild {
  pid: number;
  /** The argv this child was really spawned with, boxed or not (03b item 1). */
  argv: string[];
  /** What the child reported about `probePath`, once it has said it. */
  boxProbe(): BoxProbe | null;
  kill(): void;
}

export interface HolderOptions {
  /**
   * 03b item 1. The runner's own boxing hook, applied to the argv this holder
   * would otherwise be spawned with. The fixture calls it and spawns whatever
   * comes back, so a wrap that returns a boxed argv puts the child in the box
   * and a missing one leaves it plain.
   */
  wrap?: (argv: string[]) => string[];
  /** A path the child tries to read at once and reports on stdout. */
  probePath?: string;
}

export function spawnHolder(options: HolderOptions = {}): HeldChild {
  const plain = ["bun", "-e", HOLDER];
  const argv = typeof options.wrap === "function" ? options.wrap(plain) : plain;
  const wants = typeof options.probePath === "string" && options.probePath !== "";
  let said: BoxProbe | null = null;
  const proc = Bun.spawn(argv, {
    // The default is UNCHANGED, deliberately: `test/runner-memory.test.ts` and
    // `test/check-peak.test.ts` get exactly the process they have today, and
    // only a caller that asked for a probe gets a pipe to drain.
    stdout: wants ? "pipe" : "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: wants ? { ...process.env, HUB_BOX_PROBE: options.probePath } : undefined,
  });
  if (wants) {
    void (async () => {
      // Read LINE BY LINE as they arrive. The holder never exits, so waiting
      // for the stream to end would wait for the kill, and the probe would
      // always read null at the moment a check asks for it.
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf("\n");
          while (cut >= 0) {
            const line = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 1);
            cut = buffer.indexOf("\n");
            if (line.trim() === "") continue;
            try {
              const parsed = JSON.parse(line) as BoxProbe;
              if (typeof parsed.probe === "string") said = parsed;
            } catch {
              // A line that is not the probe is the child's own noise.
            }
          }
          if (done) return;
        }
      } catch {
        // The child went away, which is what a kill looks like from here.
      }
    })();
  }
  return {
    pid: proc.pid,
    argv: [...argv],
    boxProbe: () => (said ? { ...said } : null),
    kill() {
      try {
        proc.kill(9);
      } catch {
        // already gone, which is what a memory kill looks like
      }
      try {
        rmSync(growFileFor(proc.pid), { force: true });
      } catch {
        // the grow file may never have been written
      }
    },
  };
}

/** Tell a child to hold this many megabytes. It picks it up on its next poll. */
export function growChild(pid: number, mb: number): void {
  writeFileSync(growFileFor(pid), String(mb), "utf8");
}

/** The resident size of a process in BYTES, from the platform's own tool. */
export function residentBytes(pid: number): number {
  const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const kb = Number((out.stdout?.toString() ?? "").trim());
  // `ps -o rss=` is KILOBYTES on both platforms. Every number in the memory
  // seam is bytes, so the conversion happens at this reader's own edge.
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/**
 * Every holder child still alive anywhere on this box, by pid.
 *
 * The second seat's finding: killing the children a fixture still TRACKS is a
 * cleanup path, not proof that none survived. This asks the platform instead,
 * and it can see a holder whose owner forgot it, including one left by an
 * earlier file. The marker is the grow-file name the holder script carries in
 * its own source, which `ps` prints because the script is its command line.
 */
export function survivingHolders(): number[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (out.stdout?.toString() ?? "")
    .split("\n")
    .filter((line) => line.includes("hub-child-") && line.includes("setInterval"))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

/** Whether a process is gone. A memory kill is asserted with this. */
export function childGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** `AdapterSession` with the handle property D-82 adds to it. */
export interface ChildSession extends AdapterSession {
  readonly pid: number | null;
}

export interface ScriptedAdapter {
  adapter: Adapter;
  /** Every real child this adapter still owns, so a test can reap them. */
  children(): HeldChild[];
  /** 03b item 1. Every real child spawn, with the argv it really used. */
  spawns(): SpawnRecord[];
  /** Every message handed to the loop, with the moment it happened. */
  fed(): FedMessage[];
  /** Every start or resume the runner asked for. */
  starts(): StartRecord[];
  /** The session opening. Not progress, and it reaches no handler. */
  openSession(): void;
  /** When the session opening happened, for an ordering assertion. */
  openedAt(): number | null;
  holdReceipt(on: boolean): void;
  sendReceipt(messageId: string): void;
  holdProgress(on: boolean): void;
  sendProgress(event?: AdapterProgress): void;
  holdTurnEnd(on: boolean): void;
  endTurn(): void;
  /**
   * What the NEXT turn end reports. Two turns of one session can then carry
   * different numbers, which is what makes a turn record copied from another
   * turn fail rather than pass.
   */
  setUsage(usage: AdapterUsage): void;
  /** The numbers this loop reports right now. A check asserts them exactly. */
  readonly usage: AdapterUsage;
  lacks: readonly string[];
}

export function scriptedReply(text: string): string {
  return `reply to ${text}`;
}

const DEFAULT_USAGE: AdapterUsage = {
  input_tokens: 1234,
  cached_input_tokens: 900,
  output_tokens: 210,
  plan_usage: null,
  raw: { input_tokens: 1234, cache_read_input_tokens: 900, output_tokens: 210 },
};

export function createScriptedAdapter(
  options: ScriptedOptions = {},
): ScriptedAdapter {
  const name = options.name ?? "scripted";
  const lacks = options.lacks ?? [];
  // The usage a turn end reports is read at the moment it fires, so a test can
  // give each turn of one session its own numbers.
  let usage: AdapterUsage = options.usage ?? { ...DEFAULT_USAGE };

  const fedLog: FedMessage[] = [];
  const startLog: StartRecord[] = [];
  const children: HeldChild[] = [];
  const spawnLog: SpawnRecord[] = [];
  let openedAt: number | null = null;
  let opened = 0;

  let gateReceipt = false;
  let gateProgress = false;
  let gateEnd = false;

  // Handlers belong to the session that registered them. A respawn starts a
  // fresh session, and a fixture that kept one shared handler list would report
  // every event twice after it, which would look like a runner writing two
  // stamps for one turn.
  interface Live {
    receipt: ((messageId: string) => void)[];
    progress: ((event: AdapterProgress) => void)[];
    end: ((end: TurnEnd) => void)[];
    sessionId: string | null;
  }

  let current: Live | null = null;
  let turn: { id: string; text: string; live: Live } | null = null;

  const fireReceipt = (id: string) => {
    for (const h of (turn?.live ?? current)?.receipt ?? []) h(id);
  };
  const fireProgress = (event: AdapterProgress) => {
    for (const h of (turn?.live ?? current)?.progress ?? []) h(event);
  };
  const fireEnd = (end: TurnEnd) => {
    for (const h of (turn?.live ?? current)?.end ?? []) h(end);
  };

  const step3 = () => {
    if (!turn) return;
    const ending = turn;
    fireEnd({
      text: scriptedReply(ending.text),
      session_id: ending.live.sessionId,
      usage,
    });
    turn = null;
  };

  const step2 = () => {
    if (!turn) return;
    if (gateProgress) return;
    fireProgress({ kind: "text", text: scriptedReply(turn.text) });
    if (gateEnd) return;
    step3();
  };

  const step1 = () => {
    if (!turn) return;
    if (gateReceipt) return;
    fireReceipt(turn.id);
    step2();
  };

  const openOne = (
    sessionId: string | null,
    wrap?: (argv: string[]) => string[],
  ): ChildSession => {
    const live: Live = { receipt: [], progress: [], end: [], sessionId };
    current = live;
    // 03b item 1. The adapter is BOX-AGNOSTIC: it imports nothing from
    // `src/box/`, knows no tool name, and spawns whatever the hook it was
    // handed returns. What it records is the argv it really used, so a check
    // reads the production code's own output at the seam rather than asking
    // the boxing code whether it boxed.
    const held = options.child
      ? spawnHolder({ wrap, probePath: options.probePath })
      : null;
    if (held) {
      children.push(held);
      spawnLog.push({
        argv: [...held.argv],
        wrapped: typeof wrap === "function",
        pid: held.pid,
        // Read at the MOMENT of the spawn: a profile written after the child
        // started is a profile `sandbox-exec` already refused to open.
        profileExisted: profileOf(held.argv) === null ? null : existsSync(profileOf(held.argv)!),
        profile: profileOf(held.argv),
        child: held,
      });
    }
    return {
      get sessionId() {
        return live.sessionId;
      },
      // D-82: a handle property like `close`, never a sixth verb. Null means
      // this loop has no local child for a hub to watch.
      get pid() {
        return held ? held.pid : null;
      },
      get lacks() {
        return lacks;
      },
      async feed(message: { id: string; text: string }): Promise<void> {
        fedLog.push({ id: message.id, text: message.text, at: Date.now() });
        turn = { id: message.id, text: message.text, live };
        // The verbs are asynchronous in every real loop, so nothing lands
        // inside the caller's own call stack here either.
        queueMicrotask(step1);
      },
      onReceipt(handler) {
        live.receipt.push(handler);
      },
      onProgress(handler) {
        live.progress.push(handler);
      },
      onTurnEnd(handler) {
        live.end.push(handler);
      },
      async close(): Promise<void> {
        live.receipt.length = 0;
        live.progress.length = 0;
        live.end.length = 0;
        if (turn && turn.live === live) turn = null;
        if (held) held.kill();
      },
    };
  };

  const adapter: Adapter = {
    name,
    async start(where: {
      preset: Preset;
      sessionId: string | null;
      cwd?: string;
      /** 03b item 1. The runner's boxing hook, applied to this loop's argv. */
      wrap?: (argv: string[]) => string[];
    }): Promise<AdapterSession> {
      startLog.push({
        sessionId: where.sessionId,
        preset: where.preset ?? null,
        at: Date.now(),
        wrapped: typeof where.wrap === "function",
      });
      opened += 1;
      return openOne(
        where.sessionId ?? options.sessionId ?? `scripted-session-${opened}`,
        where.wrap,
      );
    },
  };

  return {
    adapter,
    children: () => [...children],
    spawns: () => spawnLog.map((one) => ({ ...one, argv: [...one.argv] })),
    fed: () => fedLog.map((f) => ({ ...f })),
    starts: () => startLog.map((s) => ({ ...s })),
    openSession() {
      openedAt = Date.now();
    },
    openedAt: () => openedAt,
    holdReceipt(on) {
      gateReceipt = on;
      if (!on) step1();
    },
    sendReceipt(messageId) {
      fireReceipt(messageId);
      if (turn && turn.id === messageId) step2();
    },
    holdProgress(on) {
      gateProgress = on;
      if (!on) step2();
    },
    sendProgress(event) {
      if (!turn) return;
      fireProgress(event ?? { kind: "text", text: scriptedReply(turn.text) });
    },
    holdTurnEnd(on) {
      gateEnd = on;
      if (!on) step3();
    },
    endTurn() {
      step3();
    },
    setUsage(next) {
      usage = next;
    },
    get usage() {
      return usage;
    },
    lacks,
  };
}

// ---------------------------------------------------------------------------
// The same loop, driven from another process.
//
// The runner kill test runs the real `runRunner` inside a `bun` child, so the
// adapter it is handed has to reach back across a socket to the test that holds
// the gates. Events travel as one JSON object per line on a streaming response,
// which is what lets the test release a gate while the child is mid-turn.
// ---------------------------------------------------------------------------

/**
 * What one session over the wire did: the messages it was fed and the pid of
 * the real child the CLIENT spawned for it.
 *
 * This is how a check maps an agent to its child across a process boundary. The
 * runner feeds the tail of the chat log as the first message of every spawned
 * session and that message's id IS the agent id (`src/runner/run.ts` passes
 * `{ id: agent.id, text: tail }`), so a planted chat line makes every session
 * self-identifying with nothing plumbed through argv.
 */
export interface SeenSession {
  session: string;
  pid: number | null;
  fed: { id: string; text: string }[];
}

export interface AdapterServer {
  url: string;
  /** Every session the wire opened, with its child's pid and what it was fed. */
  seen(): SeenSession[];
  /** The child's pid of the LATEST session fed a message with this id. */
  childFor(messageId: string): number | null;
  /** Every child pid, oldest first, of the sessions fed a message with this id.
   *  A respawn opens a second session and feeds the same tail, so this is how a
   *  check tells the child that died from the one that replaced it. */
  childPids(messageId: string): number[];
  stop(): Promise<void>;
}

interface WireEvent {
  kind: "receipt" | "progress" | "end";
  messageId?: string;
  progress?: AdapterProgress;
  end?: TurnEnd;
}

export async function serveAdapter(
  scripted: ScriptedAdapter,
): Promise<AdapterServer> {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const sessions = new Map<string, AdapterSession>();
  const seen = new Map<string, SeenSession>();
  let token = 0;

  const push = (event: WireEvent) => {
    const line = encoder.encode(JSON.stringify(event) + "\n");
    for (const controller of streams) {
      try {
        controller.enqueue(line);
      } catch {
        // a reader that went away takes its stream with it
      }
    }
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.pathname === "/start") {
        const asked = (await request.json()) as {
          preset: Preset;
          sessionId: string | null;
          cwd?: string;
        };
        const opened = await scripted.adapter.start(asked);
        const id = `s${++token}`;
        sessions.set(id, opened);
        seen.set(id, { session: id, pid: null, fed: [] });
        opened.onReceipt((messageId) => push({ kind: "receipt", messageId }));
        opened.onProgress((progress) => push({ kind: "progress", progress }));
        opened.onTurnEnd((end) => push({ kind: "end", end }));
        return Response.json({
          session: id,
          sessionId: opened.sessionId,
          lacks: opened.lacks,
        });
      }
      if (url.pathname === "/feed") {
        const asked = (await request.json()) as {
          session: string;
          id: string;
          text: string;
        };
        const opened = sessions.get(asked.session);
        if (!opened) return new Response("no such session", { status: 404 });
        seen.get(asked.session)?.fed.push({ id: asked.id, text: asked.text });
        await opened.feed({ id: asked.id, text: asked.text });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/child") {
        // The client spawned the real child, because the child has to be a
        // child of the RUNNER's process and not of the test's.
        const asked = (await request.json()) as { session: string; pid: number };
        const row = seen.get(asked.session);
        if (row) row.pid = Number(asked.pid);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/close") {
        const asked = (await request.json()) as { session: string };
        const opened = sessions.get(asked.session);
        if (opened) await opened.close();
        sessions.delete(asked.session);
        return Response.json({ ok: true });
      }
      return new Response("not an adapter verb", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    seen: () => [...seen.values()].map((s) => ({ ...s, fed: [...s.fed] })),
    childFor(messageId) {
      const all = [...seen.values()].filter((row) =>
        row.fed.some((f) => f.id === messageId),
      );
      return all.length ? all[all.length - 1].pid : null;
    },
    childPids(messageId) {
      return [...seen.values()]
        .filter((row) => row.fed.some((f) => f.id === messageId))
        .map((row) => row.pid)
        .filter((pid): pid is number => typeof pid === "number");
    },
    async stop() {
      for (const controller of streams) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      streams.clear();
      await server.stop(true);
    },
  };
}

/**
 * The `Adapter` a runner in another process is handed.
 *
 * With `child: true` it spawns the REAL child here, inside the runner's own
 * process, so `ps -o ppid=` on that child names the runner (check 12) and the
 * runner's memory watch has a pid it can actually read and kill (check 11). A
 * child spawned on the server side would be a child of the TEST process, and
 * both of those checks would be about the wrong parent.
 */
export function adapterClient(
  url: string,
  name = "scripted-over-http",
  options: { child?: boolean } = {},
): Adapter {
  const receiptHandlers: ((messageId: string) => void)[] = [];
  const progressHandlers: ((event: AdapterProgress) => void)[] = [];
  const endHandlers: ((end: TurnEnd) => void)[] = [];
  let pumping: Promise<void> | null = null;
  let stopped = false;

  let pumpError: Error | null = null;
  const pump = async () => {
    const res = await fetch(`${url}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done || stopped) return;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (line.trim() !== "") {
          const event = JSON.parse(line) as WireEvent;
          if (event.kind === "receipt") {
            for (const h of receiptHandlers) h(String(event.messageId));
          } else if (event.kind === "progress") {
            for (const h of progressHandlers) h(event.progress!);
          } else if (event.kind === "end") {
            for (const h of endHandlers) h(event.end!);
          }
        }
        cut = buffer.indexOf("\n");
      }
    }
  };

  return {
    name,
    async start(where) {
      stopped = false;
      if (!pumping) {
        // A stream that ends because the test stopped the server is not a
        // failure of the run. One that ends otherwise is kept so a check can
        // say so rather than hanging.
        pumping = pump().catch((error: Error) => {
          if (!stopped) pumpError = error;
        });
      }
      const res = await fetch(`${url}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preset: where.preset,
          sessionId: where.sessionId,
          cwd: where.cwd,
        }),
      });
      const opened = (await res.json()) as {
        session: string;
        sessionId: string | null;
        lacks: string[];
      };
      const held = options.child ? spawnHolder() : null;
      if (held) {
        await fetch(`${url}/child`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: opened.session, pid: held.pid }),
        }).catch(() => {});
      }
      const session: ChildSession = {
        get sessionId() {
          return opened.sessionId;
        },
        get pid() {
          return held ? held.pid : null;
        },
        get lacks() {
          return opened.lacks;
        },
        async feed(message) {
          await fetch(`${url}/feed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              session: opened.session,
              id: message.id,
              text: message.text,
            }),
          });
        },
        onReceipt(handler) {
          receiptHandlers.push(handler);
        },
        onProgress(handler) {
          progressHandlers.push(handler);
        },
        onTurnEnd(handler) {
          endHandlers.push(handler);
        },
        async close() {
          stopped = true;
          pumping = null;
          if (held) held.kill();
          // A closed session's handlers are gone, so a later session on the
          // same client cannot see one turn reported twice.
          receiptHandlers.length = 0;
          progressHandlers.length = 0;
          endHandlers.length = 0;
          if (pumpError) throw pumpError;
          await fetch(`${url}/close`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: opened.session }),
          }).catch(() => {});
        },
      };
      return session;
    },
  };
}
