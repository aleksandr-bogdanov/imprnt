import { readFileSync } from "node:fs";
import type { Platform, PlatformMessage } from "../platform.ts";

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

export function telegram(options: { tokenFile: string }): Platform {
  const token = readFileSync(options.tokenFile, "utf8").trim();
  const call = async (
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> => {
    const answer = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Longer than the poll it carries, so the wait is Telegram's and not the
      // client's.
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
      await call("sendMessage", { chat_id: chat, text }, 0);
    },
  };
}
