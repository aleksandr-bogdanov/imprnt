import { readFileSync } from "node:fs";
import { classifyPlatformError } from "../reply.ts";
import type { ChatDescription, ChatResolution, MediaRef, Platform, PlatformMessage } from "../platform.ts";

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
 * How long one call may take before the door stops waiting on it.
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
  attachments?: { id: string; filename: string; content_type?: string; size?: number; url: string }[];
  sticker_items?: { id: string; name: string; format_type: number }[];
  timestamp: string;
  author: { id: string; username?: string; bot?: boolean };
}

/**
 * What Discord calls a channel of this type, in one word, for the description
 * the seam answers. Anything else is a channel and says so.
 */
function channelKind(type: unknown): string {
  return { 0: "text", 1: "dm", 2: "voice", 3: "group", 4: "category", 5: "announcement",
    11: "thread", 12: "thread", 15: "forum" }[Number(type)] ?? "channel";
}

/**
 * The guild's channels, through the authenticated API, with the transport the
 * caller supplies. It is ONE function because the offline registry conversion
 * and the seam ask the same question, and two spellings of the same request
 * would validate the answer two ways.
 */
async function channelsOf(send: Send, token: string, guild: string): Promise<{ id: string; name: string }[]> {
  const answer = await send(`${API}/guilds/${encodeURIComponent(guild)}/channels`, {
    method: "GET", headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
  });
  if (!answer.ok) throw Object.assign(new Error(`channel lookup refused: ${answer.status}`), { status: answer.status });
  const channels = await answer.json();
  if (!Array.isArray(channels) || !channels.every(c => typeof c.id === "string" && typeof c.name === "string")) throw new Error("invalid channel response");
  return channels as { id: string; name: string }[];
}

