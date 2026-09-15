// Test infrastructure: a platform the test owns.
//
// D-35. The door is handed its `platform` as a parameter, so a check can stand
// a fake in the place Telegram or Discord takes in production. The fake is the
// only thing in phase 2 allowed to stand in for a real edge: the store, the
// door, the runner, the settle, the claim, the cursor, the chat log and the
// tail are all the real thing in every check.
//
// It lives in the TEST process, never inside the door, so a redelivery, a
// refused post and a post count are under the test's control even when the door
// is a separate process being killed. `servePlatform` puts it behind a small
// HTTP server and `platformClient` is the `Platform` the door subprocess is
// handed, so the two halves talk over a socket the kill cannot corrupt.
//
// `pull` is a long wait, the way Telegram's own long poll is: it returns when a
// message arrives or when `timeoutMs` passes. That is what lets a check hold a
// door waiting and then deliver into it at a chosen moment.

import type {
  Platform,
  PlatformMessage,
  PlatformPull,
} from "../../src/door/platform.ts";

export interface PostRecord {
  chat: string;
  text: string;
  at: number;
  accepted: boolean;
  /**
   * What the test asked to be observed AT THE MOMENT of this attempt, before
   * the platform answered. A check that reads the world after the call cannot
   * tell "written before the send" from "written after the first send failed
   * and before the retry". This is taken inside `post`, so it can.
   */
  probe: unknown;
}

export interface PullRecord {
  chat: string;
  cursor: string | null;
  at: number;
  returned: number;
}

export interface DeliverInput {
  text: string;
  chat?: string;
  from?: string;
  at?: string;
  platform_message_id?: string;
}

export interface FakePlatform {
  /** The `Platform` a door running in this process is handed. */
  platform: Platform;
  /** Hand the platform a message, as a human sending one does. */
  deliver(message: DeliverInput): PlatformMessage;
  /**
   * Rewind what the fake considers handed out, so the next pull from a cursor
   * at or before this one serves the same message again. A real platform does
   * this on its own when the cursor never moved, which is the case the door
   * kill test stages.
   */
  redeliverFrom(cursor: string | null): void;
  /** Posts the platform ACCEPTED, in order. */
  posts(): PostRecord[];
  /** Every post call, accepted or refused, so a refusal is still an attempt. */
  attempts(): PostRecord[];
  /** Every pull call, so a check can see the door asking. */
  pulls(): PullRecord[];
  /** While on, every post is refused and the caller sees the error. */
  holdPosts(on: boolean): void;
}

export class PlatformRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformRefused";
  }
}

const CHAT = "1000000001";

export interface FakePlatformOptions {
  name: string;
  /**
   * Run inside every post attempt, before the platform accepts or refuses, and
   * recorded on that attempt. The test owns it, so it observes whatever the
   * rule is about: for L2 it is whether the out line is already on disk.
   */
  probe?: (post: { chat: string; text: string }) => unknown;
}

export function createFakePlatform(options: FakePlatformOptions): FakePlatform {
  const queue: PlatformMessage[] = [];
  const postLog: PostRecord[] = [];
  const pullLog: PullRecord[] = [];
  let refusing = false;
  let served = -1;
  let nextId = 1;
  let waiters: (() => void)[] = [];

  const wake = () => {
    const waking = waiters;
    waiters = [];
    for (const w of waking) w();
  };

  const after = (cursor: string | null): number =>
    cursor === null || cursor === "" ? -1 : Number(cursor);

  const platform: Platform = {
    name: options.name,
    async pull(where: {
      chat: string;
      cursor: string | null;
      timeoutMs: number;
    }): Promise<PlatformPull> {
      const deadline = Date.now() + where.timeoutMs;
      for (;;) {
        const from = after(where.cursor);
        const ready: PlatformMessage[] = [];
        for (let i = from + 1; i < queue.length; i += 1) {
          if (queue[i].chat === where.chat) ready.push(queue[i]);
        }
        if (ready.length > 0) {
          const last = queue.lastIndexOf(ready[ready.length - 1]);
          served = Math.max(served, last);
          pullLog.push({
            chat: where.chat,
            cursor: where.cursor,
            at: Date.now(),
            returned: ready.length,
          });
          return { messages: ready, cursor: String(last) };
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          pullLog.push({
            chat: where.chat,
            cursor: where.cursor,
            at: Date.now(),
            returned: 0,
          });
          return { messages: [], cursor: where.cursor };
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(left, 50));
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    async post(where: { chat: string; text: string }): Promise<void> {
      // Taken BEFORE the platform answers, so the attempt carries what was
      // true at the moment of the send rather than afterwards.
      const probe = options.probe ? options.probe(where) : null;
      const record: PostRecord = {
        chat: where.chat,
        text: where.text,
        at: Date.now(),
        accepted: !refusing,
        probe,
      };
      postLog.push(record);
      if (refusing) {
        throw new PlatformRefused(
          `${options.name} refused a post to ${where.chat}`,
        );
      }
    },
  };

  return {
    platform,
    deliver(message) {
      const at = message.at ?? new Date().toISOString();
      const full: PlatformMessage = {
        platform_message_id:
          message.platform_message_id ?? String(90000 + nextId++),
        chat: message.chat ?? CHAT,
        from: message.from ?? "p1",
        text: message.text,
        at,
      };
      queue.push(full);
      wake();
      return full;
    },
    redeliverFrom(cursor) {
      served = after(cursor);
      wake();
    },
    posts: () => postLog.filter((p) => p.accepted).map((p) => ({ ...p })),
    attempts: () => postLog.map((p) => ({ ...p })),
    pulls: () => pullLog.map((p) => ({ ...p })),
    holdPosts(on) {
      refusing = on;
    },
  };
}

/** The default chat id fixtures use. A digit string, never a real one. */
export const FAKE_CHAT = CHAT;

// ---------------------------------------------------------------------------
// The same fake, reachable from another process.
// ---------------------------------------------------------------------------

export interface PlatformServer {
  url: string;
  stop(): Promise<void>;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return (await request.json()) as Record<string, unknown>;
}

export async function servePlatform(
  fake: FakePlatform,
): Promise<PlatformServer> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // A pull is a long wait, so the server must not cut it short.
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/pull") {
        const asked = await body(request);
        const pulled = await fake.platform.pull({
          chat: String(asked.chat),
          cursor: asked.cursor === null ? null : String(asked.cursor),
          timeoutMs: Number(asked.timeoutMs),
        });
        return Response.json(pulled);
      }
      if (path === "/post") {
        const asked = await body(request);
        try {
          await fake.platform.post({
            chat: String(asked.chat),
            text: String(asked.text),
          });
        } catch (error) {
          return Response.json({ error: String((error as Error).message) }, {
            status: 502,
          });
        }
        return Response.json({ ok: true });
      }
      return new Response("not a platform verb", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    async stop() {
      await server.stop(true);
    },
  };
}

/** The `Platform` a door in another process is handed. */
export function platformClient(url: string): Platform {
  return {
    name: "fake-over-http",
    async pull(where) {
      const res = await fetch(`${url}/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(where),
      });
      if (!res.ok) throw new PlatformRefused(`pull failed: ${res.status}`);
      return (await res.json()) as PlatformPull;
    },
    async post(where) {
      const res = await fetch(`${url}/post`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(where),
      });
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new PlatformRefused(said.error ?? `post failed: ${res.status}`);
      }
    },
  };
}
