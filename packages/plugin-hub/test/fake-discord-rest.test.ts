// The fake Discord (`helpers/fake-discord-rest.ts`) answers the way the shipped
// `discord()` verbs need it to, and the failures a check plants behave as they
// are documented to.
//
// A FIXTURE IS CODE, and a check that leans on it is only as sound as it is. This
// file is the fixture's own proof, and it goes through the SHIPPED verbs wherever
// one exists (post, edit, pull, describeChat, and the readback verbs), so it also
// pins two answers the effect ledger relies on and must not change by accident: a
// deleted channel is an answer ("gone") and a channel the bot cannot see is a
// failure ("access denied"), and those are not the same thing.
//
// NO REQUEST LEAVES THIS CHECK. The transport is the fake, and the global `fetch` is
// replaced with one that throws for the length of every body.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discord } from "../src/door/platforms/discord.ts";
import { CHECK, createFakeDiscord, snowflakeAt, snowflakeTime, type FakeDiscord } from "./helpers/fake-discord-rest.ts";

const API = "https://discord.com/api/v10";
const HEADERS = { authorization: "Bot placeholder", "content-type": "application/json" };

let dir: string;
let tokenFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-fake-discord-"));
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

/** One raw call on the fake, the way a route no verb covers is made. */
async function call(fake: FakeDiscord, method: string, path: string, body?: unknown): Promise<{ status: number; headers: Headers; json: any }> {
  const answer = await fake.fetch(`${API}${path}`, { method, headers: HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await answer.text();
  return { status: answer.status, headers: answer.headers, json: text === "" ? null : JSON.parse(text) };
}

test("the shipped verbs post, edit and pull through the fake, and the bot's own line is not read back as a message to answer", () =>
  withNoNetwork(async () => {
    const fake = createFakeDiscord();
    const channel = fake.addChannel({ name: "topic-one" });
    const platform = discord({ tokenFile, guild: fake.guild, fetch: fake.fetch });

    const made = await platform.post({ chat: channel, text: "status: one" });
    expect(made.id).not.toBeNull();
    await platform.edit({ chat: channel, id: made.id!, text: "status: two" });
    expect(fake.messagesIn(channel).map(one => one.content)).toEqual(["status: two"]);

    fake.say(channel, "hello");
    const pulled = await platform.pull({ chat: channel, cursor: null, timeoutMs: 0 });
    expect(pulled.messages.map(one => one.text)).toEqual(["hello"]);
  }));

test("a deleted channel is an answer and a channel the bot cannot see is a failure", () =>
  withNoNetwork(async () => {
    const fake = createFakeDiscord();
    const gone = fake.addChannel({ name: "gone" });
    const hidden = fake.addChannel({ name: "hidden" });
    fake.removeChannel(gone);
    fake.hideChannel(hidden);
    const platform = discord({ tokenFile, guild: fake.guild, fetch: fake.fetch });

    const deleted = await platform.admin!.describeChat(gone);
    expect(deleted.exists).toBe(false);
    expect(deleted.failure).toBeUndefined();

    const unseen = await platform.admin!.describeChat(hidden);
    expect(unseen.exists).toBe(false);
    expect(unseen.failure?.cause).toBe("access denied");

    // The readback verbs keep the same line: gone is said, hidden throws.
    expect(await platform.readback!.getMessage({ chat: gone, id: "1" })).toEqual({ exists: false, cause: "channel" });
    await expect(platform.readback!.getMessage({ chat: hidden, id: "1" })).rejects.toMatchObject({ status: 403 });
  }));

test("an enforced nonce returns the message it already made until the window has passed, and the window is an option a check can take away", () =>
  withNoNetwork(async () => {
    const fake = createFakeDiscord({ nonceWindowMs: 120_000 });
    const channel = fake.addChannel({ name: "status" });
    const post = (nonce: string) => call(fake, "POST", `/channels/${channel}/messages`, { content: "status", nonce, enforce_nonce: true });

    const first = await post("n-council-1");
    const again = await post("n-council-1");
    expect(again.json.id).toBe(first.json.id);
    expect(fake.messagesIn(channel)).toHaveLength(1);

    fake.advance(120_001);
    const late = await post("n-council-1");
    expect(late.json.id).not.toBe(first.json.id);
    expect(fake.messagesIn(channel)).toHaveLength(2);

    // 25 characters is the most a nonce may be, and a longer one is refused loudly.
    expect((await post("x".repeat(26))).status).toBe(400);
    expect((await post("x".repeat(25))).status).toBe(200);

    // Without `enforce_nonce` a nonce dedupes nothing.
    const plain = { content: "plain", nonce: "same" };
    const one = await call(fake, "POST", `/channels/${channel}/messages`, plain);
    const two = await call(fake, "POST", `/channels/${channel}/messages`, plain);
    expect(two.json.id).not.toBe(one.json.id);

    // A fake that honours no nonce at all, for the check that nothing depends on one.
    const none = createFakeDiscord({ nonceWindowMs: 0 });
    const room = none.addChannel({ name: "status" });
    const send = () => call(none, "POST", `/channels/${room}/messages`, { content: "status", nonce: "n", enforce_nonce: true });
    expect((await send()).json.id).not.toBe((await send()).json.id);
    expect(none.messagesIn(room)).toHaveLength(2);
  }));

test("the nonce comes back in the answer to a create and in no read of the message or the channel", () =>
  withNoNetwork(async () => {
    const fake = createFakeDiscord();
    const channel = fake.addChannel({ name: "status" });
    const made = await call(fake, "POST", `/channels/${channel}/messages`, { content: "status", nonce: "n-1", enforce_nonce: true });
    expect(made.json.nonce).toBe("n-1");
    expect((await call(fake, "GET", `/channels/${channel}/messages/${made.json.id}`)).json.nonce).toBeUndefined();
    expect((await call(fake, "GET", `/channels/${channel}/messages`)).json[0].nonce).toBeUndefined();
  }));

test("a planted rate limit answers 429 once and handles nothing, and a lost answer still made the message", () =>
  withNoNetwork(async () => {
    const fake = createFakeDiscord();
    const channel = fake.addChannel({ name: "status" });
    const route = new RegExp(`^POST /channels/${channel}/messages$`);
    fake.script(route, { kind: "rate_limit", retryAfter: 1.5 });

    const limited = await call(fake, "POST", `/channels/${channel}/messages`, { content: "one" });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ message: "You are being rate limited.", retry_after: 1.5, global: false });
    expect(limited.headers.get("retry-after")).toBe("2");
    expect(limited.headers.get("x-ratelimit-scope")).toBe("user");
    expect(fake.messagesIn(channel)).toHaveLength(0);
    expect((await call(fake, "POST", `/channels/${channel}/messages`, { content: "one" })).status).toBe(200);

    fake.script(route, { kind: "rate_limit", retryAfter: 3, global: true });
    const global = await call(fake, "POST", `/channels/${channel}/messages`, { content: "x" });
    expect(global.json.global).toBe(true);
    expect(global.headers.get("x-ratelimit-global")).toBe("true");

    fake.script(route, { kind: "drop", afterEffect: true });
    await expect(call(fake, "POST", `/channels/${channel}/messages`, { content: "two" })).rejects.toThrow("answer lost");
    expect(fake.messagesIn(channel).map(one => one.content)).toEqual(["one", "two"]);

    fake.script(route, { kind: "server_error", afterEffect: true });
    expect((await call(fake, "POST", `/channels/${channel}/messages`, { content: "three" })).status).toBe(500);
    expect(fake.messagesIn(channel).map(one => one.content)).toEqual(["one", "two", "three"]);

    fake.script(route, { kind: "refuse", status: 403, code: 50013 });
    const refused = await call(fake, "POST", `/channels/${channel}/messages`, { content: "four" });
    expect([refused.status, refused.json.code]).toEqual([403, 50013]);
    expect(fake.messagesIn(channel)).toHaveLength(3);
    expect(fake.requestsTo(route).map(one => one.fault)).toEqual(["rate_limit", null, "rate_limit", "drop", "server_error", "refuse"]);
  }));

