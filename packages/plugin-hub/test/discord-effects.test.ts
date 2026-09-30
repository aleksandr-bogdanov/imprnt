// What the real Discord seam sends and says for the effect ledger and the
// confirmation poll: a nonce on a create, the readback verbs, reactor pages, and the
// rate-limit fields of a refusal.
//
// The requests are checked against the documented create-message, get-channel-message,
// get-channel-messages, get-reactions and rate-limit pages (fetched 2026-09-30):
// `nonce` is up to 25 characters and `enforce_nonce` asks for the earlier message back;
// `after` and `limit` (1 to 100) select a listing; reactions take `after` (a user id)
// and `limit` (1 to 100); a 429 carries `retry_after` in seconds, `global`, and the
// `Retry-After`, `X-RateLimit-Global` and `X-RateLimit-Scope` headers.
//
// NO REQUEST LEAVES THIS CHECK. Every transport is the check's own and the global
// `fetch` throws for the length of each body.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discord } from "../src/door/platforms/discord.ts";
import { telegram } from "../src/door/platforms/telegram.ts";
import { classifyPlatformError } from "../src/door/reply.ts";
import { CHECK, createFakeDiscord, snowflakeAt } from "./helpers/fake-discord-rest.ts";

const CHAT = "1000000001";
let dir: string;
let tokenFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-discord-effects-"));
  tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "placeholder-token\n", "utf8");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function withNoNetwork<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    throw new Error(`the global fetch was used for ${String(input)}, and this check lets no request out`);
  }) as unknown as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = real; }
}

interface Seen { url: URL; method: string; body: Record<string, unknown> | null }

/** A transport that records what it was asked and answers as the check says. */
function wire(answer: (seen: Seen) => Response | Promise<Response>) {
  const log: Seen[] = [];
  const own = (async (input: unknown, init?: RequestInit) => {
    const seen: Seen = { url: new URL(String(input)), method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    log.push(seen);
    return await answer(seen);
  }) as unknown as typeof fetch;
  return { fetch: own, seen: () => log };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const message = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, channel_id: CHAT, content: `m${id}`, author: { id: "900000000000000001", bot: true }, edited_timestamp: null, ...extra });

test("a create carries the nonce and enforce_nonce only when it is given one, and a nonce too long to be one is refused before anything is sent", () =>
  withNoNetwork(async () => {
    const transport = wire(() => json(message("11")));
    const platform = discord({ tokenFile, fetch: transport.fetch });
    await platform.post({ chat: CHAT, text: "plain" });
    await platform.post({ chat: CHAT, text: "with", nonce: "h0123456789abcdef01234567" });
    expect(transport.seen().map(one => one.body)).toEqual([
      { content: "plain" },
      { content: "with", nonce: "h0123456789abcdef01234567", enforce_nonce: true },
    ]);
    await expect(platform.post({ chat: CHAT, text: "x", nonce: "n".repeat(26) })).rejects.toThrow("25");
    await expect(platform.post({ chat: CHAT, text: "x", nonce: "" })).rejects.toThrow("25");
    expect(transport.seen()).toHaveLength(2);
  }));

