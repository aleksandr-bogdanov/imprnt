// The effect ledger: a chat message is asked for once, sent once, edited to the
// newest content asked for, and after a crash or a lost answer looked for before
// anything would send it again.
//
// The store is a disposable Postgres, the door's delivery code and the Discord seam
// are the shipped ones, and the network behind the seam is the fake Discord. What
// a check calls a "restart" is a new door context on a new connection over the same
// database and the same fake. The two roles that ask (`hub_runner`, `hub_hub`) and the
// role that sends (`hub_door`) are real roles with the real grants.
//
// THE RULE UNDER TEST is the root disposition of this task: nothing that is missing,
// empty or newer proves that an uncertain create did not happen, so an uncertain create
// is only ever RESOLVED BY POSITIVE EVIDENCE, and otherwise it is `unknown` and is
// never sent again by machinery. And a 429 is the one answer that is definite: it names
// its own wait, and that wait is exactly what the effect keeps.

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { closeStages, DOOR, effectRow, pass, removeEffectDirs, stageEffects, type EffectsStage } from "./helpers/effects-fixture.ts";
import { createFakePlatform } from "./helpers/fake-platform.ts";
import { readEffectWork, runEffectWork, type EffectsGate } from "../src/door/effects.ts";
import { startEffects } from "../src/door/effects-task.ts";
import { listenForWork } from "../src/store/listen.ts";
import { storeUrlAs } from "../src/store/connect.ts";
import {
  EffectTooLong, effectMarker, isSettled, readEffect, renderEffect, roomFor, sanitizeText, splitText, wantEffect,
} from "../src/store/effects.ts";

let cluster: Cluster;

beforeAll(async () => { cluster = await startCluster(); });
afterEach(closeStages);
afterAll(async () => {
  removeEffectDirs();
  await cluster?.stop();
});

const posts = (stage: EffectsStage) => stage.fake.requestsTo(new RegExp(`^POST /channels/${stage.channel}/messages$`));
const listings = (stage: EffectsStage) => stage.fake.requestsTo(new RegExp(`^GET /channels/${stage.channel}/messages$`));
const patches = (stage: EffectsStage) => stage.fake.requestsTo(new RegExp(`^PATCH /channels/${stage.channel}/messages/\\d+$`));
const KEY = "council:c1:status";
const ask = (stage: EffectsStage, text: string, key = KEY, chat = stage.channel) =>
  wantEffect(stage.as("hub_runner"), { key, door: DOOR, chat, owner: "council:c1", text });