test("a late drop handles nothing now and lands, in order, only when the check says so: the request a timeout gave up on and Discord handled afterwards", () =>
  withNoNetwork(async () => {
    const fake = createFakeDiscord();
    const channel = fake.addChannel({ name: "status" });
    const platform = discord({ tokenFile, guild: fake.guild, fetch: fake.fetch });
    const made = await platform.post({ chat: channel, text: "v1" });
    const edit = new RegExp(`^PATCH /channels/${channel}/messages/\\d+$`);

    fake.script(edit, { kind: "drop", late: true });
    const lost = await platform.edit({ chat: channel, id: made.id!, text: "v2" }).catch(error => error);
    expect(lost.sent).toBe(true);
    expect(fake.inTransit()).toBe(1);
    expect(fake.messagesIn(channel).map(one => one.content)).toEqual(["v1"]);
    // A newer edit lands first; the old one lands after it and wins, which is what a caller must never allow to happen unnoticed.
    await platform.edit({ chat: channel, id: made.id!, text: "v3" });
    expect(fake.messagesIn(channel).map(one => one.content)).toEqual(["v3"]);
    expect(fake.land()).toBe(1);
    expect(fake.inTransit()).toBe(0);
    expect(fake.messagesIn(channel).map(one => one.content)).toEqual(["v2"]);
    expect(fake.land()).toBe(0);
    expect(fake.requestsTo(edit).map(one => one.fault)).toEqual(["drop", null]);
  }));