test("a refusal keeps the error it always was and carries what Discord said beyond its status", () =>
  withNoNetwork(async () => {
    const status = (code: number, body: unknown, headers: Record<string, string> = {}) =>
      discord({ tokenFile, fetch: wire(() => json(body, code, headers)).fetch }).post({ chat: CHAT, text: "x" }).catch(error => error);

    const denied = await status(403, { message: "Missing Access", code: 50001 });
    expect(denied.message).toContain("403");
    expect(denied.status).toBe(403);
    expect(denied.discordCode).toBe(50001);
    expect(denied.retryAfterMs).toBeUndefined();
    // The failure the ordinary outbox reads off it is what it was before.
    expect(classifyPlatformError(denied)).toMatchObject({ kind: "permanent", code: "http-403", cause: "access denied" });

    // seconds, a float, in the body; the header is whole seconds and only the fallback
    const limited = await status(429, { message: "You are being rate limited.", retry_after: 1.25, global: false }, { "retry-after": "2", "x-ratelimit-scope": "user" });
    expect(limited).toMatchObject({ status: 429, retryAfterMs: 1250, rateLimitGlobal: false, rateLimitScope: "user" });
    const global = await status(429, { message: "You are being rate limited.", retry_after: 64.57, global: true }, { "x-ratelimit-global": "true", "x-ratelimit-scope": "global" });
    expect(global).toMatchObject({ retryAfterMs: 64570, rateLimitGlobal: true, rateLimitScope: "global" });
    const headerOnly = await status(429, "not json at all", { "retry-after": "3", "x-ratelimit-global": "true" });
    expect(headerOnly).toMatchObject({ status: 429, retryAfterMs: 3000, rateLimitGlobal: true });
    const neither = await status(429, {});
    expect(neither.retryAfterMs).toBeUndefined();

    // A server error is a status and nothing more: it does not say whether it handled the request.
    const broken = await status(502, { message: "bad gateway" });
    expect(broken).toMatchObject({ status: 502 });
    expect(broken.sent).toBeUndefined();
    // A transport that fails after the request left says so.
    const lost = await discord({ tokenFile, fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch })
      .post({ chat: CHAT, text: "x" }).catch(error => error);
    expect(lost.sent).toBe(true);
    expect(classifyPlatformError(lost).kind).toBe("uncertain");
  }));

test("the identity read asks who the token is once and remembers it", () =>
  withNoNetwork(async () => {
    const transport = wire(() => json({ id: "900000000000000001", username: "hub", bot: true }));
    const platform = discord({ tokenFile, fetch: transport.fetch });
    expect(await platform.readback!.self()).toEqual({ id: "900000000000000001" });
    expect(await platform.readback!.self()).toEqual({ id: "900000000000000001" });
    expect(transport.seen().map(one => `${one.method} ${one.url.pathname}`)).toEqual(["GET /api/v10/users/@me"]);
    await expect(discord({ tokenFile, fetch: wire(() => json({ username: "x" })).fetch }).readback!.self()).rejects.toThrow("invalid identity");
  }));

test("a message read answers gone only for a 404 whose code names the message or the channel, and everything else is a failure", () =>
  withNoNetwork(async () => {
    const read = (answer: () => Response) => discord({ tokenFile, fetch: wire(answer).fetch }).readback!.getMessage({ chat: CHAT, id: "11" });

    const found = await read(() => json(message("11", { edited_timestamp: "2026-09-30T10:00:00.000000+00:00", nonce: "n-1" })));
    expect(found).toEqual({ exists: true, message: { id: "11", chat: CHAT, author: { id: "900000000000000001", bot: true },
      content: "m11", edited: true, nonce: "n-1" } });
    const plain = await read(() => json(message("11")));
    expect(plain).toMatchObject({ exists: true, message: { edited: false, nonce: null } });

    expect(await read(() => json({ code: 10008, message: "Unknown Message" }, 404))).toEqual({ exists: false, cause: "message" });
    expect(await read(() => json({ code: 10003, message: "Unknown Channel" }, 404))).toEqual({ exists: false, cause: "channel" });
    // Not an answer: a 404 that names nothing, an access refusal, a server error, a limit and a body that is not a message.
    await expect(read(() => json({ message: "404: Not Found" }, 404))).rejects.toMatchObject({ status: 404 });
    await expect(read(() => json({ code: 50001, message: "Missing Access" }, 403))).rejects.toMatchObject({ status: 403 });
    await expect(read(() => json({ message: "oops" }, 503))).rejects.toMatchObject({ status: 503 });
    await expect(read(() => json({ retry_after: 2, global: false }, 429))).rejects.toMatchObject({ status: 429, retryAfterMs: 2000 });
    await expect(read(() => json({ id: 5 }))).rejects.toThrow("invalid message response");
  }));