test("an effect is wanted once and sent once: the row says a request is coming before it is made, the nonce and marker ride on it, and asking again sends nothing", async () => {
  const stage = await stageEffects(cluster);
  const asked = await ask(stage, "Council c1: waiting for two workers");
  expect(asked).toEqual({ revision: 1, state: "not_sent" });
  const ctx = stage.context({
    platform: stage.platform(async (method, url) => {
      if (method !== "POST" || !url.pathname.endsWith("/messages")) return;
      // Inside the request: the row is already committed as in flight, with what is being sent.
      const seen = await effectRow(stage, KEY);
      expect([seen.state, seen.attempts, seen.attempt_revision]).toEqual(["in_flight", 1, 1]);
      expect(seen.attempt_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(seen.platform_id).toBeNull();
    }),
  });
  const gate = stage.gate();
  await pass(ctx, gate);

  const row = await effectRow(stage, KEY);
  const made = stage.fake.messagesIn(stage.channel);
  expect(made).toHaveLength(1);
  expect([row.state, row.platform_id, row.applied_revision, row.wanted_revision]).toEqual(["confirmed", made[0].id, 1, 1]);
  // The exact content: the text, and under it the marker line, and nothing else.
  expect(made[0].content).toBe(`Council c1: waiting for two workers\n\`${effectMarker(KEY)}\``);
  expect(row.wanted_content).toBe(made[0].content);
  const [sent] = posts(stage);
  // Nobody the text names is notified: the shared effect and preview messages may echo an owner's words.
  expect(sent.body).toEqual({ content: made[0].content, nonce: row.nonce, enforce_nonce: true, allowed_mentions: { parse: [] } });
  expect(row.nonce.length).toBeLessThanOrEqual(25);

  await pass(ctx, gate);
  await pass(stage.context(), stage.gate(), true);
  expect(await ask(stage, "Council c1: waiting for two workers")).toEqual({ revision: 1, state: "confirmed" });
  expect(posts(stage)).toHaveLength(1);
  expect(patches(stage)).toHaveLength(0);
});

test("a lost answer is found again by its marker and adopted, with no second post, whether or not the nonce window has passed or is honoured at all", async () => {
  for (const nonceWindowMs of [120_000, 0]) {
    const stage = await stageEffects(cluster, { nonceWindowMs });
    await ask(stage, "status one");
    stage.fake.script(new RegExp(`^POST /channels/${stage.channel}/messages$`), { kind: "drop", afterEffect: true });
    const gate = stage.gate();
    const first = stage.context();
    const retryAt = await pass(first, gate);

    // The message exists and nobody was told: the row is in flight, and the look is later.
    let row = await effectRow(stage, KEY);
    expect([row.state, row.platform_id, row.attempts]).toEqual(["in_flight", null, 1]);
    expect(retryAt).toBe(stage.fake.now() + 30_000);
    expect(stage.fake.messagesIn(stage.channel)).toHaveLength(1);

    // Before then nothing is asked of the platform at all.
    const before = stage.fake.requests().length;
    await pass(stage.context(), stage.gate());
    expect(stage.fake.requests().length).toBe(before);

    // A restarted door, past the retry and past the nonce window: it looks, finds, adopts.
    stage.fake.advance(200_000);
    await pass(stage.context(), stage.gate());
    row = await effectRow(stage, KEY);
    const [only] = stage.fake.messagesIn(stage.channel);
    expect([row.state, row.platform_id, row.applied_revision]).toEqual(["confirmed", only.id, 1]);
    expect(row.evidence.confirmed.by).toBe("readback");
    expect(posts(stage)).toHaveLength(1);
    expect(stage.fake.messagesIn(stage.channel)).toHaveLength(1);
  }
});

test("a 5xx that handled the request and one that did not are both left uncertain, and only the message that exists is found", async () => {
  const stage = await stageEffects(cluster);
  await ask(stage, "handled", "k:handled");
  await ask(stage, "not handled", "k:lost");
  const route = new RegExp(`^POST /channels/${stage.channel}/messages$`);
  stage.fake.script(route, { kind: "server_error", afterEffect: true });
  stage.fake.script(route, { kind: "server_error" });
  await pass(stage.context(), stage.gate());
  expect((await effectRow(stage, "k:handled")).state).toBe("in_flight");
  expect((await effectRow(stage, "k:lost")).state).toBe("in_flight");
  stage.fake.advance(31_000);
  await pass(stage.context(), stage.gate());
  expect((await effectRow(stage, "k:handled")).state).toBe("confirmed");
  // The other could still land, or never did: another look, not another post.
  const lost = await effectRow(stage, "k:lost");
  expect([lost.state, lost.reconcile_attempts]).toEqual(["in_flight", 1]);
  expect(posts(stage)).toHaveLength(2);
});

test("a create with no positive evidence is looked for a bounded number of times and is then unknown for good: nothing sends it again, and a late message is adopted only by a look", async () => {
  const stage = await stageEffects(cluster);
  await ask(stage, "never seen");
  stage.fake.script(new RegExp(`^POST /channels/${stage.channel}/messages$`), { kind: "drop" });
  const gate = stage.gate();
  await pass(stage.context(), gate);
  expect((await effectRow(stage, KEY)).state).toBe("in_flight");

  for (let look = 1; look <= 5; look += 1) {
    stage.fake.advance(31_000);
    await pass(stage.context(), gate);
  }
  let row = await effectRow(stage, KEY);
  expect([row.state, row.reconcile_attempts, row.retry_at]).toEqual(["unknown", 5, null]);
  expect(row.evidence.unknown).toMatchObject({ reason: "no-positive-evidence", complete: true, looks: 5 });
  expect(listings(stage)).toHaveLength(5);

  // A day, a restart and a new revision later, it is still one post and still unknown.
  stage.fake.advance(86_400_000);
  await ask(stage, "never seen, changed");
  await pass(stage.context(), gate);
  await pass(stage.context(), gate, true);
  row = await effectRow(stage, KEY);
  expect([row.state, row.wanted_revision, row.applied_revision]).toEqual(["unknown", 2, 0]);
  expect(posts(stage)).toHaveLength(1);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(0);
  expect(row.evidence.rechecked).toMatchObject({ reason: "no-positive-evidence" });
  // The table refuses the one move that could send it twice, whoever asks.
  await expect(stage.admin`update platform_effect set state = 'not_sent' where key = ${KEY}`.execute()).rejects.toThrow(/never sent again/);
  await expect(stage.as("hub_door").sql`update platform_effect set state = 'not_sent' where key = ${KEY}`.execute()).rejects.toThrow(/never sent again/);

  // The request was in flight after all. Its message lands, exactly as attempted.
  // A look at the next start finds it, and that is the only way out of unknown.
  const attempted = (await effectRow(stage, KEY)).wanted_content;
  expect(attempted).toContain("never seen, changed");
  // What the attempt SENT was revision 1, and only that is adopted.
  stage.fake.say(stage.channel, attempted, stage.fake.botId);
  await pass(stage.context(), gate, true);
  expect((await effectRow(stage, KEY)).state).toBe("unknown");
  const sent = renderEffect(KEY, "never seen").content;
  const late = stage.fake.say(stage.channel, sent, stage.fake.botId);
  await pass(stage.context(), gate, true);
  row = await effectRow(stage, KEY);
  expect([row.state, row.platform_id, row.applied_revision, row.wanted_revision]).toEqual(["confirmed", late, 1, 2]);
  // Its newer content is an ordinary edit now, and that is all that follows.
  await pass(stage.context(), gate);
  expect(patches(stage)).toHaveLength(1);
  expect(posts(stage)).toHaveLength(1);
});

test("a read that fails, is refused or is rate limited is not evidence either way: it is counted, or waited out, and never becomes a post", async () => {
  const stage = await stageEffects(cluster);
  await ask(stage, "read trouble");
  const list = new RegExp(`^GET /channels/${stage.channel}/messages$`);
  stage.fake.script(new RegExp(`^POST /channels/${stage.channel}/messages$`), { kind: "drop" });
  const gate = stage.gate();
  await pass(stage.context(), gate);

  // A limit on the read names its wait, holds the look and costs no attempt.
  stage.fake.advance(31_000);
  stage.fake.script(list, { kind: "rate_limit", retryAfter: 4 });
  const at = await pass(stage.context(), gate);
  let row = await effectRow(stage, KEY);
  expect([row.state, row.reconcile_attempts]).toEqual(["in_flight", 0]);
  expect(at).toBe(stage.fake.now() + 4000);
  expect(new Date(row.retry_at).getTime()).toBe(at as number);

  // A 500 and a 403 each cost one look, and after the bound the outcome is unknown, not a post.
  stage.fake.advance(4000);
  stage.fake.script(list, { kind: "server_error" });
  await pass(stage.context(), gate);
  stage.fake.advance(31_000);
  stage.fake.script(list, { kind: "refuse", status: 403, code: 50001 }, { times: 4 });
  for (let look = 0; look < 4; look += 1) {
    await pass(stage.context(), gate);
    stage.fake.advance(31_000);
  }
  row = await effectRow(stage, KEY);
  expect(row.state).toBe("unknown");
  expect(row.evidence.unknown).toMatchObject({ reason: "read-failed", failure: { status: 403, discord_code: 50001 } });
  expect(posts(stage)).toHaveLength(1);
});

test("adoption pins author, chat, exact content and marker: a copy by anybody else, in another chat or with other words authorizes nothing", async () => {
  const stage = await stageEffects(cluster);
  const elsewhere = stage.fake.addChannel({ name: "elsewhere" });
  await ask(stage, "decoy me");
  stage.fake.script(new RegExp(`^POST /channels/${stage.channel}/messages$`), { kind: "drop" });
  const gate = stage.gate();
  await pass(stage.context(), gate);
  const content = (await effectRow(stage, KEY)).wanted_content as string;

  stage.fake.say(stage.channel, content, "200000000000000009");
  stage.fake.say(stage.channel, content, "555000000000000001", true);
  stage.fake.say(stage.channel, `${content}!`, stage.fake.botId);
  stage.fake.say(stage.channel, content.replace("decoy me", "decoy you"), stage.fake.botId);
  stage.fake.say(elsewhere, content, stage.fake.botId);
  for (let look = 0; look < 5; look += 1) {
    stage.fake.advance(31_000);
    await pass(stage.context(), gate);
  }
  const row = await effectRow(stage, KEY);
  expect([row.state, row.platform_id]).toEqual(["unknown", null]);

  // The real one, among the decoys, is the one that is adopted.
  const ours = stage.fake.say(stage.channel, content, stage.fake.botId);
  await pass(stage.context(), gate, true);
  expect((await effectRow(stage, KEY)).platform_id).toBe(ours);
});

test("content Discord kept differently from what was sent is not adopted as ours, and says why", async () => {
  const stage = await stageEffects(cluster, { normalize: content => content.replace("one", "1") });
  await ask(stage, "status one");
  stage.fake.script(new RegExp(`^POST /channels/${stage.channel}/messages$`), { kind: "drop", afterEffect: true });
  const gate = stage.gate();
  await pass(stage.context(), gate);
  for (let look = 0; look < 5; look += 1) {
    stage.fake.advance(31_000);
    await pass(stage.context(), gate);
  }
  const row = await effectRow(stage, KEY);
  expect([row.state, row.platform_id]).toEqual(["unknown", null]);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(1);
  expect(posts(stage)).toHaveLength(1);
});

test("a rate limit on a create waits exactly what the platform said, sends nothing before it, and a global one holds every effect of the door", async () => {
  const stage = await stageEffects(cluster);
  await ask(stage, "one", "k:1");
  await ask(stage, "two", "k:2");
  const route = new RegExp(`^POST /channels/${stage.channel}/messages$`);
  stage.fake.script(route, { kind: "rate_limit", retryAfter: 2.5, global: true });
  const gate = stage.gate();
  const ctx = stage.context();
  const start = stage.fake.now();
  const next = await pass(ctx, gate);

  expect(next).toBe(start + 2500);
  expect(gate.notBefore).toBe(start + 2500);
  const first = await effectRow(stage, "k:1");
  expect([first.state, first.attempts, first.evidence.rate_limited.global]).toEqual(["not_sent", 1, true]);
  expect(new Date(first.retry_at).getTime()).toBe(start + 2500);
  // The second was never tried: the whole door is held.
  expect(posts(stage)).toHaveLength(1);
  expect((await effectRow(stage, "k:2")).attempts).toBe(0);

  stage.fake.advance(2499);
  await pass(ctx, gate);
  expect(posts(stage)).toHaveLength(1);
  stage.fake.advance(1);
  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["one", "two"]);
  expect((await effectRow(stage, "k:1")).attempts).toBe(2);
  expect(posts(stage)).toHaveLength(3);

  // A limit that is not global holds its ROUTE, whichever effect met it: the effects that post to the same chat
  // wait together, without a claim or a request of their own, and one for another chat goes ahead.
  const elsewhere = stage.fake.addChannel({ name: "elsewhere" });
  await ask(stage, "three", "k:3");
  await ask(stage, "four", "k:4");
  await ask(stage, "five", "k:5", elsewhere);
  stage.fake.script(route, { kind: "rate_limit", retryAfter: 1 });
  const held = await pass(ctx, gate);
  const limitedAt = stage.fake.now();
  expect(held).toBe(limitedAt + 1000);
  const three = await effectRow(stage, "k:3");
  expect([three.state, three.attempts, three.evidence.rate_limited.global]).toEqual(["not_sent", 1, false]);
  expect(new Date(three.retry_at).getTime()).toBe(limitedAt + 1000);
  const four = await effectRow(stage, "k:4");
  expect([four.state, four.attempts]).toEqual(["not_sent", 0]);
  expect((await effectRow(stage, "k:5")).state).toBe("confirmed");
  expect(posts(stage)).toHaveLength(4);
  expect(gate.notBefore).toBe(start + 2500);

  // A wake before the deadline changes nothing, however often it comes: the deadline is the platform's, not the notification's.
  const requests = stage.fake.requests().length;
  stage.fake.advance(999);
  for (let wake = 0; wake < 3; wake += 1) expect(await pass(ctx, gate)).toBe(limitedAt + 1000);
  expect(stage.fake.requests().length).toBe(requests);
  stage.fake.advance(1);
  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["one", "two", "three", "four"]);
  expect(posts(stage)).toHaveLength(6);
});

