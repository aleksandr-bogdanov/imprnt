import { readFileSync } from "node:fs";
import type { Platform, PlatformMessage } from "../platform.ts";

/**
 * The transport, narrowed to what this file calls. It is NOT `typeof fetch`,
 * which in this runtime carries a `preconnect` nobody here needs and a supplied
 * one would have to invent.
 */
type Send = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Discord, as the door sees it. The cursor is the last message id and `after`
 * is how a read continues from it. Discord has no long poll, so `pull` reads
 * again until a message arrives or the wait it was given runs out: the door
 * cannot tell that apart from Telegram's own wait, which is the point of the
 * interface.
 *
 * A message from a bot is skipped, because the agent's own replies come back on
 * this endpoint and answering them is an argument with itself.
 */
const API = "https://discord.com/api/v10";
const READ_AGAIN_MS = 2000;

/**
 * How long one call may take before the door stops waiting on it (REVIEW S3).
 *
 * This runtime's `fetch` has no deadline of its own, and a door that hung on a
 * black-holed packet would stop serving its person with nothing said. The read
 * carries the wait it was given plus this, the way Telegram's does; every other
 * verb carries this alone.
 */
const ANSWER_WITHIN_MS = 10_000;

interface Message {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; username?: string; bot?: boolean };
}

export function discord(options: {
  tokenFile: string;
  /** The transport, defaulting to the global. The same seam telegram() takes. */
  fetch?: typeof fetch;
}): Platform {
  const token = readFileSync(options.tokenFile, "utf8").trim();
  const send: Send = options.fetch ?? ((input, init) => fetch(input, init));
  const headers = { authorization: `Bot ${token}`, "content-type": "application/json" };
  const refuse = async (what: string, answer: Response): Promise<never> => {
    throw new Error(`discord refused ${what}: ${answer.status} ${await answer.text()}`);
  };

  return {
    name: "discord",
    // "Post a typing indicator ... which expires after 10 seconds", API v10.
    typingSeconds: 10,
    async pull({ chat, cursor, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const where = new URL(`${API}/channels/${chat}/messages`);
        where.searchParams.set("limit", "50");
        if (cursor !== null) where.searchParams.set("after", cursor);
        const answer = await send(where, {
          headers,
          signal: AbortSignal.timeout(timeoutMs + ANSWER_WITHIN_MS),
        });
        if (!answer.ok) await refuse("a channel read", answer);
        // Newest first on the wire, and the door reads a conversation forwards.
        const read = ((await answer.json()) as Message[]).reverse();

        const messages: PlatformMessage[] = read
          .filter((message) => message.author.bot !== true && message.content !== "")
          .map((message) => ({
            platform_message_id: message.id,
            chat,
            from: message.author.username ?? message.author.id,
            text: message.content,
            at: new Date(message.timestamp).toISOString(),
          }));
        if (messages.length > 0) {
          return { messages, cursor: read[read.length - 1].id };
        }
        if (Date.now() >= deadline) return { messages: [], cursor };
        await Bun.sleep(Math.min(READ_AGAIN_MS, deadline - Date.now()));
      }
    },
    async post({ chat, text }) {
      const answer = await send(`${API}/channels/${chat}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      });
      if (!answer.ok) await refuse("a post", answer);
      // The message object Discord answers with, whose `id` a PATCH needs.
      const made = (await answer.json()) as { id?: unknown };
      return { id: made?.id === undefined ? null : String(made.id) };
    },
    async edit({ chat, id, text }) {
      // Only the author may edit, and the bot is the author of its own line.
      const answer = await send(`${API}/channels/${chat}/messages/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      });
      if (!answer.ok) await refuse("an edit", answer);
    },
    async typing({ chat }) {
      // Answers 204 with no body, so nothing is parsed off it.
      const answer = await send(`${API}/channels/${chat}/typing`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      });
      if (!answer.ok) await refuse("a typing indicator", answer);
    },
  };
}
