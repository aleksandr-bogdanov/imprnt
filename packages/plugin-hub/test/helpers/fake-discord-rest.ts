// Test infrastructure: a Discord the test owns, at the REST level.
//
// `discord({ tokenFile, fetch? })` already takes the transport it talks through
// (the same seam `platform-requests.test.ts` uses with its one-off `transport()`),
// so this is that transport grown into something that REMEMBERS: messages with
// nonces, reactions, channels, and a script of failures a check plants for the next
// matching request.
//
// WHY IT IS AT THE REST LEVEL AND NOT ANOTHER `Platform` FAKE. The effect ledger and
// the confirmation poll are written against Discord's documented routes, and the
// failures they exist for (a post whose answer was lost, a 429, a page of
// reactors) only exist there. `helpers/fake-platform.ts` stays the fake for what the
// door does above the seam.
//
// WHAT IS DISCORD'S DOCUMENTED BEHAVIOUR AND WHAT IS NOT. Read against the message
// and rate-limit pages of the official documentation, 2026-09-30:
//
//   documented   `nonce` is up to 25 characters; with `enforce_nonce` it is "checked
//                for uniqueness in the past few minutes", and an earlier message by
//                the same author with that nonce is returned and no new one is made;
//                content is up to 2000 characters and Discord "may strip certain
//                characters"; a channel read returns messages newest to oldest, one to
//                100 of them, with `before`, `after` and `around` exclusive;
//                reactions come `after` a user id, 1 to 100, 25 by default; a 429 has
//                `retry_after` in seconds (a float), `global`, and `Retry-After`,
//                `X-RateLimit-Global`, `X-RateLimit-Scope` headers.
//   NOT SAID     how long "a few minutes" is (an option, and nothing depends on a
//                number); whether a GET returns the nonce (this fake never returns it
//                from a GET or a listing); the order reactors come in (an option); which
//                100 messages an `after` read returns when more than 100 follow it (an
//                option); and whether a deleted message still holds its nonce (it does
//                here, and a check can turn that off).
//   FROM THE ERROR-CODE PAGE, WHICH WAS NOT FETCHED   10003 Unknown Channel, 10008
//                Unknown Message, 50001 Missing Access. They are the codes the seam
//                reads, and live validation has to confirm them.
//
// Nothing here reaches a network: it is a `fetch` and it never calls one.

const EPOCH = 1420070400000n;

/** The moment a snowflake was made, as Discord's own documentation decodes one. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + EPOCH);
}

/** The smallest snowflake made at `ms`, so "newer than this moment" is a comparison of ids. */
export function snowflakeAt(ms: number): string {
  return String((BigInt(ms) - EPOCH) << 22n);
}

/** The green check, as a reaction route takes it. */
export const CHECK = "✅";

/** A failure a check plants for the next request its route matches. */
export type Fault =
  /** 429, and the request is NOT handled. `retryAfter` is seconds, as Discord's body says it. */
  | { kind: "rate_limit"; retryAfter: number; global?: boolean }
  /**
   * A 5xx. With `afterEffect` the request WAS handled and only the answer is
   * lost to a 5xx, which is the case that duplicates a post a door then repeats.
   */
  | { kind: "server_error"; status?: number; afterEffect?: boolean }
  /**
   * The transport throws, which is what a timeout or a reset looks like to the
   * caller. With `afterEffect` the request was handled first: the message exists
   * and nobody was told. With `late` the request is NOT handled now and the caller is
   * not told: it is still on its way, and lands only when a check calls `land()`. That
   * is the request a timeout gave up on and Discord handled afterwards, and it is the
   * one a newer request can be overwritten by.
   */
  | { kind: "drop"; afterEffect?: boolean; late?: boolean }
  /** A refusal with a status and Discord's own code, handled as Discord would refuse: not handled. */
  | { kind: "refuse"; status: number; code?: number };

export interface RestSeen {
  method: string;
  /** Without the `/api/v10` prefix and without the query. */
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  /** The kind of fault this request met, or null. */
  fault: Fault["kind"] | null;
  /** The fake's clock at the request. */
  at: number;
}

export interface FakeMessage {
  id: string;
  channel: string;
  author: string;
  bot: boolean;
  content: string;
  nonce: string | null;
  edited: number | null;
  deleted: boolean;
  reactions: Map<string, Set<string>>;
}

export interface FakeChannel {
  id: string;
  name: string;
  type: number;
  topic: string | null;
  parent_id: string | null;
  permission_overwrites: unknown[];
  /** Gone: a read answers 404 Unknown Channel. */
  exists: boolean;
  /** The bot cannot see it: a read answers 403 Missing Access, which is NOT "gone". */
  hidden: boolean;
}

