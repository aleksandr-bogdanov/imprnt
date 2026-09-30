import { readFileSync } from "node:fs";
import { classifyPlatformError } from "../reply.ts";
import type {
  ChatDescription,
  ChatResolution,
  MediaRef,
  Platform,
  PlatformMessage,
  PlatformReadback,
  PlatformRefusalDetail,
  PlatformVerb,
  ReadMessage,
} from "../platform.ts";

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

/** The longest a nonce may be, from the create-message documentation. */
const NONCE_MAX = 25;
/** Discord's snowflake epoch, 2015-01-01T00:00:00Z, in milliseconds. */
const SNOWFLAKE_EPOCH = 1420070400000n;
/** The two JSON error codes that say WHAT is gone on a 404. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/** The smallest snowflake made at `ms`, so "made since then" is a comparison of ids. */
function snowflakeAt(ms: number): string {
  const since = BigInt(Math.max(0, Math.floor(ms))) - SNOWFLAKE_EPOCH;
  return String(since > 0n ? since << 22n : 0n);
}

/**
 * What a refusal says beyond its status: the numeric error code of its body and,
 * for a 429, the documented rate-limit fields. `retry_after` in the body is seconds
 * and may be fractional, the `Retry-After` header (whole seconds) is the fallback, and
 * `global` says whether it is the account-wide limit rather than a route's. The
 * scope header (`user`, `global` or `shared`) is kept as it came; `global` in it is the
 * account-wide limit too, whichever field said so first, and `shared` is a limit on a
 * resource that is not the account's own, which is held per route like any other.
 * Nothing here says how a 429 is counted by the platform: that depends on the scope,
 * and a shared one is documented as not counting against the sender.
 */
function refusalDetail(answer: Response, text: string): PlatformRefusalDetail {
  let body: { code?: unknown; retry_after?: unknown; global?: unknown } = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    // A body that is not JSON carries no code, and the status still stands.
  }
  const detail: PlatformRefusalDetail = { status: answer.status };
  if (typeof body.code === "number") detail.discordCode = body.code;
  if (answer.status === 429) {
    const fromBody = typeof body.retry_after === "number" ? body.retry_after : Number.NaN;
    const header = answer.headers.get("retry-after");
    const fromHeader = header === null || header.trim() === "" ? Number.NaN : Number(header);
    const seconds = Number.isFinite(fromBody) ? fromBody : Number.isFinite(fromHeader) ? fromHeader : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) detail.retryAfterMs = Math.ceil(seconds * 1000);
    const scope = answer.headers.get("x-ratelimit-scope");
    detail.rateLimitGlobal = body.global === true || answer.headers.get("x-ratelimit-global") === "true" || scope === "global";
    if (scope) detail.rateLimitScope = scope;
  }
  return detail;
}

/**
 * The key a rate limit is kept under, for the verbs the door's shared paths use: a
 * request is limited per route, and a route here is the method, the path with its
 * message or emoji left out, and the channel, which is the resource a limit is
 * kept for. Only what a 429 has said is ever held under a key, so a route nobody has
 * been limited on costs nothing.
 */
const ROUTES: Record<PlatformVerb, (chat: string) => string> = {
  post: chat => `POST /channels/${chat}/messages`,
  edit: chat => `PATCH /channels/${chat}/messages/:id`,
  get: chat => `GET /channels/${chat}/messages/:id`,
  list: chat => `GET /channels/${chat}/messages`,
  reactors: chat => `GET /channels/${chat}/messages/:id/reactions`,
};
const typingRoute = (chat: string): string => `POST /channels/${chat}/typing`;
const channelRoute = (chat: string): string => `GET /channels/${chat}`;
const IDENTITY_ROUTE = "GET /users/@me";

/** A rate limit the seam has been told about, until an epoch. */
interface Hold {
  until: number;
  scope?: string;
}

