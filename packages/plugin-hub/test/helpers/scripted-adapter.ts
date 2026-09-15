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
}

export interface ScriptedOptions {
  name?: string;
  /** What this loop does not have. An adapter that lacks "stream" sends one
   *  progress event carrying the whole text just before the end of turn. */
  lacks?: readonly string[];
  usage?: AdapterUsage;
  sessionId?: string;
}

export interface ScriptedAdapter {
  adapter: Adapter;
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
  /** The deterministic answer, so a check knows the reply before it happens. */
  replyFor(text: string): string;
  /** How many sessions were opened, so a respawn is countable. */
  sessions(): number;
}

/** The one place the scripted answer is defined. */
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

  const openOne = (sessionId: string | null): AdapterSession => {
    const live: Live = { receipt: [], progress: [], end: [], sessionId };
    current = live;
    return {
      get sessionId() {
        return live.sessionId;
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
      },
    };
  };

  const adapter: Adapter = {
    name,
    async start(where: {
      preset: Preset;
      sessionId: string | null;
      cwd?: string;
    }): Promise<AdapterSession> {
      startLog.push({
        sessionId: where.sessionId,
        preset: where.preset ?? null,
        at: Date.now(),
      });
      opened += 1;
      return openOne(
        where.sessionId ?? options.sessionId ?? `scripted-session-${opened}`,
      );
    },
  };

  return {
    adapter,
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
    replyFor: scriptedReply,
    sessions: () => opened,
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

export interface AdapterServer {
  url: string;
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
          cancel() {
            // the set is swept below
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
        await opened.feed({ id: asked.id, text: asked.text });
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

/** The `Adapter` a runner in another process is handed. */
export function adapterClient(url: string, name = "scripted-over-http"): Adapter {
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
      const session: AdapterSession = {
        get sessionId() {
          return opened.sessionId;
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
