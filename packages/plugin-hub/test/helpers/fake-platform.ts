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
  PlatformMessage,
  PlatformPull,
} from "../../src/door/platform.ts";

/**
 * D-125. The platform a door needs, as the phase 4 seam contract pins it:
 * typing with the lifetime its own documentation gives it, an edit, and a post
 * that says which message it made.
 *
 * It is written out HERE rather than imported from `src/door/platform.ts`,
 * because that file carries the phase 2 shape and this round creates nothing
 * under `src/`. The same reason `test/helpers/units.ts` keeps its own copy of
 * the two unit prefixes: a fixture that borrowed the code under test would
 * agree with every build, including one that never grew the verbs.
 */
export interface DoorPlatform {
  readonly name: string;
  /** How long ONE typing call shows for, from the platform's own documentation. */
  readonly typingSeconds: number;
  pull(options: {
    chat: string;
    cursor: string | null;
    timeoutMs: number;
  }): Promise<PlatformPull>;
  post(options: { chat: string; text: string }): Promise<{ id: string | null }>;
  edit(options: { chat: string; id: string; text: string }): Promise<void>;
  typing(options: { chat: string }): Promise<void>;
}

export interface PostRecord {
  chat: string;
  text: string;
  at: number;
  accepted: boolean;
  /** The id this platform gave the message, which is what an edit needs. */
  id: string | null;
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

/** One typing call, with the moment it happened, so a check binds the cadence. */
export interface TypingRecord {
  chat: string;
  at: number;
}

/** One edit of a message this platform already posted. */
export interface EditRecord {
  chat: string;
  id: string;
  text: string;
  at: number;
}

export interface DeliverInput {
  text: string;
  chat?: string;
  from?: string;
  at?: string;
  platform_message_id?: string;
}

export interface FakePlatform {
  /** The platform a door running in this process is handed. */
  platform: DoorPlatform;
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
  /** Every typing call, in order, each with its own moment. */
  typings(): TypingRecord[];
  /** Every edit the door made, in order. */
  edits(): EditRecord[];
  /**
   * While on, every post is refused and the caller sees the error.
   *
   * Posts alone: an edit and a typing call each had a switch of their own and
   * no check ever turned either on, so what they bought was two flags that were
   * always false and two branches nothing could reach.
   */
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
  /** How long one typing call shows for. Telegram's 5 by default, Discord's 10. */
  typingSeconds?: number;
  /**
   * Build the platform WITHOUT a `typing` property at all, which is the control
   * for the refusal: a door handed this cannot show typing however it tries,
   * and a typing that threw would be a platform that has the verb.
   */
  noTyping?: boolean;
}

export function createFakePlatform(options: FakePlatformOptions): FakePlatform {
  const queue: PlatformMessage[] = [];
  const postLog: PostRecord[] = [];
  const pullLog: PullRecord[] = [];
  const typingLog: TypingRecord[] = [];
  const editLog: EditRecord[] = [];
  let refusing = false;
  let nextPostId = 1;
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

  const speaks: Omit<DoorPlatform, "typing"> = {
    name: options.name,
    typingSeconds: options.typingSeconds ?? 5,
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
    async post(where: { chat: string; text: string }): Promise<{ id: string | null }> {
      // Taken BEFORE the platform answers, so the attempt carries what was
      // true at the moment of the send rather than afterwards.
      const probe = options.probe ? options.probe(where) : null;
      const id = refusing ? null : String(70000 + nextPostId++);
      const record: PostRecord = {
        chat: where.chat,
        text: where.text,
        at: Date.now(),
        accepted: !refusing,
        id,
        probe,
      };
      postLog.push(record);
      if (refusing) {
        throw new PlatformRefused(
          `${options.name} refused a post to ${where.chat}`,
        );
      }
      // The id an edit needs. Both real platforms return the message they made
      // and the door has to keep it to edit the progress line.
      return { id };
    },
    async edit(where: { chat: string; id: string; text: string }): Promise<void> {
      editLog.push({
        chat: where.chat,
        id: where.id,
        text: where.text,
        at: Date.now(),
      });
    },
  };

  const typing = async (where: { chat: string }): Promise<void> => {
    typingLog.push({ chat: where.chat, at: Date.now() });
  };

  // The cast is the whole of `noTyping`: the object really has no `typing`
  // property, which is what a door that must refuse it has to meet. A typing
  // that threw would be a platform that HAS the verb and is having a bad day.
  const platform = (
    options.noTyping ? speaks : { ...speaks, typing }
  ) as DoorPlatform;

  return {
    platform,
    deliver(message) {
      const at = message.at ?? new Date().toISOString();
      const full: PlatformMessage = {
        platform_message_id:
          message.platform_message_id ?? String(90000 + nextId++),
        chat: message.chat ?? CHAT,
        from: message.from ?? "p1",
        sender_id: "fixture-sender",
        media: [],
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
    typings: () => typingLog.map((t) => ({ ...t })),
    edits: () => editLog.map((e) => ({ ...e })),
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
        let made: { id: string | null };
        try {
          made = await fake.platform.post({
            chat: String(asked.chat),
            text: String(asked.text),
          });
        } catch (error) {
          return Response.json({ error: String((error as Error).message) }, {
            status: 502,
          });
        }
        // The id comes back over the wire, or a door in another process could
        // never edit what it posted.
        return Response.json({ ok: true, id: made.id });
      }
      if (path === "/edit") {
        const asked = await body(request);
        try {
          await fake.platform.edit({
            chat: String(asked.chat),
            id: String(asked.id),
            text: String(asked.text),
          });
        } catch (error) {
          return Response.json({ error: String((error as Error).message) }, {
            status: 502,
          });
        }
        return Response.json({ ok: true });
      }
      if (path === "/typing") {
        const asked = await body(request);
        try {
          await fake.platform.typing({ chat: String(asked.chat) });
        } catch (error) {
          return Response.json({ error: String((error as Error).message) }, {
            status: 502,
          });
        }
        return Response.json({ ok: true });
      }
      if (path === "/about") {
        // What this platform IS, so a door in another process holds the same
        // typing lifetime the in-process one does rather than a number of its
        // own. A check binds the cadence against it.
        return Response.json({
          name: fake.platform.name,
          typingSeconds: fake.platform.typingSeconds,
        });
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

/**
 * The platform a door in another process is handed.
 *
 * It is ASYNCHRONOUS, because `typingSeconds` is the server's own number and
 * asking for it is a round trip. A client that carried a default of its own
 * would let a check bind a cadence against a number the platform never had.
 */
export async function platformClient(url: string): Promise<DoorPlatform> {
  // BOUNDED, and loud when it runs out. A door subprocess that hung here would
  // never print its ready line, and every check that starts one would report a
  // ninety second timeout with nothing saying why.
  let about: { name: string; typingSeconds: number };
  try {
    const answered = await fetch(`${url}/about`, { signal: AbortSignal.timeout(5000) });
    about = (await answered.json()) as { name: string; typingSeconds: number };
  } catch (error) {
    throw new PlatformRefused(
      `the platform at ${url} did not say what it is within 5 s: ${(error as Error).message}`,
    );
  }
  return {
    name: "fake-over-http",
    typingSeconds: Number(about.typingSeconds),
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
      const made = (await res.json().catch(() => ({}))) as { id?: string | null };
      return { id: made.id ?? null };
    },
    async edit(where) {
      const res = await fetch(`${url}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(where),
      });
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        throw new PlatformRefused(said.error ?? `edit failed: ${res.status}`);
      }
    },
    async typing(where) {
      const res = await fetch(`${url}/typing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(where),
      });
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        throw new PlatformRefused(said.error ?? `typing failed: ${res.status}`);
      }
    },
  };
}
