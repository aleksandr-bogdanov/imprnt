import { readFileSync } from "node:fs";
import type { Platform, PlatformMessage } from "../platform.ts";

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

interface Message {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; username?: string; bot?: boolean };
}

export function discord(options: { tokenFile: string }): Platform {
  const token = readFileSync(options.tokenFile, "utf8").trim();
  const headers = { authorization: `Bot ${token}`, "content-type": "application/json" };
  const refuse = async (what: string, answer: Response): Promise<never> => {
    throw new Error(`discord refused ${what}: ${answer.status} ${await answer.text()}`);
  };

  return {
    name: "discord",
    async pull({ chat, cursor, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const where = new URL(`${API}/channels/${chat}/messages`);
        where.searchParams.set("limit", "50");
        if (cursor !== null) where.searchParams.set("after", cursor);
        const answer = await fetch(where, { headers });
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
      const answer = await fetch(`${API}/channels/${chat}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: text }),
      });
      if (!answer.ok) await refuse("a post", answer);
    },
  };
}
