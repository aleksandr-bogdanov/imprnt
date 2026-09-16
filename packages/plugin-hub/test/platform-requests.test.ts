// MSG-10. The requests the two real platforms build: typing, the post that
// says which message it made, and the edit of that message.
//
// SPEC §2 and L6: "While a turn is open the door shows typing on Telegram and
// Discord, refreshed every few seconds", and the progress line "is updated as
// it goes". D-125 pins the seam and the two documented lifetimes.
//
// WHY THIS IS CHECKABLE AT ALL, and why it was not before. SPEC §2's Forbidden
// line is "a synthetic test message", which is a message sent to a real person
// through a real platform. A transport the check supplies reaches no platform
// and no person, so it is outside that line. 04-CONTEXT's harness ruling after
// the second Codex pass says so and pins this check: `telegram({ tokenFile,
// fetch? })` and `discord({ tokenFile, fetch? })` take an optional transport
// with the global's signature, the way `realProber({ fetch })` already does.
// What stays the cutover's is whether the real platforms ACCEPT these
// requests, which no fake can say.
//
// NO REQUEST LEAVES THIS CHECK. The global `fetch` is replaced for the whole
// test with one that throws, and restored afterwards, so a platform that
// ignored the transport it was handed cannot reach the network: it fails on
// that throw, loudly, and the check says which platform did it.
//
// Every fact below is from the platforms' own documentation, read 2026-09-16
// and recorded in 04-BRIEF.md: Telegram's `sendChatAction` sets the status
// "for 5 seconds or less" and returns True, `sendMessage` returns the `Message`
// whose `message_id` an edit needs, and `editMessageText` takes that id.
// Discord's `POST /channels/{id}/typing` "expires after 10 seconds" and
// answers 204, `POST /channels/{id}/messages` returns the message object whose
// `id` an edit needs, and `PATCH /channels/{id}/messages/{id}` takes `content`.
//
// Red reason: behaviour absent. `src/door/platforms/telegram.ts` and
// `src/door/platforms/discord.ts` take `{ tokenFile }` and nothing else, they
// carry no `typing`, no `edit` and no `typingSeconds`, and their `post`
// returns void, so the transport this check supplies is never called.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";

const SLOW = 30_000;
const CHAT = "1000000001";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-platform-requests-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A placeholder token under a scratch directory. Never a real one. */
function plantToken(name: string): { file: string; token: string } {
  const token = `placeholder-${crypto.randomUUID()}`;
  const file = join(dir, name);
  writeFileSync(file, `${token}\n`, "utf8");
  return { file, token };
}

/** A transport the check owns, recording what it was asked for. */
function transport(answer: (seen: Seen) => Response): {
  fetch: typeof fetch;
  seen(): Seen[];
} {
  const log: Seen[] = [];
  const own = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const given = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(given)) headers[key.toLowerCase()] = String(value);
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const seen: Seen = {
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers,
      body,
    };
    log.push(seen);
    return answer(seen);
  }) as unknown as typeof fetch;
  return { fetch: own, seen: () => log.map((one) => ({ ...one })) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The global `fetch`, replaced by one that throws for the length of a check
 * body and restored afterwards. This is the fence: a platform that ignored its
 * transport meets this rather than the network.
 */
async function withNoNetwork<T>(what: string, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    throw new Error(
      `${what} used the global fetch for ${String(input)} instead of the transport it was given, and this check lets no request out`,
    );
  }) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test(
  "MSG-10 Telegram's own requests: typing is sendChatAction with the chat and the typing action, post returns the message_id its answer carried, edit uses that id, the token in the path is the one in the file, and the lifetime is the documented five seconds (SPEC §2, L6, D-125)",
  async () => {
    const { telegram } = await seam("src/door/platforms/telegram.ts");
    expect(typeof telegram).toBe("function");
    const { file, token } = plantToken("telegram.token");

    await withNoNetwork("telegram", async () => {
      const wire = transport((seen) =>
        seen.url.includes("sendMessage")
          ? json({ ok: true, result: { message_id: 4242, chat: { id: CHAT } } })
          : json({ ok: true, result: true }),
      );
      const platform = (telegram as Function)({ tokenFile: file, fetch: wire.fetch }) as {
        name: string;
        typingSeconds: number;
        typing(where: { chat: string }): Promise<void>;
        post(where: { chat: string; text: string }): Promise<{ id: string | null }>;
        edit(where: { chat: string; id: string; text: string }): Promise<void>;
      };

      expect(platform.name).toBe("telegram");
      // "The status is set for 5 seconds or less", from Telegram's own
      // documentation. The door refreshes inside it.
      expect(platform.typingSeconds).toBe(5);
      expect(typeof platform.typing).toBe("function");
      expect(typeof platform.edit).toBe("function");

      await platform.typing({ chat: CHAT });
      // THE TRANSPORT WAS USED. If it was not, nothing below can be about the
      // request this platform builds, so the check stops here rather than
      // asserting over an empty log.
      if (wire.seen().length === 0) {
        throw new Error(
          "telegram was handed a transport and never called it, so the request it builds is unbound and the next call would reach the real platform",
        );
      }
      const typed = wire.seen()[0];
      expect(typed.url).toContain(`https://api.telegram.org/bot${token}/sendChatAction`);
      expect(String(typed.body?.chat_id)).toBe(CHAT);
      expect(typed.body?.action).toBe("typing");

      const made = await platform.post({ chat: CHAT, text: "the progress line" });
      const posted = wire.seen()[1];
      expect(posted.url).toContain(`/bot${token}/sendMessage`);
      expect(String(posted.body?.chat_id)).toBe(CHAT);
      expect(posted.body?.text).toBe("the progress line");
      // The id the platform's OWN answer carried, which is what an edit needs.
      expect(made.id).toBe("4242");

      await platform.edit({ chat: CHAT, id: String(made.id), text: "the totals" });
      const edited = wire.seen()[2];
      expect(edited.url).toContain(`/bot${token}/editMessageText`);
      expect(String(edited.body?.chat_id)).toBe(CHAT);
      expect(String(edited.body?.message_id)).toBe("4242");
      expect(edited.body?.text).toBe("the totals");

      // --- the control: a platform that answered an error must not be read as
      //     a post that worked. Telegram says so with `ok: false`.
      const refusing = transport(() => json({ ok: false, description: "chat not found" }));
      const unhappy = (telegram as Function)({
        tokenFile: file,
        fetch: refusing.fetch,
      }) as { post(where: { chat: string; text: string }): Promise<{ id: string | null }> };
      let refused = "";
      try {
        await unhappy.post({ chat: CHAT, text: "a line nobody gets" });
      } catch (error) {
        refused = String((error as Error).message);
      }
      expect(refused).toContain("chat not found");
    });
  },
  SLOW,
);