export interface FakeDiscordOptions {
  /** The bot's own user id, the author of everything the door posts. */
  botId?: string;
  guild?: string;
  /**
   * How long a nonce is remembered. Discord says "the past few minutes" and no more,
   * so a check that depends on it moves the clock across it and asserts nothing about
   * the number. 0 makes the fake honour NO nonce, which is the check that the door
   * never relies on it.
   */
  nonceWindowMs?: number;
  /** Whether a deleted message still holds its nonce. Not documented; on by default. */
  deletedKeepsNonce?: boolean;
  /** The order a reaction listing comes back in. Not documented; ascending by default. */
  reactorOrder?: "ascending" | "descending";
  /**
   * Which messages an `after` read returns when more than `limit` follow the anchor:
   * the ones nearest it (`oldest`) or the newest of them. Not documented.
   */
  listAfter?: "oldest" | "newest";
  /** What Discord does to content it keeps. The default keeps it as sent. */
  normalize?: (content: string) => string;
  /** The fake's clock at the start, in ms. Fixed, so a run is the same on every machine. */
  start?: number;
}

export interface FakeDiscord {
  /** Hand this to `discord({ tokenFile, guild, fetch })`. */
  fetch: typeof fetch;
  botId: string;
  guild: string;
  /** The fake's clock. It moves only when a check moves it. */
  now(): number;
  advance(ms: number): void;
  /** Plant a failure for the next `times` requests matching `route` (`"METHOD /path"`), after `skip` matching ones. */
  script(route: RegExp | string, fault: Fault, options?: { times?: number; skip?: number }): void;
  requests(): RestSeen[];
  /** Handle the requests a `late` drop is still holding, oldest first, at the fake's clock now. Returns how many landed. */
  land(): number;
  /** The requests a `late` drop is still holding. */
  inTransit(): number;
  /** The requests whose `"METHOD /path"` matches. */
  requestsTo(route: RegExp | string): RestSeen[];
  /** A channel a person made in the app. Returns its id. */
  addChannel(spec: { name: string; parent_id?: string | null; topic?: string | null; type?: number }): string;
  channel(id: string): FakeChannel | undefined;
  /** The guild's channels that still exist, oldest first. */
  channels(): FakeChannel[];
  removeChannel(id: string): void;
  hideChannel(id: string): void;
  /** A message somebody typed. Returns its id. `bot` marks another bot's, which is not ours whatever it says. */
  say(channel: string, text: string, author?: string, bot?: boolean): string;
  /** Everything in the channel that was not deleted, oldest first, the bot's own included. */
  messagesIn(channel: string): FakeMessage[];
  react(channel: string, message: string, emoji: string, user: string, bot?: boolean): void;
  unreact(channel: string, message: string, emoji: string, user: string): void;
  /** A message changed after it was posted, the bot's own included. */
  humanEdit(channel: string, message: string, text: string): void;
  deleteMessage(channel: string, message: string): void;
}

const API = "/api/v10";
const HUMAN = "100000000000000001";