test("a limit any request of the platform learned holds the effects of the door, and one an effect learned holds the ordinary traffic: they share the platform's boundary", async () => {
  const stage = await stageEffects(cluster);
  const route = new RegExp(`^POST /channels/${stage.channel}/messages$`);
  const platform = stage.platform();
  const ctx = stage.context({ platform });
  const gate = stage.gate();

  // The ordinary reply path (a plain post, no nonce) meets an account-wide limit.
  await ask(stage, "waits for the platform", "k:1");
  stage.fake.script(route, { kind: "rate_limit", retryAfter: 3, global: true });
  await expect(platform.post({ chat: stage.channel, text: "an ordinary reply" })).rejects.toMatchObject({ status: 429, retryAfterMs: 3000, rateLimitGlobal: true });
  const heard = stage.fake.requests().length;
  const limitedAt = stage.fake.now();

  // The effect task has its own gate empty, and still does not ask: the platform knows.
  const next = await pass(ctx, gate);
  expect(next).toBe(limitedAt + 3000);
  expect(gate.notBefore).toBe(0);
  expect(stage.fake.requests().length).toBe(heard);
  expect((await effectRow(stage, "k:1")).attempts).toBe(0);

  // Every verb is held, the reads and the pull included, and the ordinary post fails at once, sending nothing.
  await expect(platform.readback!.self()).rejects.toMatchObject({ status: 429, blocked: true, rateLimitGlobal: true });
  await expect(platform.pull({ chat: stage.channel, cursor: null, timeoutMs: 0 })).rejects.toMatchObject({ status: 429, blocked: true });
  await expect(platform.post({ chat: stage.channel, text: "again" })).rejects.toMatchObject({ blocked: true, retryAfterMs: 3000 });
  expect(stage.fake.requests().length).toBe(heard);

  // When it lapses the request goes.
  stage.fake.advance(3000);
  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["waits for the platform"]);

  // And the other way about: a limit an effect met holds an ordinary post to that route, not to another chat.
  const elsewhere = stage.fake.addChannel({ name: "elsewhere" });
  await ask(stage, "second", "k:2");
  stage.fake.script(route, { kind: "rate_limit", retryAfter: 2 });
  await pass(ctx, gate);
  const seen = stage.fake.requests().length;
  await expect(platform.post({ chat: stage.channel, text: "plain" })).rejects.toMatchObject({ blocked: true, status: 429, retryAfterMs: 2000 });
  expect(stage.fake.requests().length).toBe(seen);
  await expect(platform.post({ chat: elsewhere, text: "another chat" })).resolves.toMatchObject({ id: expect.any(String) });
  // Another verb on the same chat is another route and is not held (the fake has no typing route: it answers 404, a request that was sent).
  const typed = await platform.typing({ chat: stage.channel }).then(() => null, (error: { blocked?: boolean }) => error);
  expect(typed?.blocked).toBeUndefined();
  expect(stage.fake.requestsTo(new RegExp(`^POST /channels/${stage.channel}/typing$`))).toHaveLength(1);
});