test("a listing asks for a page after an id, or after a moment, oldest first, and a body that is not a listing is a failure", () =>
  withNoNetwork(async () => {
    const transport = wire(() => json([message("30"), message("10"), message("20")]));
    const platform = discord({ tokenFile, fetch: transport.fetch });
    const at = 1_790_000_000_000;
    const page = await platform.readback!.listMessages({ chat: CHAT, since: at, limit: 500 });
    expect(page.map(one => one.id)).toEqual(["10", "20", "30"]);
    await platform.readback!.listMessages({ chat: CHAT, after: "20", since: at, limit: 0 });
    await platform.readback!.listMessages({ chat: CHAT });
    const asked = transport.seen().map(one => Object.fromEntries(one.url.searchParams));
    expect(asked).toEqual([
      { limit: "100", after: snowflakeAt(at) },
      { limit: "1", after: "20" },
      { limit: "100" },
    ]);
    // Ids outgrow a number, and a page is ordered by value.
    const wide = wire(() => json([message("1000000000000000001"), message("999999999999999999")]));
    expect((await discord({ tokenFile, fetch: wide.fetch }).readback!.listMessages({ chat: CHAT })).map(one => one.id))
      .toEqual(["999999999999999999", "1000000000000000001"]);
    await expect(discord({ tokenFile, fetch: wire(() => json({ message: "no" })).fetch }).readback!.listMessages({ chat: CHAT })).rejects.toThrow("invalid message listing");
    await expect(discord({ tokenFile, fetch: wire(() => json([{ id: "1" }])).fetch }).readback!.listMessages({ chat: CHAT })).rejects.toThrow("invalid message listing");
  }));

test("the reactors of an emoji are read a page at a time by user id, with the emoji encoded", () =>
  withNoNetwork(async () => {
    const transport = wire(() => json([{ id: "5", username: "a" }, { id: "6", username: "b", bot: true }]));
    const platform = discord({ tokenFile, fetch: transport.fetch });
    const users = await platform.readback!.reactors({ chat: CHAT, id: "11", emoji: CHECK, after: "4", limit: 100 });
    expect(users).toEqual([{ id: "5", bot: false }, { id: "6", bot: true }]);
    await platform.readback!.reactors({ chat: CHAT, id: "11", emoji: CHECK });
    const [first, second] = transport.seen();
    expect(first.url.pathname).toBe(`/api/v10/channels/${CHAT}/messages/11/reactions/${encodeURIComponent(CHECK)}`);
    expect(Object.fromEntries(first.url.searchParams)).toEqual({ limit: "100", after: "4" });
    expect(Object.fromEntries(second.url.searchParams)).toEqual({ limit: "100" });
    await expect(discord({ tokenFile, fetch: wire(() => json({ code: 50001 }, 403)).fetch }).readback!.reactors({ chat: CHAT, id: "11", emoji: CHECK }))
      .rejects.toMatchObject({ status: 403 });
    await expect(discord({ tokenFile, fetch: wire(() => json([{ username: "no id" }])).fetch }).readback!.reactors({ chat: CHAT, id: "11", emoji: CHECK }))
      .rejects.toThrow("invalid reaction listing");
  }));

test("allowed_mentions is sent only when a caller asks for it: shared effect posts and edits notify nobody, and the ordinary post and edit are exactly what they were", () =>
  withNoNetwork(async () => {
    const transport = wire(() => json(message("11")));
    const platform = discord({ tokenFile, fetch: transport.fetch });
    await platform.post({ chat: CHAT, text: "@everyone plain" });
    await platform.post({ chat: CHAT, text: "@everyone shared", nonce: "h0123456789abcdef01234567", suppressMentions: true });
    await platform.post({ chat: CHAT, text: "not asked", suppressMentions: false });
    await platform.edit({ chat: CHAT, id: "11", text: "@here plain edit" });
    await platform.edit({ chat: CHAT, id: "11", text: "@here shared edit", suppressMentions: true });
    expect(transport.seen().map(one => one.body)).toEqual([
      { content: "@everyone plain" },
      { content: "@everyone shared", nonce: "h0123456789abcdef01234567", enforce_nonce: true, allowed_mentions: { parse: [] } },
      { content: "not asked" },
      { content: "@here plain edit" },
      { content: "@here shared edit", allowed_mentions: { parse: [] } },
    ]);
    // Telegram has no such notion: the flag changes nothing it sends.
    const tgWire = wire(() => json({ ok: true, result: { message_id: 7 } }));
    const tg = telegram({ tokenFile, fetch: tgWire.fetch });
    await tg.post({ chat: CHAT, text: "x" });
    await tg.post({ chat: CHAT, text: "x", suppressMentions: true });
    expect(tgWire.seen()[1].body).toEqual(tgWire.seen()[0].body);
  }));

