import { readFileSync } from "node:fs";
import type { MediaRef, Platform, PlatformMessage } from "../platform.ts";

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
interface FileRef {
  file_id: string; file_name?: string; mime_type?: string; file_size?: number;
  width?: number; height?: number;
}

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    voice?: FileRef; audio?: FileRef; photo?: FileRef[]; document?: FileRef;
    sticker?: FileRef; video?: FileRef; video_note?: FileRef;
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
      // person.
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
    const said = (await answer.json()) as Record<string, unknown>;
    if (said.ok !== true) {
      throw Object.assign(new Error(`telegram refused ${method}: ${String(said.description)}`), { status: Number(said.error_code ?? answer.status) });
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
          ...(cursor === null ? {} : { offset: Number(cursor) }),
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
        const media: MediaRef[] = [];
        const photo = message.photo?.reduce((largest, item) =>
          (item.file_size ?? (item.width ?? 0) * (item.height ?? 0)) >
          (largest.file_size ?? (largest.width ?? 0) * (largest.height ?? 0)) ? item : largest);
        const files: [FileRef | undefined, MediaRef["kind"]][] = [
          [message.voice, "voice"], [message.audio, "voice"], [photo, "photo"],
          [message.document, message.document?.mime_type?.startsWith("image/") ? "photo" : "file"],
          [message.sticker, "sticker"], [message.video, "video"], [message.video_note, "voice"],
        ];
        for (const [file, kind] of files) if (file) media.push({
          kind, remote_id: file.file_id, name: file.file_name ?? kind,
          mime: file.mime_type ?? null, bytes: file.file_size ?? null, caption: message.caption ?? null,
        });
        messages.push({
          sender_id: String(message.from?.id ?? ""), media,
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
            : String(Math.max(...updates.map(update => update.update_id)) + 1),
      };
    },
    async highWater() {
      // The offset is the BOT's, so where one chat stands is where the bot
      // stands. "The negative offset can be specified to retrieve updates
      // starting from -offset update from the end of the updates queue. All
      // previous updates will be forgotten" (Bot API, getUpdates). Forgetting is
      // what the door asks for here: it calls this only for a chat it has never
      // read, once the reader before it has stopped, and a Telegram door has
      // one reader (the registry refuses a second agent on it).
      const said = await call("getUpdates", { offset: -1, limit: 1, timeout: 0, allowed_updates: ["message"] }, 0);
      const updates = said.result as Update[];
      return updates.length === 0
        ? null
        : String(Math.max(...updates.map(update => update.update_id)) + 1);
    },
    async fetchMedia(media) {
      const said = await call("getFile", { file_id: media.remote_id }, 0);
      const path = (said.result as { file_path?: string }).file_path;
      if (!path || path.split("/").some(part => part === "..") || !/^[\w./-]+$/.test(path)) {
        throw new Error("media-path-refused");
      }
      return send(`https://api.telegram.org/file/bot${token}/${path}`, {
        redirect: "error", signal: AbortSignal.timeout(30_000),
      });
    },
    async post({ chat, text }) {
      let said: Record<string, unknown>;
      try { said = await call("sendMessage", { chat_id: chat, text }, 0); }
      catch (error) {
        if (!(error as { status?: number }).status) Object.assign(error as object, { sent: true });
        throw error;
      }
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