test("a definite refusal of a create is final and nothing is sent again; an answer without an id is uncertain", async () => {
  const stage = await stageEffects(cluster);
  await ask(stage, "forbidden");
  stage.fake.script(new RegExp(`^POST /channels/${stage.channel}/messages$`), { kind: "refuse", status: 403, code: 50013 });
  const gate = stage.gate();
  await pass(stage.context(), gate);
  let row = await effectRow(stage, KEY);
  expect([row.state, row.failure.kind, row.failure.status, row.failure.discord_code, row.failure.cause]).toEqual(["failed", "permanent", 403, 50013, "access denied"]);
  stage.fake.advance(86_400_000);
  await pass(stage.context(), gate, true);
  expect(posts(stage)).toHaveLength(1);
  await expect(stage.admin`update platform_effect set state = 'not_sent' where key = ${KEY}`.execute()).rejects.toThrow(/stays so/);

  // A create the platform answered with no message id may still have made one.
  const bare = createFakePlatform({ name: "discord" });
  const platform = { ...bare.platform, post: async () => ({ id: null }) };
  await ask(stage, "no id", "k:noid");
  await pass(stage.context({ platform }), gate);
  row = await effectRow(stage, "k:noid");
  expect([row.state, row.failure.code]).toEqual(["in_flight", "no-message-id"]);
});

test("an edit takes the newest content asked for, once, and what is applied is the revision that was SENT", async () => {
  const stage = await stageEffects(cluster);
  await ask(stage, "v1");
  const gate = stage.gate();
  await pass(stage.context(), gate);
  expect(patches(stage)).toHaveLength(0);

  for (let version = 2; version <= 11; version += 1) await ask(stage, `v${version}`);
  expect((await effectRow(stage, KEY)).wanted_revision).toBe(11);
  await pass(stage.context(), gate);
  expect(patches(stage).map(one => String(one.body?.content).split("\n")[0])).toEqual(["v11"]);
  let row = await effectRow(stage, KEY);
  expect([row.applied_revision, row.wanted_revision]).toEqual([11, 11]);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v11"]);
  expect(posts(stage)).toHaveLength(1);

  // Newer content asked for while an edit is in flight: the answer to the old edit is not the newest.
  let moved = false;
  const ctx = stage.context({
    platform: stage.platform(async (method) => {
      if (method === "PATCH" && !moved) { moved = true; await ask(stage, "v13"); }
    }),
  });
  await ask(stage, "v12");
  await pass(ctx, gate);
  row = await effectRow(stage, KEY);
  expect([row.applied_revision, row.wanted_revision]).toEqual([12, 13]);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v12"]);
  await pass(ctx, gate);
  row = await effectRow(stage, KEY);
  expect([row.applied_revision, row.wanted_revision]).toEqual([13, 13]);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v13"]);
  expect(posts(stage)).toHaveLength(1);
});

test("an edit that lost its answer is looked for and never sent over, a limit is waited out, a refusal stops until there is newer content, and a message the owner deleted is missing and never replaced", async () => {
  const stage = await stageEffects(cluster);
  const edit = new RegExp(`^PATCH /channels/${stage.channel}/messages/\\d+$`);
  const gate = stage.gate();
  await ask(stage, "v1");
  await pass(stage.context(), gate);

  await ask(stage, "v2");
  stage.fake.script(edit, { kind: "rate_limit", retryAfter: 1.5 });
  const limited = await pass(stage.context(), gate);
  expect(limited).toBe(stage.fake.now() + 1500);
  await pass(stage.context(), gate);
  expect(patches(stage)).toHaveLength(1);
  stage.fake.advance(1500);
  await pass(stage.context(), gate);
  expect((await effectRow(stage, KEY)).applied_revision).toBe(2);

  // A 5xx that DID handle the request: the answer was lost, so the edit is left in flight, pinned to its attempt.
  // Nothing newer is sent over it however much is asked for meanwhile, and the look that finds its content settles it.
  await ask(stage, "v3");
  stage.fake.script(edit, { kind: "server_error", afterEffect: true });
  expect(await pass(stage.context(), gate)).toBe(stage.fake.now() + 30_000);
  let row = await effectRow(stage, KEY);
  expect([row.edit_state, row.edit_revision, row.applied_revision, row.failure.kind, row.failure.revision]).toEqual(["in_flight", 3, 2, "uncertain", 3]);
  await ask(stage, "v4");
  const sent = patches(stage).length;
  await pass(stage.context(), gate);
  expect(patches(stage)).toHaveLength(sent);
  stage.fake.advance(30_000);
  await pass(stage.context(), gate);
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision, row.wanted_revision]).toEqual(["idle", 3, 4]);
  expect(row.evidence.edit_confirmed).toMatchObject({ by: "readback" });
  await pass(stage.context(), gate);
  expect((await effectRow(stage, KEY)).applied_revision).toBe(4);
  expect(patches(stage)).toHaveLength(sent + 1);

  // A refusal for this content is remembered against its revision and is not retried; newer content is.
  await ask(stage, "v5");
  stage.fake.script(edit, { kind: "refuse", status: 403, code: 50013 });
  await pass(stage.context(), gate);
  row = await effectRow(stage, KEY);
  expect([row.state, row.edit_state, row.applied_revision, row.failure.permanent, row.failure.revision]).toEqual(["confirmed", "idle", 4, true, 5]);
  const before = patches(stage).length;
  stage.fake.advance(86_400_000);
  await pass(stage.context(), gate);
  await pass(stage.context(), gate, true);
  expect(patches(stage)).toHaveLength(before);
  await ask(stage, "v6");
  await pass(stage.context(), gate);
  row = await effectRow(stage, KEY);
  expect([row.applied_revision, row.failure]).toEqual([6, null]);

  // A 404 that names no message or channel is a refusal, not a deletion.
  await ask(stage, "v7");
  stage.fake.script(edit, { kind: "refuse", status: 404, code: 0 });
  await pass(stage.context(), gate);
  row = await effectRow(stage, KEY);
  expect([row.state, row.failure.permanent]).toEqual(["confirmed", true]);

  // The owner deleted the message: Discord says Unknown Message, and the effect says missing.
  await ask(stage, "v8");
  const [live] = stage.fake.messagesIn(stage.channel);
  stage.fake.deleteMessage(stage.channel, live.id);
  await pass(stage.context(), gate);
  row = await effectRow(stage, KEY);
  expect([row.state, row.edit_state, row.platform_id, row.failure.discord_code]).toEqual(["missing", "idle", live.id, 10008]);
  const after = stage.fake.requests().length;
  stage.fake.advance(86_400_000);
  await pass(stage.context(), gate, true);
  expect(await ask(stage, "v9")).toMatchObject({ state: "missing" });
  await pass(stage.context(), gate);
  expect(stage.fake.requests().length).toBe(after);
  expect(posts(stage)).toHaveLength(1);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(0);
  // The caller that wants another records a NEW effect, which is an ordinary one.
  await ask(stage, "replacement", "council:c1:status:2");
  await pass(stage.context(), gate);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(1);
  await expect(stage.admin`update platform_effect set state = 'confirmed' where key = ${KEY}`.execute()).rejects.toThrow(/stays so/);
});