test(
  "MSG-10 Discord's own requests: typing is a post to the channel's typing endpoint, post returns the message object's id, edit patches that message with content, the token from the file is the Bot authorization, and the lifetime is the documented ten seconds (SPEC §2, L6, D-125)",
  async () => {
    const { discord } = await seam("src/door/platforms/discord.ts");
    expect(typeof discord).toBe("function");
    const { file, token } = plantToken("discord.token");

    await withNoNetwork("discord", async () => {
      const wire = transport((seen) =>
        seen.url.endsWith("/typing")
          ? new Response(null, { status: 204 })
          : json({ id: "9911", content: "the progress line", channel_id: CHAT }),
      );
      const platform = (discord as Function)({ tokenFile: file, fetch: wire.fetch }) as {
        name: string;
        typingSeconds: number;
        typing(where: { chat: string }): Promise<void>;
        post(where: { chat: string; text: string }): Promise<{ id: string | null }>;
        edit(where: { chat: string; id: string; text: string }): Promise<void>;
      };

      expect(platform.name).toBe("discord");
      // "expires after 10 seconds", from Discord's own documentation.
      expect(platform.typingSeconds).toBe(10);
      expect(typeof platform.typing).toBe("function");
      expect(typeof platform.edit).toBe("function");

      await platform.typing({ chat: CHAT });
      if (wire.seen().length === 0) {
        throw new Error(
          "discord was handed a transport and never called it, so the request it builds is unbound and the next call would reach the real platform",
        );
      }
      const typed = wire.seen()[0];
      expect(typed.url.endsWith(`/channels/${CHAT}/typing`)).toBe(true);
      expect(typed.method.toUpperCase()).toBe("POST");
      // The token from the FILE, in the header Discord reads.
      expect(typed.headers.authorization).toBe(`Bot ${token}`);

      const made = await platform.post({ chat: CHAT, text: "the progress line" });
      const posted = wire.seen()[1];
      expect(posted.url.endsWith(`/channels/${CHAT}/messages`)).toBe(true);
      expect(posted.method.toUpperCase()).toBe("POST");
      expect(posted.headers.authorization).toBe(`Bot ${token}`);
      expect(posted.body?.content).toBe("the progress line");
      expect(made.id).toBe("9911");

      await platform.edit({ chat: CHAT, id: String(made.id), text: "the totals" });
      const edited = wire.seen()[2];
      expect(edited.url.endsWith(`/channels/${CHAT}/messages/9911`)).toBe(true);
      expect(edited.method.toUpperCase()).toBe("PATCH");
      expect(edited.headers.authorization).toBe(`Bot ${token}`);
      expect(edited.body?.content).toBe("the totals");

      // --- the control: an error answer is not a post that worked. Discord
      //     says so with a status.
      const refusing = transport(() => json({ message: "Missing Access", code: 50001 }, 403));
      const unhappy = (discord as Function)({
        tokenFile: file,
        fetch: refusing.fetch,
      }) as { post(where: { chat: string; text: string }): Promise<{ id: string | null }> };
      let refused = "";
      try {
        await unhappy.post({ chat: CHAT, text: "a line nobody gets" });
      } catch (error) {
        refused = String((error as Error).message);
      }
      expect(refused).toContain("403");
    });
  },
  SLOW,
);