/** A message object off the wire, in the seam's own shape, or null when it is not one. */
function readMessage(raw: unknown, chat: string): ReadMessage | null {
  const one = raw as { id?: unknown; channel_id?: unknown; content?: unknown; nonce?: unknown;
    edited_timestamp?: unknown; author?: { id?: unknown; bot?: unknown } } | null;
  if (!one || typeof one.id !== "string" || typeof one.content !== "string" || typeof one.author?.id !== "string") return null;
  return {
    id: one.id,
    chat: typeof one.channel_id === "string" ? one.channel_id : chat,
    author: { id: one.author.id, bot: one.author.bot === true },
    content: one.content,
    edited: one.edited_timestamp !== null && one.edited_timestamp !== undefined,
    nonce: typeof one.nonce === "string" ? one.nonce : null,
  };
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
  /** The clock rate-limit waits are counted on, in epoch milliseconds. Defaults to the wall clock. */
  now?: () => number;
}): Platform {
  const token = readFileSync(options.tokenFile, "utf8").trim();
  const send: Send = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const sources = new WeakMap<MediaRef, string>();
  const headers = { authorization: `Bot ${token}`, "content-type": "application/json" };

  // THE SHARED REQUEST BOUNDARY. Every request this object makes to the API goes through
  // `request`, so what any of them learns from a 429 holds all of them: the outbox, the
  // pull, the typing indicator and the progress line as much as the effect task. Held
  // per route, and account-wide for the global limit. Memory only: a door that starts
  // again learns it again from the platform, which is what it does today. A request
  // that is already under way is not stopped by a limit learned after it left.
  //
  // A held request is not sent. It fails at once as the 429 it would have been, with
  // what is left of the wait and `blocked` set, which is a definite refusal: nothing
  // happened. It is never a reason to send anything else, and nothing here retries.
  let globalHold: Hold | null = null;
  const routeHolds = new Map<string, Hold>();
  const holdOf = (route: string): (Hold & { global: boolean }) | null => {
    const at = now();
    let best: (Hold & { global: boolean }) | null = null;
    if (globalHold !== null) {
      if (globalHold.until > at) best = { ...globalHold, global: true };
      else globalHold = null;
    }
    const held = routeHolds.get(route);
    if (held !== undefined) {
      if (held.until <= at) routeHolds.delete(route);
      else if (best === null || held.until > best.until) best = { ...held, global: false };
    }
    return best;
  };
  const learn = (route: string, detail: PlatformRefusalDetail): void => {
    if (detail.retryAfterMs === undefined) return;
    const hold: Hold = { until: now() + detail.retryAfterMs, ...(detail.rateLimitScope ? { scope: detail.rateLimitScope } : {}) };
    if (detail.rateLimitGlobal) {
      if (globalHold === null || hold.until > globalHold.until) globalHold = hold;
      return;
    }
    const seen = routeHolds.get(route);
    if (seen === undefined || hold.until > seen.until) routeHolds.set(route, hold);
    // Routes are per channel, so the map is bounded by the chats this door serves; the
    // sweep only drops what has already lapsed.
    if (routeHolds.size > 512) for (const [key, one] of routeHolds) if (one.until <= now()) routeHolds.delete(key);
  };
  /**
   * One request, through the boundary. `sent` marks an error thrown by the transport
   * itself as one the request may have left before, which a caller must treat as an
   * unknown outcome; a request the boundary held never left and is not marked.
   */
  const request = async (route: string, input: string | URL, init: RequestInit, sent = false): Promise<Response> => {
    const hold = holdOf(route);
    if (hold !== null) {
      const left = Math.max(0, hold.until - now());
      const detail: PlatformRefusalDetail = { status: 429, retryAfterMs: left, rateLimitGlobal: hold.global, blocked: true };
      if (hold.scope) detail.rateLimitScope = hold.scope;
      throw Object.assign(
        new Error(`discord request held: a rate limit holds ${hold.global ? "every request" : route} for ${left} ms more, and nothing was sent`),
        detail,
      );
    }
    let answer: Response;
    try {
      answer = await send(input, init);
    } catch (error) {
      throw sent ? Object.assign(error as object, { sent: true }) : error;
    }
    if (answer.status === 429) {
      try { learn(route, refusalDetail(answer, await answer.clone().text())); } catch { /* an answer that cannot be read teaches nothing */ }
    }
    return answer;
  };
  /** The error a refusal is, with what Discord said beyond its status on it. */
  const refusal = async (what: string, answer: Response): Promise<Error & PlatformRefusalDetail> => {
    const text = await answer.text();
    return Object.assign(new Error(`discord refused ${what}: ${answer.status} ${text}`), refusalDetail(answer, text));
  };
  const refuse = async (what: string, answer: Response): Promise<never> => {
    throw await refusal(what, answer);
  };
  let self: { id: string } | null = null;

  /** One channel, or a throw a caller can classify and retry on. */
  const channel = async (chat: string): Promise<{ id: string; name: string; type: unknown } | null> => {
    const answer = await request(channelRoute(chat), `${API}/channels/${encodeURIComponent(chat)}`, {
      headers, signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
    });
    // A channel that is gone is an ANSWER and not a failure, which is what a
    // repair after somebody deleted one turns on.
    if (answer.status === 404) { await answer.body?.cancel(); return null; }
    if (!answer.ok) await refuse("a channel read", answer);
    return (await answer.json()) as { id: string; name: string; type: unknown };
  };

  const readback: PlatformReadback = {
    async self() {
      if (self) return self;
      // Not in the message or rate-limit pages this seam was written against: the
      // current-user route of the user resource. It answers the account's own id.
      const answer = await request(IDENTITY_ROUTE, `${API}/users/@me`, { headers, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
      if (!answer.ok) await refuse("an identity read", answer);
      const me = (await answer.json()) as { id?: unknown };
      if (typeof me?.id !== "string" || me.id === "") throw new Error("invalid identity response");
      self = { id: me.id };
      return self;
    },
    async getMessage({ chat, id }) {
      const answer = await request(ROUTES.get(chat), `${API}/channels/${encodeURIComponent(chat)}/messages/${encodeURIComponent(id)}`, {
        headers, signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      });
      if (!answer.ok) {
        const failed = await refusal("a message read", answer);
        // Gone is what Discord SAYS is gone: a 404 whose code names the message or
        // the channel. A 404 that names neither, a 403 and a 5xx are not that.
        if (failed.status === 404 && failed.discordCode === UNKNOWN_MESSAGE) return { exists: false, cause: "message" };
        if (failed.status === 404 && failed.discordCode === UNKNOWN_CHANNEL) return { exists: false, cause: "channel" };
        throw failed;
      }
      const message = readMessage(await answer.json(), chat);
      if (!message) throw new Error("invalid message response");
      return { exists: true, message };
    },
    async listMessages({ chat, after, since, limit }) {
      const where = new URL(`${API}/channels/${encodeURIComponent(chat)}/messages`);
      where.searchParams.set("limit", String(Math.min(100, Math.max(1, Math.floor(limit ?? 100)))));
      const from = after ?? (since === undefined ? undefined : snowflakeAt(since));
      if (from !== undefined) where.searchParams.set("after", from);
      const answer = await request(ROUTES.list(chat), where, { headers, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
      if (!answer.ok) await refuse("a message listing", answer);
      const raw = await answer.json();
      if (!Array.isArray(raw)) throw new Error("invalid message listing");
      const read: ReadMessage[] = [];
      for (const one of raw) {
        const message = readMessage(one, chat);
        if (!message) throw new Error("invalid message listing");
        read.push(message);
      }
      // Newest first on the wire, and a reader goes forwards. Snowflakes are numeric.
      return read.sort((a, b) => (a.id.length !== b.id.length ? a.id.length - b.id.length : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async reactors({ chat, id, emoji, after, limit }) {
      const where = new URL(`${API}/channels/${encodeURIComponent(chat)}/messages/${encodeURIComponent(id)}/reactions/${encodeURIComponent(emoji)}`);
      where.searchParams.set("limit", String(Math.min(100, Math.max(1, Math.floor(limit ?? 100)))));
      if (after !== undefined) where.searchParams.set("after", after);
      const answer = await request(ROUTES.reactors(chat), where, { headers, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
      if (!answer.ok) await refuse("a reaction read", answer);
      const raw = await answer.json();
      if (!Array.isArray(raw)) throw new Error("invalid reaction listing");
      return raw.map((user: { id?: unknown; bot?: unknown }) => {
        if (typeof user?.id !== "string") throw new Error("invalid reaction listing");
        return { id: user.id, bot: user.bot === true };
      });
    },
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
        const channels = await channelsOf((input, init) => request(`GET /guilds/${options.guild}/channels`, input as string, init ?? {}), token, options.guild);
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
    readback,
    blockedUntil(verb, chat) {
      const hold = holdOf(ROUTES[verb](chat));
      return hold === null ? null : hold.until;
    },
    // "Post a typing indicator ... which expires after 10 seconds", API v10.
    typingSeconds: 10,
    // Discord's own markdown: `||text||` hides text until it is clicked.
    spoilers: true,
    async pull({ chat, cursor, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const where = new URL(`${API}/channels/${chat}/messages`);
        where.searchParams.set("limit", "50");
        where.searchParams.set("after", cursor ?? "0");
        const answer = await request(ROUTES.list(chat), where, {
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
      const answer = await request(ROUTES.list(chat), where, { headers, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
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
    async post({ chat, text, nonce, suppressMentions }) {
      if (nonce !== undefined && (nonce === "" || nonce.length > NONCE_MAX)) {
        throw new TypeError(`a nonce is 1 to ${NONCE_MAX} characters`);
      }
      const answer = await request(ROUTES.post(chat), `${API}/channels/${chat}/messages`, {
        method: "POST",
        headers,
        // `enforce_nonce` asks Discord to return the message this author already
        // made with that nonce "in the past few minutes" instead of making another.
        // How long is not said, so nothing here relies on it beyond what it returns.
        // `allowed_mentions` with an empty `parse` notifies nobody the text names, and
        // is sent only when the caller asks: the ordinary reply is exactly what it was.
        body: JSON.stringify({
          content: text,
          ...(nonce === undefined ? {} : { nonce, enforce_nonce: true }),
          ...(suppressMentions ? { allowed_mentions: { parse: [] } } : {}),
        }),
        signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      }, true);
      if (!answer.ok) await refuse("a post", answer);
      // The message object Discord answers with, whose `id` a PATCH needs.
      const made = (await answer.json()) as { id?: unknown };
      return { id: made?.id === undefined ? null : String(made.id) };
    },
    async edit({ chat, id, text, suppressMentions }) {
      // Only the author may edit, and the bot is the author of its own line.
      // A transport failure is marked as one that may have left, as a post's is: an
      // edit that was sent and whose answer was lost may still land.
      const answer = await request(ROUTES.edit(chat), `${API}/channels/${chat}/messages/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(suppressMentions ? { content: text, allowed_mentions: { parse: [] } } : { content: text }),
        signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      }, true);
      if (!answer.ok) await refuse("an edit", answer);
    },
    async typing({ chat }) {
      // Answers 204 with no body, so nothing is parsed off it.
      const answer = await request(typingRoute(chat), `${API}/channels/${chat}/typing`, {
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