/** A message whose newest edit was sent, lost and never found: `unknown`, with newer content asked for behind it. */
async function lostEdit(stage: EffectsStage, gate: EffectsGate, key = KEY, chat = stage.channel) {
  await ask(stage, "v1", key, chat);
  await pass(stage.context(), gate);
  await ask(stage, "v2", key, chat);
  stage.fake.script(new RegExp(`^PATCH /channels/${chat}/messages/\\d+$`), { kind: "drop", late: true });
  await pass(stage.context(), gate);
  await ask(stage, "v3", key, chat);
  for (let look = 1; look <= 5; look += 1) {
    stage.fake.advance(31_000);
    await pass(stage.context(), gate);
  }
  const row = await effectRow(stage, key);
  expect([row.edit_state, row.applied_revision, row.wanted_revision]).toEqual(["unknown", 1, 3]);
  return row;
}

test("edits are claimed one at a time per message: two doors that read the same edit as owed send ONE request, and newer content asked for meanwhile is sent after its answer, never over it", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  await ask(stage, "v1");
  await pass(stage.context(), gate);
  await ask(stage, "v2");

  // Door A reads the edit as owed and its request is held on the way; door B has read the same.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  const doorA = stage.context({
    store: stage.fresh("hub_door"),
    platform: stage.platform(async (method) => { if (method === "PATCH") { arrived(); await held; } }),
  });
  const doorB = stage.context({ store: stage.fresh("hub_door") });
  const [owedA, owedB] = [await readEffectWork(doorA), await readEffectWork(doorB)];
  expect([owedA.rows.length, owedB.rows.length]).toEqual([1, 1]);
  const running = runEffectWork(doorA, stage.gate(), owedA);
  await reached;

  // A's claim is committed BEFORE its request, and pins the attempt.
  let row = await effectRow(stage, KEY);
  expect([row.edit_state, row.edit_revision, row.edit_attempts]).toEqual(["in_flight", 2, 1]);
  expect(row.edit_hash).toMatch(/^[0-9a-f]{64}$/);
  // B cannot claim over it with the read it made, or with a fresh one, and newer content changes nothing about that.
  await runEffectWork(doorB, stage.gate(), owedB);
  await ask(stage, "v3");
  await pass(doorB, stage.gate());
  expect(patches(stage)).toHaveLength(0);

  release();
  await running;
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision, row.wanted_revision]).toEqual(["idle", 2, 3]);
  expect(patches(stage)).toHaveLength(1);
  // The content was sent with mentions suppressed, like a create's.
  expect(patches(stage)[0].body).toMatchObject({ allowed_mentions: { parse: [] } });
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v2"]);

  // Only now is v3 an edit, and it is sent once, by whichever door is next.
  await pass(doorB, stage.gate());
  await pass(doorA, stage.gate());
  expect(patches(stage)).toHaveLength(2);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v3"]);
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision, row.edit_attempts]).toEqual(["idle", 3, 2]);
  expect(isSettled((await readEffect(stage.as("hub_hub"), KEY))!)).toBe(true);
});