export function discord(options: {
  tokenFile: string;
  /**
   * The server this door's channels live in, which a name can be resolved
   * against. Optional: a door without one still takes a channel id, and that is
   * the floor that needs no discovery.
   */
  guild?: string;
  /** The transport, defaulting to the global. The same seam telegram() takes. */
  fetch?: typeof fetch;
}): Platform {
  const token = readFileSync(options.tokenFile, "utf8").trim();
  const send: Send = options.fetch ?? ((input, init) => fetch(input, init));
  const sources = new WeakMap<MediaRef, string>();
  const headers = { authorization: `Bot ${token}`, "content-type": "application/json" };
  const refuse = async (what: string, answer: Response): Promise<never> => {
    throw Object.assign(new Error(`discord refused ${what}: ${answer.status} ${await answer.text()}`), { status: answer.status });
  };

  /** One channel, or a throw a caller can classify and retry on. */
  const channel = async (chat: string): Promise<{ id: string; name: string; type: unknown } | null> => {
    const answer = await send(`${API}/channels/${encodeURIComponent(chat)}`, {
      headers, signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
    });
    // A channel that is gone is an ANSWER and not a failure, which is what a
    // repair after somebody deleted one turns on.
    if (answer.status === 404) { await answer.body?.cancel(); return null; }
    if (!answer.ok) await refuse("a channel read", answer);
    return (await answer.json()) as { id: string; name: string; type: unknown };
  };

  return {
    name: "discord",
    admin: {
      async resolveChat(ref: string): Promise<ChatResolution> {
        if (/^\d+$/.test(ref)) {
          const found = await channel(ref);
          return found === null
            ? { kind: "absent", cause: "chat missing", detail: `this bot cannot see a channel with the id ${ref}` }
            : { kind: "chat", chat: String(found.id), name: String(found.name) };
        }
        // A door whose entry names no server has nothing to resolve a name
        // against, and asking for one would be asking for a permission this
        // household never granted.
        if (!options.guild) {
          return { kind: "unsupported", cause: "unsupported on this platform",
            detail: "this door's entry names no server, so a channel name cannot be looked up. Its id still works" };
        }
        // ONE listing, on the command a person typed, and never on a tick.
        const channels = await channelsOf(send, token, options.guild);
        const found = channels.filter(one => one.name === ref);
        if (found.length === 0) return { kind: "absent", cause: "chat missing", detail: `no channel of this server is called ${ref}` };
        if (found.length > 1) return { kind: "ambiguous", cause: "chat name ambiguous", detail: `${found.length} channels of this server are called ${ref}` };
        return { kind: "chat", chat: found[0].id, name: found[0].name };
      },
      async describeChat(chat: string): Promise<ChatDescription> {
        try {
          const found = await channel(chat);
          return found === null ? { exists: false, name: null, kind: null }
            : { exists: true, name: String(found.name), kind: channelKind(found.type) };
        } catch (error) {
          const failure = classifyPlatformError(error);
          return { exists: false, name: null, kind: null, failure: { code: failure.code, cause: failure.cause } };
        }
      },
    },
    // "Post a typing indicator ... which expires after 10 seconds", API v10.
    typingSeconds: 10,
    async pull({ chat, cursor, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const where = new URL(`${API}/channels/${chat}/messages`);
        where.searchParams.set("limit", "50");
        where.searchParams.set("after", cursor ?? "0");
        const answer = await send(where, {
          headers,
          signal: AbortSignal.timeout(timeoutMs + ANSWER_WITHIN_MS),
        });
        if (!answer.ok) await refuse("a channel read", answer);
        // Newest first on the wire, and the door reads a conversation forwards.
        const read = ((await answer.json()) as Message[]).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        const messages: PlatformMessage[] = [];
        for (const message of read) {
          if (message.author.bot) continue;
          const media: MediaRef[] = [];
          for (const item of message.attachments ?? []) {
            const mime = item.content_type ?? null;
            const ref: MediaRef = {
              kind: mime?.startsWith("image/") ? "photo" : mime?.startsWith("audio/") ? "voice" : mime?.startsWith("video/") ? "video" : "file",
              remote_id: item.id, name: item.filename, mime, bytes: item.size ?? null, caption: null,
            };
            sources.set(ref, item.url);
            media.push(ref);
          }
          for (const item of message.sticker_items ?? []) {
            const ext = item.format_type === 3 ? "json" : item.format_type === 4 ? "gif" : "png";
            const ref: MediaRef = { kind: "sticker", remote_id: item.id, name: item.name,
              mime: ext === "json" ? "application/json" : `image/${ext}`, bytes: null, caption: null };
            sources.set(ref, `https://cdn.discordapp.com/stickers/${item.id}.${ext}`);
            media.push(ref);
          }
          if (!message.content && !media.length) continue;
          messages.push({ platform_message_id: message.id, chat, sender_id: message.author.id,
            from: message.author.username ?? message.author.id, text: message.content,
            at: new Date(message.timestamp).toISOString(), media });
        }
        if (read.length > 0) return { messages, cursor: read[read.length - 1].id };
        if (Date.now() >= deadline) return { messages: [], cursor };
        await Bun.sleep(Math.min(READ_AGAIN_MS, deadline - Date.now()));
      }
    },
    async highWater({ chat }) {
      // With no `after`, `before` or `around`, a channel read answers the
      // newest messages first, so one message is where the channel stands. Its
      // id is a cursor like any other, whoever wrote it, because `after` skips
      // a bot's message exactly as it skips a person's.
      const where = new URL(`${API}/channels/${chat}/messages`);
      where.searchParams.set("limit", "1");
      const answer = await send(where, { headers, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
      if (!answer.ok) await refuse("a channel read", answer);
      const newest = (await answer.json()) as Message[];
      return newest.length > 0 ? newest[0].id : null;
    },
    async fetchMedia(media) {
      let target = sources.get(media);
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (!target) throw new Error("media-source-missing");
        const url = new URL(target);
        if (url.protocol !== "https:" || url.port || url.username || url.password ||
            !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
          throw new Error("media-destination-refused");
        }
        const response = await send(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("media-redirect-missing");
        target = new URL(location, url).href;
      }
      throw new Error("media-redirect-limit");
    },
    async post({ chat, text }) {
      const answer = await send(`${API}/channels/${chat}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      }).catch(error => { throw Object.assign(error, { sent: true }); });
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

/** Offline registry conversion resolves names through the same authenticated API. */
export async function discordChannels(options: { guild: string; token_file: string }) {
  const token = readFileSync(options.token_file, "utf8").trim();
  return await channelsOf((input, init) => fetch(input, init), token, options.guild);
}
