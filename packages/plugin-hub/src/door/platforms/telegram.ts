import { readFileSync } from "node:fs";
import type { Platform, PlatformMessage } from "../platform.ts";

/**
 * The transport, narrowed to what this file calls. It is NOT `typeof fetch`,
 * which in this runtime carries a `preconnect` nobody here needs and a supplied
 * one would have to invent.
 */
type Send = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Telegram, as the door sees it. `getUpdates` is a real long poll, so the door
 * waits on it rather than ticking, and the update id is the cursor: sending it
 * back as the offset is what tells Telegram the message was received, which is
 * why the door only writes it after the inbound row has committed.
 *
 * The token is read once, from the file the registry names.
 */
interface Update {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number | string };
    from?: { id: number | string; username?: string };
  };
}

export function telegram(options: {
  tokenFile: string;
  /**
   * The transport, defaulting to the global. A check supplies one to bind the
   * REQUESTS this file builds without reaching Telegram, the same way
   * `realProber` takes one: what stays the cutover's is whether Telegram
   * ACCEPTS them, which no transport can say.
   */
  fetch?: typeof fetch;
}): Platform {
  const token = readFileSync(options.tokenFile, "utf8").trim();
  const send: Send = options.fetch ?? ((input, init) => fetch(input, init));
  const call = async (
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> => {
    const answer = await send(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Longer than the poll it carries, so the wait is Telegram's and not the
      // client's. A call with no poll of its own (a post, an edit, a typing
      // indicator) carries the same ten seconds, because this runtime's `fetch`
      // has no deadline and a door that hung on one would stop serving its
      // person (REVIEW S3).
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
    const said = (await answer.json()) as Record<string, unknown>;
    if (said.ok !== true) {
      throw new Error(`telegram refused ${method}: ${String(said.description)}`);
    }
    return said;
  };

  return {
    name: "telegram",
    // "The status is set for 5 seconds or less", Bot API 10.3.
    typingSeconds: 5,
    async pull({ chat, cursor, timeoutMs }) {
      const said = await call(
        "getUpdates",
        {
          ...(cursor === null ? {} : { offset: Number(cursor) + 1 }),
          timeout: Math.floor(timeoutMs / 1000),
          allowed_updates: ["message"],
        },
        timeoutMs,
      );
      const updates = said.result as Update[];
      const messages: PlatformMessage[] = [];
      for (const update of updates) {
        const message = update.message;
        if (!message || String(message.chat.id) !== chat) continue;
        messages.push({
          platform_message_id: String(message.message_id),
          chat: String(message.chat.id),
          from: String(message.from?.username ?? message.from?.id ?? ""),
          text: String(message.text ?? ""),
          at: new Date(message.date * 1000).toISOString(),
        });
      }
      return {
        messages,
        cursor:
          updates.length === 0
            ? cursor
            : String(updates[updates.length - 1].update_id),
      };
    },
    async post({ chat, text }) {
      const said = await call("sendMessage", { chat_id: chat, text }, 0);
      const made = said.result as { message_id?: unknown } | undefined;
      // `sendMessage` returns the `Message` it sent, and `message_id` is what
      // `editMessageText` takes. The door keeps it so the progress line is one
      // message it overwrites rather than a new line per update.
      return { id: made?.message_id === undefined ? null : String(made.message_id) };
    },
    async edit({ chat, id, text }) {
      await call("editMessageText", { chat_id: chat, message_id: id, text }, 0);
    },
    async typing({ chat }) {
      await call("sendChatAction", { chat_id: chat, action: "typing" }, 0);
    },
  };
}