test("the seam keeps what a 429 said and holds every request of that platform to it: a route's limit holds that route on that chat, the global one holds everything, and nothing is sent while it holds", () =>
  withNoNetwork(async () => {
    let clock = 1_000_000;
    const answers: Response[] = [];
    const transport = wire(() => answers.shift() ?? json(message("11")));
    const platform = discord({ tokenFile, fetch: transport.fetch, now: () => clock });
    const limit = (body: unknown, headers: Record<string, string> = {}) => json(body, 429, headers);
    const sent = () => transport.seen().length;

    // Nothing is known: nothing is held. A 429 that names no wait teaches nothing to hold to.
    expect(platform.blockedUntil!("post", CHAT)).toBeNull();
    answers.push(limit({ message: "You are being rate limited." }));
    await expect(platform.post({ chat: CHAT, text: "no deadline" })).rejects.toMatchObject({ status: 429 });
    expect(platform.blockedUntil!("post", CHAT)).toBeNull();

    // A route's limit: the body's seconds, and the scope as it came.
    answers.push(limit({ message: "You are being rate limited.", retry_after: 1.5, global: false }, { "x-ratelimit-scope": "user", "retry-after": "2" }));
    await expect(platform.post({ chat: CHAT, text: "a" })).rejects.toMatchObject({ status: 429, retryAfterMs: 1500, rateLimitScope: "user" });
    const until = clock + 1500;
    expect(platform.blockedUntil!("post", CHAT)).toBe(until);
    // It is that route on that chat and no other: another chat, another verb.
    expect(platform.blockedUntil!("post", "2000000002")).toBeNull();
    for (const verb of ["edit", "get", "list", "reactors"] as const) expect(platform.blockedUntil!(verb, CHAT)).toBeNull();

    clock += 500;
    const before = sent();
    const held = await platform.post({ chat: CHAT, text: "b" }).catch(error => error);
    // The 429 it would have been, with what is left of the wait; nothing was sent, so it is not an unknown outcome.
    expect(held).toMatchObject({ status: 429, blocked: true, retryAfterMs: 1000, rateLimitGlobal: false, rateLimitScope: "user" });
    expect(held.sent).toBeUndefined();
    expect(classifyPlatformError(held).kind).toBe("transient");
    expect(sent()).toBe(before);
    // The unrelated routes go ahead, and the limit is not lengthened by being asked about.
    await platform.post({ chat: "2000000002", text: "c" });
    await platform.edit({ chat: CHAT, id: "11", text: "d" });
    await platform.typing({ chat: CHAT });
    expect(sent()).toBe(before + 3);
    clock += 999;
    expect(platform.blockedUntil!("post", CHAT)).toBe(until);
    clock += 1;
    expect(platform.blockedUntil!("post", CHAT)).toBeNull();
    await platform.post({ chat: CHAT, text: "e" });
    expect(sent()).toBe(before + 4);

    // The account-wide limit, told by the scope alone: it holds every verb on every chat, the reads and the pull too.
    answers.push(limit({ retry_after: 2 }, { "x-ratelimit-scope": "global", "retry-after": "2" }));
    await expect(platform.post({ chat: CHAT, text: "f" })).rejects.toMatchObject({ rateLimitGlobal: true, rateLimitScope: "global", retryAfterMs: 2000 });
    const global = clock + 2000;
    for (const verb of ["post", "edit", "get", "list", "reactors"] as const) expect(platform.blockedUntil!(verb, "3000000003")).toBe(global);
    const asked = sent();
    await expect(platform.typing({ chat: "3000000003" })).rejects.toMatchObject({ status: 429, blocked: true, rateLimitGlobal: true });
    await expect(platform.readback!.self()).rejects.toMatchObject({ blocked: true });
    await expect(platform.readback!.getMessage({ chat: "3000000003", id: "1" })).rejects.toMatchObject({ blocked: true });
    await expect(platform.readback!.listMessages({ chat: "3000000003" })).rejects.toMatchObject({ blocked: true });
    await expect(platform.readback!.reactors({ chat: "3000000003", id: "1", emoji: CHECK })).rejects.toMatchObject({ blocked: true });
    await expect(platform.pull({ chat: "3000000003", cursor: null, timeoutMs: 0 })).rejects.toMatchObject({ blocked: true });
    await expect(platform.highWater({ chat: "3000000003" })).rejects.toMatchObject({ blocked: true });
    await expect(platform.admin!.describeChat("3000000003")).resolves.toMatchObject({ exists: false, failure: { code: "http-429" } });
    expect(sent()).toBe(asked);
    // When the wait is over, requests go again: the boundary only remembers what a 429 said, it does not add to it.
    clock += 2000;
    await platform.typing({ chat: "3000000003" });
    expect(sent()).toBe(asked + 1);

    // A shared-scope limit is a limit on a resource: held for that route with the wait it named, not the account's.
    answers.push(limit({ retry_after: 1336.5, global: false }, { "x-ratelimit-scope": "shared", "retry-after": "1337" }));
    await expect(platform.post({ chat: CHAT, text: "g" })).rejects.toMatchObject({ rateLimitScope: "shared", rateLimitGlobal: false, retryAfterMs: 1_336_500 });
    expect(platform.blockedUntil!("post", CHAT)).toBe(clock + 1_336_500);
    expect(platform.blockedUntil!("get", CHAT)).toBeNull();
    expect(platform.blockedUntil!("post", "2000000002")).toBeNull();
  }));