export function createFakeDiscord(options: FakeDiscordOptions = {}): FakeDiscord {
  const botId = options.botId ?? "900000000000000001";
  const guild = options.guild ?? "800000000000000001";
  const nonceWindow = options.nonceWindowMs ?? 120_000;
  const deletedKeepsNonce = options.deletedKeepsNonce ?? true;
  const reactorOrder = options.reactorOrder ?? "ascending";
  const listAfter = options.listAfter ?? "oldest";
  const normalize = options.normalize ?? ((content: string) => content);
  let clock = options.start ?? 1_790_000_000_000;
  let last = 0n;
  const messages = new Map<string, FakeMessage>();
  const channels = new Map<string, FakeChannel>();
  const bots = new Set<string>([botId]);
  const log: RestSeen[] = [];
  const scripts: { route: RegExp | string; fault: Fault; times: number; skip: number }[] = [];
  /** Requests whose answer was lost and which have not landed yet. */
  const transit: (() => void)[] = [];

  /** A snowflake at the fake's clock, strictly greater than the one before it. */
  const mint = (): string => {
    const wanted = (BigInt(clock) - EPOCH) << 22n;
    last = wanted > last ? wanted : last + 1n;
    return String(last);
  };
  const same = (route: RegExp | string, key: string): boolean => (typeof route === "string" ? route === key : route.test(key));
  const take = (key: string): Fault | null => {
    for (const one of scripts) {
      if (one.times <= 0 || !same(one.route, key)) continue;
      if (one.skip > 0) { one.skip -= 1; continue; }
      one.times -= 1;
      return one.fault;
    }
    return null;
  };

  const reply = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const refuse = (status: number, code: number, message: string): Response => reply({ code, message }, status);

  /** A message as Discord shows it. The nonce is in a create's answer and in no read. */
  const messageJson = (one: FakeMessage, withNonce = false) => ({
    id: one.id,
    channel_id: one.channel,
    content: one.content,
    ...(withNonce && one.nonce !== null ? { nonce: one.nonce } : {}),
    timestamp: new Date(snowflakeTime(one.id)).toISOString(),
    edited_timestamp: one.edited === null ? null : new Date(one.edited).toISOString(),
    author: { id: one.author, username: one.author === botId ? "hub" : `user-${one.author}`, ...(one.bot ? { bot: true } : {}) },
    attachments: [],
    reactions: [...one.reactions].filter(([, users]) => users.size > 0)
      .map(([name, users]) => ({ count: users.size, me: users.has(botId), emoji: { id: null, name } })),
  });
  const channelJson = (one: FakeChannel) => ({
    id: one.id, guild_id: guild, name: one.name, type: one.type, topic: one.topic, parent_id: one.parent_id,
    permission_overwrites: one.permission_overwrites,
  });
  const byId = (a: string, b: string): number => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

  /** The channel a route names, or the answer Discord gives for it. */
  const reach = (id: string): FakeChannel | Response => {
    const found = channels.get(id);
    if (!found || !found.exists) return refuse(404, 10003, "Unknown Channel");
    if (found.hidden) return refuse(403, 50001, "Missing Access");
    return found;
  };
  const live = (channel: string, id: string): FakeMessage | null => {
    const found = messages.get(id);
    return found && !found.deleted && found.channel === channel ? found : null;
  };

  const handle = (method: string, path: string, query: Record<string, string>, body: Record<string, unknown> | null): Response => {
    let hit: RegExpExecArray | null;

    if (path === "/users/@me" && method === "GET") {
      return reply({ id: botId, username: "hub", bot: true });
    }

    if ((hit = /^\/guilds\/(\d+)\/channels$/.exec(path))) {
      if (method === "GET") {
        return reply([...channels.values()].filter(one => one.exists).sort((a, b) => byId(a.id, b.id)).map(channelJson));
      }
    }

    if ((hit = /^\/channels\/(\d+)$/.exec(path))) {
      const found = reach(hit[1]);
      if (found instanceof Response) return found;
      if (method === "GET") return reply(channelJson(found));
    }

    if ((hit = /^\/channels\/(\d+)\/messages$/.exec(path))) {
      const found = reach(hit[1]);
      if (found instanceof Response) return found;
      if (method === "GET") {
        const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)));
        const all = [...messages.values()].filter(one => one.channel === found.id && !one.deleted).sort((a, b) => byId(a.id, b.id));
        const page = query.after !== undefined
          ? (() => {
              const later = all.filter(one => BigInt(one.id) > BigInt(query.after));
              return listAfter === "oldest" ? later.slice(0, limit) : later.slice(-limit);
            })()
          : query.before !== undefined ? all.filter(one => BigInt(one.id) < BigInt(query.before)).slice(-limit)
          : all.slice(-limit);
        // Newest first on the wire, as documented.
        return reply(page.reverse().map(one => messageJson(one)));
      }
      if (method === "POST") {
        const content = String(body?.content ?? "");
        if (content === "") return refuse(400, 50006, "Cannot send an empty message");
        if (content.length > 2000) return refuse(400, 50035, "Invalid Form Body");
        const nonce = body?.nonce === undefined ? null : String(body.nonce);
        if (nonce !== null && nonce.length > 25) return refuse(400, 50035, "Invalid Form Body");
        if (nonce !== null && body?.enforce_nonce === true && nonceWindow > 0) {
          const earlier = [...messages.values()].find(one => one.author === botId && one.nonce === nonce
            && (deletedKeepsNonce || !one.deleted) && clock - snowflakeTime(one.id) <= nonceWindow);
          if (earlier) return reply(messageJson(earlier, true));
        }
        const made: FakeMessage = { id: mint(), channel: found.id, author: botId, bot: true, content: normalize(content), nonce,
          edited: null, deleted: false, reactions: new Map() };
        messages.set(made.id, made);
        return reply(messageJson(made, true));
      }
    }

    if ((hit = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
      const found = reach(hit[1]);
      if (found instanceof Response) return found;
      const one = live(found.id, hit[2]);
      if (!one) return refuse(404, 10008, "Unknown Message");
      if (method === "GET") return reply(messageJson(one));
      if (method === "PATCH") {
        if (one.author !== botId) return refuse(403, 50005, "Cannot edit a message authored by another user");
        one.content = normalize(String(body?.content ?? one.content));
        one.edited = clock;
        return reply(messageJson(one));
      }
    }

    if ((hit = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)$/.exec(path)) && method === "GET") {
      const found = reach(hit[1]);
      if (found instanceof Response) return found;
      const one = live(found.id, hit[2]);
      if (!one) return refuse(404, 10008, "Unknown Message");
      const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
      const after = query.after === undefined ? -1n : BigInt(query.after);
      const ordered = [...(one.reactions.get(decodeURIComponent(hit[3])) ?? [])].sort(byId).filter(id => BigInt(id) > after).slice(0, limit);
      const users = reactorOrder === "ascending" ? ordered : ordered.reverse();
      return reply(users.map(id => ({ id, username: `user-${id}`, ...(bots.has(id) ? { bot: true } : {}) })));
    }

    return reply({ message: `fake-discord-rest: no such route ${method} ${path}` }, 404);
  };

  const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL ? new URL(input) : new URL(input.url);
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const fault = take(`${method} ${path}`);
    log.push({ method, path, query: Object.fromEntries(url.searchParams), body, fault: fault?.kind ?? null, at: clock });

    if (fault !== null && fault.kind === "drop" && fault.late === true) {
      transit.push(() => { handle(method, path, Object.fromEntries(url.searchParams), body); });
      throw new TypeError("fetch failed (fake-discord-rest: the request is still on its way and the caller gave up on it)");
    }
    const late = fault !== null && (fault.kind === "server_error" || fault.kind === "drop") && fault.afterEffect === true;
    if (fault !== null && !late) {
      if (fault.kind === "rate_limit") {
        return reply({ message: "You are being rate limited.", retry_after: fault.retryAfter, global: fault.global ?? false }, 429,
          { "retry-after": String(Math.ceil(fault.retryAfter)),
            ...(fault.global ? { "x-ratelimit-global": "true", "x-ratelimit-scope": "global" } : { "x-ratelimit-scope": "user" }) });
      }
      if (fault.kind === "server_error") return reply({ message: "fake upstream error" }, fault.status ?? 500);
      if (fault.kind === "refuse") return refuse(fault.status, fault.code ?? 0, "fake refusal");
      throw new TypeError("fetch failed (fake-discord-rest: the request was dropped before it was handled)");
    }
    const answer = handle(method, path, Object.fromEntries(url.searchParams), body);
    if (fault !== null && fault.kind === "server_error") return reply({ message: "fake upstream error" }, fault.status ?? 500);
    if (fault !== null) throw new TypeError("fetch failed (fake-discord-rest: the request was handled and its answer lost)");
    return answer;
  };

  return {
    fetch: fetchFake as unknown as typeof fetch,
    botId,
    guild,
    now: () => clock,
    advance(ms) { clock += ms; },
    script(route, fault, at = {}) { scripts.push({ route, fault, times: at.times ?? 1, skip: at.skip ?? 0 }); },
    land() {
      const landing = transit.splice(0);
      for (const one of landing) one();
      return landing.length;
    },
    inTransit: () => transit.length,
    requests: () => log.map(one => ({ ...one })),
    requestsTo: route => log.filter(one => same(route, `${one.method} ${one.path}`)).map(one => ({ ...one })),
    addChannel(spec) {
      const made: FakeChannel = {
        id: mint(), name: spec.name, type: spec.type ?? 0, topic: spec.topic ?? null, parent_id: spec.parent_id ?? null,
        permission_overwrites: [], exists: true, hidden: false,
      };
      channels.set(made.id, made);
      return made.id;
    },
    channel: id => channels.get(id),
    channels: () => [...channels.values()].filter(one => one.exists).sort((a, b) => byId(a.id, b.id)),
    removeChannel(id) { const one = channels.get(id); if (one) one.exists = false; },
    hideChannel(id) { const one = channels.get(id); if (one) one.hidden = true; },
    say(channel, text, author = HUMAN, bot = author === botId) {
      const made: FakeMessage = { id: mint(), channel, author, bot, content: text, nonce: null, edited: null, deleted: false, reactions: new Map() };
      if (bot) bots.add(author);
      messages.set(made.id, made);
      return made.id;
    },
    messagesIn: channel => [...messages.values()].filter(one => one.channel === channel && !one.deleted).sort((a, b) => byId(a.id, b.id)),
    react(channel, message, emoji, user, bot = false) {
      const one = live(channel, message);
      if (!one) throw new Error(`fake-discord-rest: no message ${message} in ${channel} to react to`);
      if (bot) bots.add(user);
      one.reactions.set(emoji, (one.reactions.get(emoji) ?? new Set()).add(user));
    },
    unreact(channel, message, emoji, user) { live(channel, message)?.reactions.get(emoji)?.delete(user); },
    humanEdit(channel, message, text) {
      const one = live(channel, message);
      if (!one) throw new Error(`fake-discord-rest: no message ${message} in ${channel} to edit`);
      one.content = text;
      one.edited = clock;
    },
    deleteMessage(channel, message) { const one = live(channel, message); if (one) one.deleted = true; },
  };
}