test("reactions come back in pages of user ids in the order the fake was told to use, and a reaction taken away is gone", () =>
  withNoNetwork(async () => {
    for (const reactorOrder of ["ascending", "descending"] as const) {
      const fake = createFakeDiscord({ reactorOrder });
      const channel = fake.addChannel({ name: "preview" });
      const message = fake.say(channel, "preview", fake.botId);
      const users = Array.from({ length: 130 }, (_, at) => String(200000000000000000n + BigInt(at)));
      for (const user of users) fake.react(channel, message, CHECK, user);
      fake.react(channel, message, "👍", "300000000000000000");

      const path = `/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(CHECK)}`;
      const first = await call(fake, "GET", `${path}?limit=100`);
      expect(first.json).toHaveLength(100);
      const cursor = reactorOrder === "ascending" ? first.json[99].id : first.json[0].id;
      const second = await call(fake, "GET", `${path}?limit=100&after=${cursor}`);
      expect(second.json.map((one: { id: string }) => one.id).sort()).toEqual(users.slice(100));
      // 25 when no limit is asked for, as documented.
      expect((await call(fake, "GET", path)).json).toHaveLength(25);

      fake.unreact(channel, message, CHECK, users[129]);
      expect((await call(fake, "GET", `${path}?limit=100&after=${cursor}`)).json).toHaveLength(29);
      expect((await call(fake, "GET", `/channels/${channel}/messages/${message}`)).json.reactions)
        .toEqual([{ count: 129, me: false, emoji: { id: null, name: CHECK } }, { count: 1, me: false, emoji: { id: null, name: "👍" } }]);
    }
  }));

test("an after read answers the messages nearest its anchor unless the fake is told otherwise, and a bot other than ours says it is one", () =>
  withNoNetwork(async () => {
    for (const listAfter of ["oldest", "newest"] as const) {
      const fake = createFakeDiscord({ listAfter });
      const channel = fake.addChannel({ name: "busy" });
      const ids = Array.from({ length: 5 }, (_, at) => fake.say(channel, `m${at}`));
      const page = (await call(fake, "GET", `/channels/${channel}/messages?after=${ids[0]}&limit=2`)).json.map((one: { content: string }) => one.content);
      expect(page).toEqual(listAfter === "oldest" ? ["m2", "m1"] : ["m4", "m3"]);
    }
    const fake = createFakeDiscord();
    const channel = fake.addChannel({ name: "other-bot" });
    fake.say(channel, "not ours", "555000000000000001", true);
    const seen = (await call(fake, "GET", `/channels/${channel}/messages`)).json[0];
    expect(seen.author).toMatchObject({ id: "555000000000000001", bot: true });
    expect((await call(fake, "GET", "/users/@me")).json.id).toBe(fake.botId);
  }));

test("an edited preview says so, a deleted one is Unknown Message, and what Discord keeps of the content is the fake's to change", () =>
  withNoNetwork(async () => {
    const fake = createFakeDiscord({ normalize: content => content.replace(/[ \t]+$/gm, "") });
    const channel = fake.addChannel({ name: "preview" });
    const sent = await call(fake, "POST", `/channels/${channel}/messages`, { content: "line   \nnext" });
    expect(sent.json.content).toBe("line\nnext");
    const preview = sent.json.id as string;
    expect((await call(fake, "GET", `/channels/${channel}/messages/${preview}`)).json.edited_timestamp).toBeNull();
    fake.humanEdit(channel, preview, "preview, changed");
    expect((await call(fake, "GET", `/channels/${channel}/messages/${preview}`)).json.edited_timestamp).not.toBeNull();
    fake.deleteMessage(channel, preview);
    const gone = await call(fake, "GET", `/channels/${channel}/messages/${preview}`);
    expect([gone.status, gone.json.code]).toEqual([404, 10008]);
    // The snowflake carries its own time, so "made since my attempt began" is a comparison of ids.
    const before = fake.now();
    fake.advance(1000);
    const later = fake.say(channel, "later");
    expect(BigInt(later) > BigInt(snowflakeAt(before))).toBe(true);
    expect(snowflakeTime(later)).toBe(before + 1000);
  }));