test("a delayed old edit that lands LATE cannot overwrite a newer one: the row is not clean while it can still land, nothing newer is sent over it, and the look that finds it lets the newer content follow", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  await ask(stage, "v1");
  await pass(stage.context(), gate);
  await ask(stage, "v2");
  // v2's request leaves, its answer is lost, and Discord handles it only later.
  stage.fake.script(new RegExp(`^PATCH /channels/${stage.channel}/messages/\\d+$`), { kind: "drop", late: true });
  await pass(stage.context(), gate);
  let row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision, row.wanted_revision]).toEqual(["in_flight", 1, 2]);
  expect(stage.fake.inTransit()).toBe(1);
  await ask(stage, "v3");

  // The looks see v1 on the platform. That proves nothing about a request that may still land, so it is looked for
  // a bounded number of times and then said to be UNKNOWN, and v3 is not sent over it however long that takes.
  for (let look = 1; look <= 5; look += 1) {
    stage.fake.advance(31_000);
    await pass(stage.context(), gate);
  }
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision, row.wanted_revision, row.retry_at]).toEqual(["unknown", 1, 3, null]);
  expect(row.evidence.edit_unknown).toMatchObject({ reason: "no-positive-evidence", revision: 2, looks: 5 });
  expect(isSettled((await readEffect(stage.as("hub_hub"), KEY))!)).toBe(false);
  expect(patches(stage)).toHaveLength(1);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v1"]);

  // A day and a restart later it is still not sent over and still not called up to date.
  stage.fake.advance(86_400_000);
  await pass(stage.context(), gate);
  await pass(stage.context(), gate, true);
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision]).toEqual(["unknown", 1]);
  expect(row.evidence.edit_rechecked).toMatchObject({ reason: "no-positive-evidence" });
  expect(patches(stage)).toHaveLength(1);
  // The table refuses the claim over it, whoever asks.
  await expect(stage.admin`update platform_effect set edit_state = 'in_flight', edit_attempt_id = 'other' where key = ${KEY}`.execute())
    .rejects.toThrow(/no newer edit is claimed/);

  // The old request lands now, after v3 was asked for. The look at the next start finds it and settles it,
  // and only then is v3 an edit, which lands after it. Nothing was ever overwritten.
  expect(stage.fake.land()).toBe(1);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v2"]);
  await pass(stage.context(), gate, true);
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision, row.wanted_revision]).toEqual(["idle", 2, 3]);
  expect(row.evidence.edit_confirmed).toMatchObject({ by: "readback", revision: 2 });
  await pass(stage.context(), gate);
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision]).toEqual(["idle", 3]);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v3"]);
  expect(patches(stage)).toHaveLength(2);
  expect(isSettled((await readEffect(stage.as("hub_hub"), KEY))!)).toBe(true);
});

test("an old edit still on its way when the looks give up is settled by its own answer, pinned to its attempt, and by nothing else", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  await ask(stage, "v1");
  await pass(stage.context(), gate);
  await ask(stage, "v2");

  // Door A's request is slow: it has not reached Discord when the other door's looks run.
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  const doorA = stage.context({
    store: stage.fresh("hub_door"),
    platform: stage.platform(async (method) => { if (method === "PATCH") { arrived(); await slow; } }),
  });
  const running = runEffectWork(doorA, stage.gate(), await readEffectWork(doorA));
  await reached;
  const attempt = (await effectRow(stage, KEY)).edit_attempt_id as string;

  const other = stage.context({ store: stage.fresh("hub_door") });
  for (let look = 1; look <= 5; look += 1) {
    stage.fake.advance(31_000);
    await pass(other, gate);
  }
  let row = await effectRow(stage, KEY);
  expect([row.edit_state, row.edit_attempt_id, row.applied_revision]).toEqual(["unknown", attempt, 1]);

  // Its answer arrives: the attempt it belongs to is the one that settles, from unknown as from in flight.
  release();
  await running;
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision]).toEqual(["idle", 2]);
  expect(row.evidence.edit_confirmed).toMatchObject({ by: "response" });
  expect(patches(stage)).toHaveLength(1);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v2"]);
});

test("nothing releases an unknown edit but its own landing: there is no release to call, wanting the applied content again is not a shortcut, and a late real landing resolves it and lets the newest content follow", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  const row = await lostEdit(stage, gate);
  const attempt = row.edit_attempt_id as string;

  // A reason cannot make an old request dead, so no function takes one, for any role, and no module exports one.
  for (const role of ["hub_hub", "hub_runner", "hub_door", "hub_agent"] as const) {
    await expect(stage.as(role).sql`select hub_effect_release_edit(${KEY}, ${attempt}, 'the request died with the proxy that held it')`.execute())
      .rejects.toThrow(/does not exist|permission denied/);
  }
  expect(await import("../src/store/effects.ts")).not.toHaveProperty("releaseEffectEdit");

  // v2 is unknown, v1 is what the platform shows. The status line goes BACK to v1, which is easy for a status line:
  // its hash is the applied one, and it must not be taken for "already there" while v2 can still land over it.
  expect(await ask(stage, "v1")).toMatchObject({ revision: 4 });
  const sent = patches(stage).length;
  for (const startup of [false, true, false]) {
    stage.fake.advance(86_400_000);
    await pass(stage.context(), gate, startup);
  }
  let now = await effectRow(stage, KEY);
  expect([now.edit_state, now.edit_attempt_id, now.applied_revision, now.wanted_revision]).toEqual(["unknown", attempt, 1, 4]);
  expect(isSettled((await readEffect(stage.as("hub_hub"), KEY))!)).toBe(false);
  expect(patches(stage)).toHaveLength(sent);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v1"]);

  // The old request lands. The next start finds it, and only now is the wanted v1 a real edit: v2 is what the
  // message shows, so the hash that was applied before is not the one that is there.
  expect(stage.fake.land()).toBe(1);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v2"]);
  await pass(stage.context(), gate, true);
  now = await effectRow(stage, KEY);
  expect([now.edit_state, now.applied_revision, now.wanted_revision]).toEqual(["idle", 2, 4]);
  expect(now.evidence.edit_confirmed).toMatchObject({ by: "readback", revision: 2 });
  await pass(stage.context(), gate);
  now = await effectRow(stage, KEY);
  expect([now.edit_state, now.applied_revision]).toEqual(["idle", 4]);
  expect(patches(stage)).toHaveLength(sent + 1);
  expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v1"]);
  expect(isSettled((await readEffect(stage.as("hub_hub"), KEY))!)).toBe(true);
});

test("content that matches the attempt is evidence only against a known baseline that differs: without one, or with the same one, a look settles nothing", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  await lostEdit(stage, gate);
  // The baseline is not known (the applied hash is gone). v2 lands, and it is still not claimed applied.
  await stage.admin`update platform_effect set applied_hash = null where key = ${KEY}`;
  expect(stage.fake.land()).toBe(1);
  await pass(stage.context(), gate, true);
  let row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision, row.evidence.edit_rechecked.reason]).toEqual(["unknown", 1, "no-positive-evidence"]);

  // The baseline IS the attempt's content: what is shown is what was shown before, so a look proves no request landed.
  await stage.admin`update platform_effect set applied_hash = edit_hash where key = ${KEY}`;
  await pass(stage.context(), gate, true);
  row = await effectRow(stage, KEY);
  expect([row.edit_state, row.applied_revision]).toEqual(["unknown", 1]);
  expect(patches(stage)).toHaveLength(1);
});