test("a request the transport lost is marked as one that may have left for an edit as for a post, and one the seam held never is", () =>
  withNoNetwork(async () => {
    const lost = discord({ tokenFile, fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    expect((await lost.edit({ chat: CHAT, id: "11", text: "x" }).catch(error => error)).sent).toBe(true);
    expect((await lost.post({ chat: CHAT, text: "x" }).catch(error => error)).sent).toBe(true);
    // A read is not marked: nothing it did could have changed anything.
    expect((await lost.readback!.self().catch(error => error)).sent).toBeUndefined();
  }));

test("the readback verbs work against the fake end to end, and Telegram and a bare platform have none", () =>
  withNoNetwork(async () => {
    const fake = createFakeDiscord();
    const channel = fake.addChannel({ name: "status" });
    const platform = discord({ tokenFile, guild: fake.guild, fetch: fake.fetch });
    const made = await platform.post({ chat: channel, text: "hello", nonce: "h-one" });
    const author = await platform.readback!.self();
    const listed = await platform.readback!.listMessages({ chat: channel, since: fake.now() - 1000 });
    expect(listed.map(one => [one.id, one.author.id, one.content])).toEqual([[made.id!, author.id, "hello"]]);
    const got = await platform.readback!.getMessage({ chat: channel, id: made.id! });
    expect(got).toMatchObject({ exists: true, message: { content: "hello", edited: false } });
    fake.react(channel, made.id!, CHECK, "200000000000000001");
    expect(await platform.readback!.reactors({ chat: channel, id: made.id!, emoji: CHECK })).toEqual([{ id: "200000000000000001", bot: false }]);

    const tg = telegram({ tokenFile, fetch: (async () => json({ ok: true, result: { message_id: 7 } })) as unknown as typeof fetch });
    expect(tg.readback).toBeUndefined();
    // A nonce is a Discord thing: Telegram's post takes the same call and sends the same request.
    expect((await tg.post({ chat: CHAT, text: "x", nonce: "n" })).id).toBe("7");
  }));