test("through the door's task: an unknown edit found landed at start hands the newest content on by itself, and before it is found nothing is sent over it", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  await lostEdit(stage, gate);
  const start = () => startEffects({
    store: { ...stage.as("hub_door"), close: async () => {} } as never,
    platform: stage.platform(), door: DOOR, hooks: {}, registry: () => ({}), tickMs: 60_000,
    settings: () => ({ retrySeconds: 30, maxAttempts: 5 }),
    gate: read => read(),
  });

  // The old request has not landed: the start looks, finds v1, and sends nothing over it, however long it waits.
  let task = start();
  try {
    await task.ready;
    await until("the start looked again", async () => (await effectRow(stage, KEY)).evidence.edit_rechecked !== undefined, 10_000);
    await Bun.sleep(400);
    expect(patches(stage)).toHaveLength(1);
    expect((await effectRow(stage, KEY)).edit_state).toBe("unknown");
  } finally {
    await task.stop();
  }

  // It lands. The start that finds it settles it and then sends v3, with no ask, no wake and no second pass.
  expect(stage.fake.land()).toBe(1);
  task = start();
  try {
    await task.ready;
    await until("the newest content followed the settled edit", async () => (await effectRow(stage, KEY)).applied_revision === 3, 10_000,
      async () => JSON.stringify(await effectRow(stage, KEY)));
    const row = await effectRow(stage, KEY);
    expect([row.edit_state, row.wanted_revision]).toEqual(["idle", 3]);
    expect(patches(stage)).toHaveLength(2);
    expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["v3"]);
    expect(isSettled((await readEffect(stage.as("hub_hub"), KEY))!)).toBe(true);
  } finally {
    await task.stop();
  }
});

test("a platform that cannot be read back leaves an uncertain edit unknown at once, and its content is not claimed applied", async () => {
  const stage = await stageEffects(cluster);
  const fake = createFakePlatform({ name: "telegram" });
  const gate = stage.gate();
  const ctx = stage.context({ platform: fake.platform as never });
  await ask(stage, "plain", "k:plain");
  await pass(ctx, gate);
  await ask(stage, "plain, changed", "k:plain");
  const lost = { ...fake.platform, edit: async () => { throw Object.assign(new Error("connection reset"), { sent: true }); } };
  await pass(stage.context({ platform: lost as never }), gate);
  expect((await effectRow(stage, "k:plain")).edit_state).toBe("in_flight");
  stage.fake.advance(31_000);
  await pass(stage.context({ platform: lost as never }), gate);
  const row = await effectRow(stage, "k:plain");
  expect([row.edit_state, row.applied_revision, row.wanted_revision, row.evidence.edit_unknown.reason]).toEqual(["unknown", 1, 2, "no-readback"]);
});

test("two doors racing over the same effects make each message once, and a message id is saved once and for ever", async () => {
  const stage = await stageEffects(cluster);
  const keys = Array.from({ length: 6 }, (_, at) => `k:${at}`);
  for (const key of keys) await ask(stage, `message ${key}`, key);
  // Two processes: each on its own connection, each having read the same rows as owed.
  const one = stage.context({ store: stage.fresh("hub_door") });
  const two = stage.context({ store: stage.fresh("hub_door") });
  const [owedOne, owedTwo] = [await readEffectWork(one), await readEffectWork(two)];
  expect(owedOne.rows).toHaveLength(6);
  expect(owedTwo.rows).toHaveLength(6);
  await Promise.all([runEffectWork(one, stage.gate(), owedOne), runEffectWork(two, stage.gate(), owedTwo)]);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(6);
  expect(posts(stage)).toHaveLength(6);
  for (const key of keys) expect((await effectRow(stage, key)).state).toBe("confirmed");
  const row = await effectRow(stage, keys[0]);
  await expect(stage.admin`update platform_effect set platform_id = '1' where key = ${keys[0]}`.execute()).rejects.toThrow(/never replaced/);
  await expect(stage.admin`update platform_effect set applied_revision = 0 where key = ${keys[0]}`.execute()).rejects.toThrow(/moves forward/);
  expect((await effectRow(stage, keys[0])).platform_id).toBe(row.platform_id);
});

test("the wants are checked where they are made: identity, content and marker, and length are all refused, not merged or cut", async () => {
  const stage = await stageEffects(cluster);
  await ask(stage, "one");
  const runner = stage.as("hub_runner");
  await expect(wantEffect(runner, { key: KEY, door: "another-door", chat: stage.channel, owner: "council:c1", text: "one" })).rejects.toThrow(/effect-identity-conflict/);
  await expect(wantEffect(runner, { key: KEY, door: DOOR, chat: "other", owner: "council:c1", text: "one" })).rejects.toThrow(/effect-identity-conflict/);
  await expect(wantEffect(runner, { key: KEY, door: DOOR, chat: stage.channel, owner: "council:other", text: "one" })).rejects.toThrow(/effect-identity-conflict/);
  await expect(wantEffect(runner, { key: "k:empty", door: DOOR, chat: stage.channel, owner: "o", text: " \u0000 " })).rejects.toThrow(/no text/);
  const tooLong = "x".repeat(roomFor("k:long") + 1);
  await expect(wantEffect(runner, { key: "k:long", door: DOOR, chat: stage.channel, owner: "o", text: tooLong })).rejects.toBeInstanceOf(EffectTooLong);
  const exact = "x".repeat(roomFor("k:exact"));
  expect(renderEffect("k:exact", exact).content.length).toBe(2000);
  await wantEffect(runner, { key: "k:exact", door: DOOR, chat: stage.channel, owner: "o", text: exact });
  // The table's own checks, under a caller that skips the module.
  await expect(stage.admin`select hub_effect_want('k:x', ${DOOR}, ${stage.channel}, 'o', 'no marker here', 'hub:abc')`.execute()).rejects.toThrow();
  await expect(stage.admin`select hub_effect_want('k:x', ${DOOR}, ${stage.channel}, 'o', 'has hub:abc in it', 'hub:abc')`.execute()).resolves.toBeDefined();
  const [row] = await stage.admin`select nonce from platform_effect where key = 'k:x'`;
  expect(row.nonce).toMatch(/^h[0-9a-f]{24}$/);

  // Splitting and sanitizing hold what Discord will keep.
  expect(sanitizeText("  a\r\nb\u0000c\u0007 \uD800 \uDC00d  ")).toBe("a\nbc  d");
  expect(sanitizeText("pair 😀 kept")).toBe("pair 😀 kept");
  const pieces = splitText(`${"line one\n".repeat(30)}${"😀".repeat(60)}`, 50);
  expect(pieces.every(piece => piece.length <= 50)).toBe(true);
  expect(pieces.join("").replace(/\s/g, "")).toBe(`${"lineone".repeat(30)}${"😀".repeat(60)}`);
  expect(splitText("😀😀", 1).join("")).toBe("😀😀");
});

test("roles: the runner and the hub ask, the door sends, and nobody but the definer inserts; a model's role reads nothing", async () => {
  const stage = await stageEffects(cluster);
  for (const role of ["hub_runner", "hub_hub", "hub_door"] as const) {
    await wantEffect(stage.as(role), { key: `by:${role}`, door: DOOR, chat: stage.channel, owner: role, text: role });
  }
  const runner = stage.as("hub_runner").sql;
  const door = stage.as("hub_door").sql;
  const agent = stage.as("hub_agent").sql;
  await expect(runner`insert into platform_effect (key, door, chat, owner_ref, marker, nonce, wanted_content) values ('x', 'd', 'c', 'o', 'hub:m', 'n', 'hub:m')`.execute()).rejects.toThrow();
  await expect(door`insert into platform_effect (key, door, chat, owner_ref, marker, nonce, wanted_content) values ('x', 'd', 'c', 'o', 'hub:m', 'n', 'hub:m')`.execute()).rejects.toThrow();
  await expect(runner`update platform_effect set state = 'confirmed' where key = 'by:hub_runner'`.execute()).rejects.toThrow();
  await expect(door`update platform_effect set wanted_content = 'forged hub:m' where key = 'by:hub_runner'`.execute()).rejects.toThrow();
  await expect(door`update platform_effect set frozen = true where key = 'by:hub_runner'`.execute()).rejects.toThrow();
  await expect(door`update platform_effect set marker = 'hub:other' where key = 'by:hub_runner'`.execute()).rejects.toThrow();
  await expect(door`delete from platform_effect where key = 'by:hub_runner'`.execute()).rejects.toThrow();
  await expect(runner`delete from platform_effect where key = 'by:hub_runner'`.execute()).rejects.toThrow();
  await expect(agent`select * from platform_effect`.execute()).rejects.toThrow();
  await expect(agent`select hub_effect_want('y', 'd', 'c', 'o', 'hub:m', 'hub:m')`.execute()).rejects.toThrow();
  expect((await runner`select count(*)::int as n from platform_effect`)[0].n).toBe(3);
  expect((await door`select count(*)::int as n from platform_effect`)[0].n).toBe(3);
});

test("a platform with no readback still sends an effect, and an uncertain one is unknown at once rather than looked for or sent again", async () => {
  const stage = await stageEffects(cluster);
  const fake = createFakePlatform({ name: "telegram" });
  const gate = stage.gate();
  const ctx = stage.context({ platform: fake.platform as never });
  await ask(stage, "plain platform", "k:ok");
  await pass(ctx, gate);
  const ok = await effectRow(stage, "k:ok");
  expect([ok.state, ok.platform_id]).toEqual(["confirmed", "70001"]);
  expect(fake.posts()[0].text).toBe(ok.wanted_content);
  await ask(stage, "plain platform, changed", "k:ok");
  await pass(ctx, gate);
  expect(fake.edits().map(one => [one.id, one.text.split("\n")[0]])).toEqual([["70001", "plain platform, changed"]]);

  fake.holdPosts(true);
  await ask(stage, "uncertain", "k:lost");
  await pass(ctx, gate);
  expect((await effectRow(stage, "k:lost")).state).toBe("in_flight");
  stage.fake.advance(31_000);
  await pass(ctx, gate);
  const lost = await effectRow(stage, "k:lost");
  expect([lost.state, lost.evidence.unknown.reason]).toEqual(["unknown", "no-readback"]);
  fake.holdPosts(false);
  stage.fake.advance(86_400_000);
  await pass(ctx, gate);
  await pass(ctx, gate, true);
  expect(fake.attempts().filter(one => one.text.startsWith("uncertain"))).toHaveLength(1);
});

test("the door's task wakes on the store's notification, delivers and edits, leaves other doors' effects alone, and stops with the door", async () => {
  const stage = await stageEffects(cluster);
  const heard: string[] = [];
  let wake = () => {};
  const listener = await listenForWork({
    url: storeUrlAs(cluster.url(stage.db), "hub_door"),
    channel: "hub_project",
    onNotify: payload => { heard.push(payload); if (payload === `effect:${DOOR}`) wake(); },
  });
  const task = startEffects({
    store: { ...stage.as("hub_door"), close: async () => {} } as never,
    platform: stage.platform(), door: DOOR, hooks: {}, registry: () => ({}), tickMs: 1000,
    settings: () => ({ retrySeconds: 30, maxAttempts: 5 }),
    gate: read => read(),
  });
  wake = task.wake;
  try {
    await task.ready;
    expect(stage.fake.requests()).toHaveLength(0);

    await ask(stage, "woken");
    await until("the task delivered on the notification", async () => (await readEffect(stage.as("hub_hub"), KEY))?.state === "confirmed", 10_000);
    expect(heard).toContain(`effect:${DOOR}`);
    expect(stage.fake.messagesIn(stage.channel)).toHaveLength(1);

    await ask(stage, "woken again");
    await until("the task edited on the notification", async () => (await readEffect(stage.as("hub_hub"), KEY))?.applied_revision === 2, 10_000);
    expect(stage.fake.messagesIn(stage.channel).map(one => one.content.split("\n")[0])).toEqual(["woken again"]);

    // Another door's row is announced to it and not sent by this one.
    await wantEffect(stage.as("hub_runner"), { key: "k:other", door: "door-other", chat: stage.channel, owner: "o", text: "not mine" });
    await Bun.sleep(300);
    expect((await readEffect(stage.as("hub_hub"), "k:other"))?.state).toBe("not_sent");
    expect(posts(stage)).toHaveLength(1);
  } finally {
    await task.stop();
    await listener.close();
  }
  // Stopped: a new row waits for the next door.
  await ask(stage, "after stop", "k:after");
  await Bun.sleep(300);
  expect((await readEffect(stage.as("hub_hub"), "k:after"))?.state).toBe("not_sent");
});
