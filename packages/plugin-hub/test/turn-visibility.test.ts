// One status card per input: what the door shows while an ordinary turn runs.
//
// The owner of #car-purchase read "[door] done. Tool calls: 39, time: 1590 s",
// and then, underneath it, "[door] still waiting..." and "[door] the model is
// working...". The turn was not hung (it crawled for 26 minutes and answered
// 1.2 s after the last tool), but the chat contradicted itself and said nothing
// about what the loop had last been seen doing.
//
// The card is ONE platform message per input. A clock that runs out, a turn that
// starts and each tool call land on it as edits, and it ends as `finished` only
// when the row says an answer is recorded. Its text is pinned WHOLE where a
// person reads it, and the times are the only free numbers.
//
// THE CARD IS THE LEDGER'S. Its contents are asked for in the message-effect ledger
// (`store/effects.ts`), on disk before anything is sent, under one key per input, and
// the door's effects task sends, edits, looks for a message after a lost answer and
// backs off. So the chat shows the card's two lines with the ledger's marker line
// under them, a create whose outcome is not known is never made again, an edit whose
// outcome is not known holds every newer one back (the last included), and the last
// content stays on disk whether or not the platform ever takes it.
//
// Four groups here. The first is pure: the words, in both languages, for a platform
// with spoilers and one without, and the card as the ledger sends it. The second
// drives the real door and runner through one long wait, through a restart in
// Russian, through a runner that goes away mid-turn and a hold that moves the card
// at once. The third plants the failures the ledger exists for: a create that is
// refused, that is not known to have landed, or whose answer carries no id; a final
// edit that is refused, and one whose outcome is not known; a card an earlier build
// posted by hand. The last is the adapter's own reading of one wire event and the
// runner's trailing write of a burst of real events.
//
// The last group, at the end of the file, holds the corrections of the second review. Two
// of them are about what the door believes when the store lies to it: a request that
// committed while its confirmation was lost, and a chat that changed under a card. Three are
// about teardown: the runner's trailing write after a child dies, a reply that waited on a
// card while its door stopped, and a start that has no delivery task yet. Each plants the
// failure with a privilege, a lock or a held platform call, so no check depends on a race.

import { test, expect, afterAll } from "bun:test";
import { stageHub } from "./helpers/authorized-registry.ts";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { fakeClaudeCli, healthyResult } from "./helpers/fake-cli.ts";
import { CHAT, DOOR, RUNNER, PERSON, AGENT, chatLogLines, insertInbound, superStore } from "./helpers/hub-fixture.ts";
import { controlledAdapter, editAgent, retrySettings } from "./helpers/rollout-runner.ts";
import { scriptedReply } from "./helpers/scripted-adapter.ts";
import { claudeCode } from "../src/adapters/claude-code.ts";
import type { AdapterProgress } from "../src/adapters/types.ts";
import { humanDuration, statusCard, type StatusCard } from "../src/door/lines.ts";
import { runDoor } from "../src/door/run.ts";
import { runRunner } from "../src/runner/run.ts";
import { effectMarker, renderEffect } from "../src/store/effects.ts";

let cluster: Cluster | undefined;
afterAll(async () => {
  await cluster?.stop();
});

const SLOW = 120_000;

/**
 * The ledger sends a small visible marker line under every card, which is how a message is
 * found again after a lost answer. It is no part of the card: what a person reads is the two
 * lines above it, and these helpers separate the two.
 */
const MARKER = /\n`hub:[0-9a-f]{16}`$/;
const bare = (text: string): string => text.replace(MARKER, "");

/** The ledger key of one input's card: one per input, so nothing else can mean that message. */
const keyOf = (inboundId: string): string => `turn-card:${DOOR}:${inboundId}`;

/**
 * The ledger looks for a request that may still land after `door.delivery_retry_seconds`, which
 * is thirty. One second keeps a check short and changes nothing about what a look may conclude:
 * a platform with no readback concludes nothing, whatever the interval.
 */
async function quickLooks(registryFile: string): Promise<void> {
  await Bun.write(registryFile, `${await Bun.file(registryFile).text()}\n[door]\ndelivery_retry_seconds = 1\ndelivery_max_attempts = 3\n`);
}

/** The 26-minute turn of the evidence: 39 tool calls, the last one seen 9 minutes ago. */
const LONG: StatusCard = {
  state: "working", elapsed: 1590, quiet: 540, actions: 39, tool: "Bash", event: "action",
  why: null, hold: null, spoilers: true,
};

// ---------------------------------------------------------------------------
// The words.
// ---------------------------------------------------------------------------

test("durations are what a person says: under a minute, minutes, then hours, and never raw seconds past a minute", () => {
  expect(humanDuration("en", 0)).toBe("<1m");
  expect(humanDuration("en", 59)).toBe("<1m");
  expect(humanDuration("en", 60)).toBe("1m");
  expect(humanDuration("en", 720)).toBe("12m");
  expect(humanDuration("en", 3599)).toBe("59m");
  expect(humanDuration("en", 3900)).toBe("1h 05m");
  expect(humanDuration("ru", 30)).toBe("<1 мин");
  expect(humanDuration("ru", 720)).toBe("12 мин");
  expect(humanDuration("ru", 3900)).toBe("1 ч 05 мин");
  expect(humanDuration("en", 720)).not.toContain("720");
});

test("the card is at most two short lines: state, elapsed and the age of the last activity first, then the technical detail in a spoiler on Discord and plain on a platform without one, in both languages", () => {
  const discord = statusCard("en", LONG);
  expect(discord).toBe("[door] in progress · 26m · last activity 9m ago\n||last observed tool: Bash · tool calls: 39 · last event: tool start||");
  expect(discord.split("\n").length).toBeLessThanOrEqual(2);
  expect(discord).not.toContain("```");
  expect(discord.match(/\|\|/g)).toHaveLength(2);

  // A platform that does not render spoilers is never sent the markup.
  const plain = statusCard("en", { ...LONG, spoilers: false });
  expect(plain).toBe("[door] in progress · 26m · last activity 9m ago\nlast observed tool: Bash · tool calls: 39 · last event: tool start");
  expect(plain).not.toContain("||");

  const russian = statusCard("ru", LONG);
  expect(russian).toBe("[дверь] в работе · 26 мин · последняя активность 9 мин назад\n||последний замеченный инструмент: Bash · вызовов: 39 · последнее событие: запуск инструмента||");
  expect(russian).not.toContain("[door]");
  expect(statusCard("ru", { ...LONG, spoilers: false })).not.toContain("||");

  // Nothing seen is said as nothing seen, and not as work in progress.
  expect(statusCard("en", { ...LONG, quiet: null, actions: 0, tool: "", event: "" }))
    .toBe("[door] in progress · 26m · no activity observed yet");
  expect(statusCard("ru", { ...LONG, quiet: null, actions: 0, tool: "", event: "" }))
    .toBe("[дверь] в работе · 26 мин · активности пока не замечено");
});

test("a wait keeps its reason in the open, an elapsed wait is never called a failure, and text from outside cannot open a spoiler, add a line or name more than a tool", () => {
  const why = "the runner's memory budget of 3072 MB is used up: 2048 MB held, and this agent needs 2048 MB.";
  const waiting = statusCard("en", { ...LONG, state: "accepted", elapsed: 180, quiet: null, actions: 0, tool: "", event: "", why });
  expect(waiting).toBe(`[door] still waiting: the agent has not started answering · 3m · no activity observed yet\n${why}`);

  for (const state of ["queued", "accepted", "working"] as const) {
    for (const language of ["en", "ru"] as const) {
      expect(statusCard(language, { ...LONG, state, elapsed: 7200 })).not.toMatch(/fail|error|timed out|ошибк|сбой/i);
    }
  }

  const hostile = statusCard("en", { ...LONG, state: "queued", tool: "Bash||\n```x", why: "a||b\nsecond line" });
  expect(hostile.split("\n").length).toBeLessThanOrEqual(2);
  expect(hostile).not.toContain("```");
  expect(hostile).not.toContain("||");
  const named = statusCard("en", { ...LONG, tool: "Bash||\n```x /etc/passwd --token=abc" });
  expect(named.split("\n").length).toBe(2);
  expect(named).not.toContain("```");
  expect(named).not.toContain("/etc/passwd");
  expect(named.match(/\|\|/g)).toHaveLength(2);
});

test("held and ended cards never read as done: a held input names the decision that is the owner's, and only an answered row finishes", () => {
  const held = statusCard("en", { ...LONG, state: "held", hold: "interrupted", quiet: 600 });
  expect(held).toContain("interrupted, input held");
  expect(held).toContain("Nothing runs again until you decide");
  expect(held).not.toMatch(/finished|done/i);
  expect(statusCard("ru", { ...LONG, state: "held", hold: "interrupted" })).toContain("Ничего не запустится снова, пока вы не решите");
  expect(statusCard("en", { ...LONG, state: "held", hold: "ownership-unknown" })).toContain("it is not known whether the attempt is still running");

  expect(statusCard("en", { ...LONG, state: "finished" })).toBe("[door] finished · 26m · tool calls: 39");
  expect(statusCard("ru", { ...LONG, state: "finished" })).toBe("[дверь] завершено · 26 мин · вызовов инструментов: 39");
  const ended = statusCard("en", { ...LONG, state: "ended" });
  expect(ended).toContain("no longer active");
  expect(ended).toContain("the outcome is not confirmed here");
  expect(ended).not.toMatch(/finished|done/i);
});

test("the card as the ledger sends it is its two lines and one marker line, and the marker is the message's identity: one per input, the same whatever the card says, and naming nothing", () => {
  const key = keyOf("door-fake:1");
  const one = renderEffect(key, statusCard("en", LONG));
  const lines = one.content.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines.slice(0, 2).join("\n")).toBe(statusCard("en", LONG));
  expect(lines[2]).toBe(`\`${effectMarker(key)}\``);
  expect(lines[2]).toMatch(/^`hub:[0-9a-f]{16}`$/);
  expect(bare(one.content)).toBe(statusCard("en", LONG));

  // The same input keeps its marker whatever the card says, and another input has another.
  const later = renderEffect(key, statusCard("en", { ...LONG, elapsed: 3000 }));
  expect(later.marker).toBe(one.marker);
  expect(later.content).not.toBe(one.content);
  expect(renderEffect(keyOf("door-fake:2"), statusCard("en", LONG)).marker).not.toBe(one.marker);

  // A platform with no spoilers is sent the same shape with no markup, and the marker is still last.
  const plain = renderEffect(key, statusCard("en", { ...LONG, spoilers: false })).content;
  expect(plain).not.toContain("||");
  expect(plain.split("\n")).toHaveLength(3);
  expect(plain.split("\n")[2]).toBe(lines[2]);

  // Nothing of the door, the message or the agent is in it.
  expect(one.marker).not.toContain("door");
  expect(one.content).not.toContain("door-fake");
});

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

test("the claude adapter reports a tool's result as an event of its own and never carries the tool's output", async () => {
  const preset = { adapter: "claude-code", model: "synthetic-alias", provider: "synthetic-provider", effort: "medium", paid: "key" };
  const wire = [
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "SECRET-TOOL-OUTPUT" }] } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
    healthyResult("done"),
  ];
  const session = await claudeCode.start({ preset, sessionId: null, wrap: fakeClaudeCli(wire) });
  const seen: AdapterProgress[] = [];
  session.onProgress((event) => seen.push(event));
  try {
    const ended = new Promise((resolve) => session.onTurnEnd(resolve));
    await session.feed({ id: "visibility-1", text: "synthetic input" });
    await ended;
  } finally {
    await session.close();
  }
  expect(seen.map((event) => event.kind)).toEqual(["action", "action_result", "text"]);
  expect(seen[0].text).toBe("Bash");
  expect(seen[1].text).toBe("");
  expect(JSON.stringify(seen)).not.toContain("SECRET-TOOL-OUTPUT");
});

// ---------------------------------------------------------------------------
// The door and the runner.
// ---------------------------------------------------------------------------

const DURATION = "(?:<1m|\\d+m)";

test(
  "MSG-10 a long wait is ONE platform message from the first clock to the end: the clocks and the tool calls are edits of it, the last observed activity moves only when the loop reports something, and it finishes before the reply, in a spoiler on Discord",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, {
      hub: { tick_seconds: 1 },
      people: [{ id: PERSON, language: "en", acked_seconds: 1, started_seconds: 2, answered_seconds: 3, delivered_seconds: 60 }],
    });
    const platform = { ...it.fake.platform, spoilers: true };
    const chatPosts = () => it.fake.posts().filter((one) => one.chat === CHAT);
    const chatEdits = () => it.fake.edits().filter((one) => one.chat === CHAT);
    const question = "crawl the listings and keep going";
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform });
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: question });

      await until("the door posted its one card", () => chatPosts().length >= 1, 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
      const card = chatPosts()[0];
      expect(card.id).not.toBeNull();
      expect(card.text.startsWith("[door] ")).toBe(true);
      expect(card.text, "the ledger's marker is the last line of what was sent").toMatch(MARKER);
      await until("the loop started answering", async () => (await it.read.ledger({ stream: "inbound", kind: "started" })).length >= 1, 45_000);

      // Two tool starts more than a tick apart, then a result: each is an edit of
      // the same message, and the technical detail is inside a spoiler.
      it.scripted.sendProgress({ kind: "action", text: "Bash" });
      await Bun.sleep(1200);
      it.scripted.sendProgress({ kind: "action", text: "Read" });
      await until(
        "the card says the second tool call, in a spoiler",
        () => chatEdits().some((one) => one.text.includes("||last observed tool: Read · tool calls: 2 · last event: tool start||")),
        20_000,
        () => `edits=${JSON.stringify(chatEdits().map((one) => one.text))}`,
      );
      await Bun.sleep(1200);
      it.scripted.sendProgress({ kind: "action_result", text: "" });
      await until(
        "the card says a tool result was seen",
        () => chatEdits().some((one) => one.text.includes("tool calls: 2 · last event: tool result||")),
        20_000,
        () => `edits=${JSON.stringify(chatEdits().map((one) => one.text))}`,
      );

      // THE LONG WAIT. The answered clock (3 s) has run out for a turn that is
      // still open: its evidence is written as ever, and the chat got no message.
      await until(
        "the answered clock ran out and was recorded",
        async () => (await it.read.ledger({ stream: "clock" })).some((one) => one.detail.stamp === "answered"),
        20_000,
      );
      expect(chatPosts().length, "the clocks made no line of their own").toBe(1);
      const logged = chatLogLines(it.stateDir, PERSON, AGENT);
      expect(logged.some((line) => /^\[door\] still waiting: the turn has not ended\. \d+ s so far\.$/.test(line.text)), "the chat log keeps the clock's own sentence").toBe(true);
      expect(logged.some((line) => line.text.includes(" · ")), "no card text reaches the chat log").toBe(false);

      // WHEN THE LOOP LAST DID SOMETHING moves with its events and with nothing
      // else: two and a half silent seconds change neither the moment nor the event.
      const before = (await it.read.sheet("turn_progress"))[0].data;
      expect(before.activity).toBe("action_result");
      await Bun.sleep(2500);
      const silent = (await it.read.sheet("turn_progress"))[0].data;
      expect(silent.activity_at).toBe(before.activity_at);
      expect(silent.activity).toBe("action_result");
      it.scripted.sendProgress({ kind: "action", text: "Grep" });
      await until(
        "the moment moved with the event",
        async () => Date.parse(String((await it.read.sheet("turn_progress"))[0].data.activity_at)) > Date.parse(String(before.activity_at)),
        10_000,
      );

      // COMPLETION. The card finishes before the reply, and says an answer is
      // recorded and nothing about it having arrived.
      it.scripted.holdTurnEnd(false);
      await until("the reply was posted", () => chatPosts().some((one) => one.text === scriptedReply(question)), 45_000, () => `posts=${JSON.stringify(chatPosts())}`);
      const reply = chatPosts().find((one) => one.text === scriptedReply(question))!;
      const beforeReply = chatEdits().filter((one) => one.at <= reply.at);
      const last = beforeReply[beforeReply.length - 1];
      expect(new RegExp(`^\\[door\\] finished · ${DURATION} · tool calls: 3$`).test(bare(last.text)), last.text).toBe(true);
      for (const edit of chatEdits()) expect(edit.id).toBe(String(card.id));
      expect(chatPosts().length, "the card and the reply, and nothing else").toBe(2);
      for (const one of [...chatPosts(), ...chatEdits()]) {
        if (one.text === scriptedReply(question)) continue;
        expect(one.text).not.toMatch(/the model is working|Tool calls: \d+, time|\[door\] done|delivered/);
        // Two lines of card, and the ledger's marker under them.
        expect(bare(one.text).split("\n").length).toBeLessThanOrEqual(2);
        expect(one.text).toMatch(MARKER);
      }
      expect(await it.read.sheet("door_progress")).toEqual([]);
      expect(await it.read.sheet("turn_progress")).toEqual([]);

      // The card is the ledger's, one key per input, and what it holds is what was sent last.
      const [inbound] = await it.read.inbound();
      const [held] = await it.read.sql("select state, edit_state, applied_revision, wanted_revision, wanted_content, platform_id from platform_effect where key = $1", [keyOf(String(inbound.id))]);
      expect(String(held.platform_id)).toBe(String(card.id));
      expect(held.state).toBe("confirmed");
      expect(held.edit_state).toBe("idle");
      expect(Number(held.applied_revision)).toBe(Number(held.wanted_revision));
      expect(String(held.wanted_content)).toBe(last.text);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-10 a door started again mid-turn edits the card it already posted, in Russian and on a platform with no spoilers: one post for the whole turn, no spoiler markup anywhere, and it ends as finished",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, { language: "ru", hub: { tick_seconds: 1 } });
    const chatPosts = () => it.fake.posts().filter((one) => one.chat === CHAT);
    const chatEdits = () => it.fake.edits().filter((one) => one.chat === CHAT);
    const question = "продолжай искать";
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: question });
      await until("the door posted its card", () => chatPosts().length >= 1, 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
      const card = chatPosts()[0];
      expect(card.text.startsWith("[дверь] ")).toBe(true);
      expect(card.text).not.toContain("[door]");

      // The card's identity is the ledger's key, one per input, and the door's own sheet only says
      // its last content is still owed. The next door finds the same message by that key.
      const [inbound] = await it.read.inbound();
      const saved = await it.read.sheet("door_progress");
      expect(saved.length).toBe(1);
      expect(saved[0].data.key).toBe(keyOf(String(inbound.id)));
      expect(saved[0].data.post_id, "no message id is kept by hand any more").toBeUndefined();
      const [held] = await it.read.sql("select platform_id from platform_effect where key = $1", [keyOf(String(inbound.id))]);
      expect(String(held.platform_id)).toBe(String(card.id));

      await door.stop();
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      // Two tool starts more than a tick apart, so the second is certain to be written to the sheet.
      it.scripted.sendProgress({ kind: "action", text: "Bash" });
      await Bun.sleep(1200);
      it.scripted.sendProgress({ kind: "action", text: "Read" });
      await until(
        "the restarted door edited the card it inherited",
        () => chatEdits().some((one) => one.text.includes("Read")),
        30_000,
        () => `posts=${JSON.stringify(chatPosts().map((one) => one.text))} edits=${JSON.stringify(chatEdits().map((one) => [one.id, one.text]))}`,
      );
      expect(chatPosts().length, "one post for the whole turn").toBe(1);

      it.scripted.holdTurnEnd(false);
      await until("the reply was posted", () => chatPosts().some((one) => one.text === scriptedReply(question)), 45_000, () => `posts=${JSON.stringify(chatPosts())}`);
      await Bun.sleep(500);
      const reply = chatPosts().find((one) => one.text === scriptedReply(question))!;
      const beforeReply = chatEdits().filter((one) => one.at <= reply.at);
      expect(beforeReply[beforeReply.length - 1].text).toMatch(/^\[дверь\] завершено · /);
      for (const edit of chatEdits()) expect(edit.id).toBe(String(card.id));
      // The marker is the ledger's and ASCII in every language, under the Russian card too.
      for (const one of [...chatPosts(), ...chatEdits()]) {
        if (one.text !== scriptedReply(question)) expect(one.text).toMatch(MARKER);
      }
      for (const text of [...chatPosts(), ...chatEdits()].map((one) => one.text)) expect(text).not.toContain("||");
      expect(chatPosts().length).toBe(2);
      expect(await it.read.sheet("door_progress")).toEqual([]);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-10 a runner that goes away mid-turn is never shown as done: the card stays the one message, says the turn is held or that the runner is gone, is never edited to finished, and the row stays open",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, {
      hub: { tick_seconds: 1 },
      // The loop can say it has no process of its own, so the stopped turn is a terminal held attempt.
      adapter: { exitProof: true, capabilities: { stableSession: true, safeResume: true, delegationDisabled: true } },
      people: [{ id: PERSON, language: "en", acked_seconds: 1, started_seconds: 2, answered_seconds: 3, delivered_seconds: 60 }],
    });
    // The card is the post that carries the ledger's marker. The hold notice is a chat post of its own.
    const chatPosts = () => it.fake.posts().filter((one) => one.chat === CHAT);
    const cardPosts = () => chatPosts().filter((one) => MARKER.test(one.text));
    const chatEdits = () => it.fake.edits().filter((one) => one.chat === CHAT);
    const shown = () => [...cardPosts(), ...chatEdits()].map((one) => one.text);
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: "a question the loop is still working on" });
      await until("the door posted its card", () => cardPosts().length >= 1, 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
      const card = cardPosts()[0];

      await runner.stop();
      runner = null;
      await until(
        "the card says the turn is held, or that the runner is gone",
        () => shown().some((text) => /interrupted, input held|is down, or the machine that runs this agent is offline/.test(text)),
        30_000,
        () => `shown=${JSON.stringify(shown())}`,
      );
      // The row leaving nothing behind is not the row being answered: nothing
      // here says finished, no reply exists, the message is still ONE message
      // and its tracking row is still on the door's sheet.
      await Bun.sleep(1500);
      expect(shown().some((text) => /finished|завершено/.test(text))).toBe(false);
      expect(cardPosts().length).toBe(1);
      for (const edit of chatEdits()) expect(edit.id).toBe(String(card.id));
      const [row] = await it.read.inbound();
      expect(["acked", "started"]).toContain(String(row.state));
      expect((await it.read.sheet("door_progress")).length).toBe(1);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-10 a card moves to held when the hold is committed and not when a clock next reads it: with every clock ten minutes away, the card that said in progress says held once the attempt is cut short, on the same message, and the hold notice is posted beside it on its own",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, {
      hub: { tick_seconds: 1 },
      adapter: { exitProof: true, capabilities: { stableSession: true, safeResume: true, delegationDisabled: true } },
      // NO clock can run out inside this check, so a card that moves is moved by the hold itself.
      people: [{ id: PERSON, language: "en", acked_seconds: 600, started_seconds: 600, answered_seconds: 600, delivered_seconds: 600 }],
    });
    const chatPosts = () => it.fake.posts().filter((one) => one.chat === CHAT);
    const cardPosts = () => chatPosts().filter((one) => MARKER.test(one.text));
    const chatEdits = () => it.fake.edits().filter((one) => one.chat === CHAT);
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: "a question the loop is still working on" });
      await until("the door posted its card", () => cardPosts().length >= 1, 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
      const card = cardPosts()[0];
      expect(bare(card.text)).toMatch(/^\[door\] in progress · /);
      expect((await it.read.ledger({ stream: "clock" })).length, "no clock has spoken").toBe(0);

      await runner.stop();
      runner = null;
      await until(
        "the card says the input is held",
        () => chatEdits().some((one) => /^\[door\] interrupted, input held · /.test(one.text)),
        20_000,
        () => `posts=${JSON.stringify(chatPosts().map((one) => one.text))} edits=${JSON.stringify(chatEdits().map((one) => one.text))}`,
      );
      for (const edit of chatEdits()) expect(edit.id).toBe(String(card.id));
      // The notice that names the decision is a message of its own, independent of the card.
      await until(
        "the hold notice was posted on its own",
        () => chatPosts().some((one) => !MARKER.test(one.text) && /a piece of work was interrupted and its input is held/.test(one.text)),
        20_000,
        () => `posts=${JSON.stringify(chatPosts().map((one) => one.text))}`,
      );
      expect(cardPosts().length, "still one card").toBe(1);
      expect((await it.read.ledger({ stream: "clock" })).length, "and still no clock").toBe(0);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// The failures the ledger exists for.
// ---------------------------------------------------------------------------

/** The people every planted-failure check runs with: no clock runs out inside one. */
const QUIET = [{ id: PERSON, language: "en" as const, acked_seconds: 600, started_seconds: 600, answered_seconds: 600, delivered_seconds: 600 }];

/** How long a reply may wait for its card's last content: well inside the door's own five seconds. */
const PROMPT_MS = 4500;

type Sql = (query: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
const effectOf = async (sql: Sql, key: string) =>
  (await sql(
    "select state, edit_state, applied_revision, wanted_revision, wanted_content, failure, attempts, edit_attempts from platform_effect where key = $1",
    [key],
  ))[0];

/**
 * A create that goes wrong three ways. None of them is answered by posting again:
 * an HTTP 503 does not prove the message was never made, a definite refusal made
 * nothing and no retry can change that, and an answer with no message id is what a
 * crash between the platform accepting the post and the id being saved looks like.
 */
for (const mode of ["503", "403", "no-id"] as const) {
  test(
    `MSG-10 a card create that ends in ${mode === "no-id" ? "an answer with no message id" : mode === "503" ? "an HTTP 503" : "a definite refusal"} is asked for once and never posted again, its last content stays on disk, and the reply is delivered without waiting`,
    async () => {
      cluster ??= await startCluster();
      const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
      await quickLooks(it.registryFile);
      const cardCalls: string[] = [];
      const real = it.fake.platform;
      const platform = {
        ...real,
        async post(options: { chat: string; text: string }) {
          if (!MARKER.test(options.text)) return await real.post(options);
          cardCalls.push(options.text);
          if (mode === "503") throw Object.assign(new Error("Service Unavailable"), { status: 503 });
          if (mode === "403") throw Object.assign(new Error("Missing Access"), { status: 403 });
          // The message IS made, and the answer carries no id: the door cannot know that.
          await real.post(options);
          return { id: null };
        },
      };
      const sql: Sql = (query, values) => it.read.sql(query, values);
      const question = "a question whose card cannot be created cleanly";
      let door: { stop(): Promise<void> } | null = null;
      let runner: { stop(): Promise<void> } | null = null;
      try {
        door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform });
        runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
        it.scripted.holdTurnEnd(true);
        it.fake.deliver({ text: question });
        await until("the card was asked for on the platform", () => cardCalls.length >= 1, 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
        const [inbound] = await it.read.inbound();
        const key = keyOf(String(inbound.id));
        const settled = mode === "403" ? "failed" : "unknown";
        await until(`the ledger says the create is ${settled}`, async () => (await effectOf(sql, key))?.state === settled, 20_000,
          async () => JSON.stringify(await effectOf(sql, key)));

        // Ticks go by and the card is not asked for again, by the door or by the task.
        await Bun.sleep(2500);
        expect(cardCalls.length, "asked for exactly once").toBe(1);

        it.scripted.holdTurnEnd(false);
        const released = Date.now();
        await until("the reply was posted", () => it.fake.posts().some((one) => one.text === scriptedReply(question)), 45_000,
          () => `posts=${JSON.stringify(it.fake.posts().map((one) => one.text))}`);
        const reply = it.fake.posts().find((one) => one.text === scriptedReply(question))!;
        expect(reply.at - released, "the answer did not wait on a card that cannot be sent").toBeLessThan(PROMPT_MS);

        // The last content is on disk though nothing can deliver it, and the row that
        // promised it goes only after that. Nothing here claims the card is up to date.
        await until("the tracking row is gone", async () => (await it.read.sheet("door_progress")).length === 0, 15_000);
        const held = await effectOf(sql, key);
        expect(String(held.wanted_content)).toMatch(/^\[door\] finished · /);
        expect(held.state).toBe(settled);
        expect(Number(held.applied_revision)).toBe(0);
        await Bun.sleep(1500);
        expect(cardCalls.length, "still once").toBe(1);
        expect(it.fake.edits(), "no edit of a message the door has no id for").toEqual([]);
        expect(it.fake.posts().filter((one) => MARKER.test(one.text)).length).toBe(mode === "no-id" ? 1 : 0);
      } finally {
        if (runner) await runner.stop();
        if (door) await door.stop();
        await it.stop();
      }
    },
    SLOW,
  );
}

/**
 * The last content when its edit cannot go out. A refusal is definite: nothing landed,
 * and the content is still on disk as what the card should read. An edit whose outcome
 * is not known may still land, so it holds every newer one back, a final update
 * included, whatever the platform does afterwards.
 */
for (const mode of ["refused", "unknown"] as const) {
  test(
    mode === "refused"
      ? "MSG-10 a final edit the platform refuses leaves the last content on disk as owed: nothing claims it landed, no other message is made, and the reply does not wait"
      : "MSG-10 an edit whose outcome is not known holds every newer edit back, the final one included, on a platform that is well again: the newest content stays on disk, and the reply does not wait",
    async () => {
      cluster ??= await startCluster();
      const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
      await quickLooks(it.registryFile);
      const real = it.fake.platform;
      let failing = false;
      const editCalls: string[] = [];
      const platform = {
        ...real,
        async edit(options: { chat: string; id: string; text: string }) {
          editCalls.push(options.text);
          if (failing) {
            // A refusal names its status. A lost answer names nothing, and is not proof of anything.
            throw mode === "refused" ? Object.assign(new Error("Forbidden"), { status: 403 }) : new Error("the connection was lost");
          }
          return await real.edit(options);
        },
      };
      const sql: Sql = (query, values) => it.read.sql(query, values);
      const question = "a question whose card is edited after it is made";
      let door: { stop(): Promise<void> } | null = null;
      let runner: { stop(): Promise<void> } | null = null;
      try {
        door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform });
        runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
        it.scripted.holdTurnEnd(true);
        it.fake.deliver({ text: question });
        await until("the card was posted", () => it.fake.posts().some((one) => MARKER.test(one.text)), 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
        const card = it.fake.posts().find((one) => MARKER.test(one.text))!;
        const [inbound] = await it.read.inbound();
        const key = keyOf(String(inbound.id));
        await until("the card is delivered as it stands", async () => {
          const seen = await effectOf(sql, key);
          return seen?.state === "confirmed" && seen.edit_state === "idle" && Number(seen.applied_revision) === Number(seen.wanted_revision);
        }, 20_000, async () => JSON.stringify(await effectOf(sql, key)));

        failing = true;
        if (mode === "unknown") {
          // A tool call changes the card, so an edit goes out, and it is not known to have landed.
          it.scripted.sendProgress({ kind: "action", text: "Bash" });
          await until("the ledger holds that edit as one whose outcome is not known", async () => (await effectOf(sql, key))?.edit_state === "unknown", 20_000,
            async () => JSON.stringify(await effectOf(sql, key)));
          // The platform is well again, and still nothing newer is sent over the old request.
          failing = false;
          const sent = editCalls.length;
          it.scripted.sendProgress({ kind: "action", text: "Read" });
          await until("the newer content is on disk", async () => Number((await effectOf(sql, key))?.wanted_revision) >= 3, 20_000,
            async () => JSON.stringify(await effectOf(sql, key)));
          await Bun.sleep(1500);
          expect(editCalls.length, "no edit over one that may still land").toBe(sent);
        }

        it.scripted.holdTurnEnd(false);
        const released = Date.now();
        await until("the reply was posted", () => it.fake.posts().some((one) => one.text === scriptedReply(question)), 45_000,
          () => `posts=${JSON.stringify(it.fake.posts().map((one) => one.text))}`);
        const reply = it.fake.posts().find((one) => one.text === scriptedReply(question))!;
        expect(reply.at - released, "the answer did not wait on a status edit that cannot go out").toBeLessThan(PROMPT_MS);
        await until("the last content is on disk and the tracking row is gone", async () =>
          String((await effectOf(sql, key))?.wanted_content ?? "").startsWith("[door] finished · ")
          && (await it.read.sheet("door_progress")).length === 0, 20_000,
          async () => JSON.stringify(await effectOf(sql, key)));

        await Bun.sleep(1500);
        const held = await effectOf(sql, key);
        expect(Number(held.applied_revision), "the ledger does not say the card is up to date").toBeLessThan(Number(held.wanted_revision));
        if (mode === "refused") {
          expect(held.edit_state).toBe("idle");
          expect((held.failure as { permanent?: boolean; revision?: number }).permanent).toBe(true);
          expect(Number((held.failure as { revision?: number }).revision), "the refusal is against the final revision").toBe(Number(held.wanted_revision));
        } else {
          expect(held.edit_state).toBe("unknown");
        }
        // The one edit that was refused or lost is the last one there ever was.
        const attempts = editCalls.length;
        await Bun.sleep(1500);
        expect(editCalls.length, "nothing is retried on a tick").toBe(attempts);
        expect(it.fake.edits().some((edit) => /finished/.test(edit.text)), "no edit says finished").toBe(false);
        expect(it.fake.posts().filter((one) => MARKER.test(one.text)).length, "one message for the whole turn").toBe(1);
        for (const edit of it.fake.edits()) expect(edit.id).toBe(String(card.id));
      } finally {
        if (runner) await runner.stop();
        if (door) await door.stop();
        await it.stop();
      }
    },
    SLOW,
  );
}

// ---------------------------------------------------------------------------
// A card an earlier build posted by hand.
// ---------------------------------------------------------------------------

test(
  "MSG-10 a card an earlier build posted by hand is never posted over, edited or swept: its input gets no second message, its row stays as the only record of that message, and the clock's own evidence is written as ever",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, {
      hub: { tick_seconds: 1 },
      people: [{ id: PERSON, language: "en", acked_seconds: 1, started_seconds: 600, answered_seconds: 600, delivered_seconds: 600 }],
    });
    // An open input whose card the earlier build had posted, and the card of an input that is gone.
    await insertInbound(cluster, it.db, { id: "legacy-open", body: "a message whose card an earlier build posted" });
    const legacy = (post: string) => JSON.stringify({ post_id: post, chat: CHAT, agent: AGENT, started_at: new Date().toISOString() });
    await it.read.sql("insert into state_row (sheet, id, data) values ('door_progress', $1, $2::text::jsonb)", ["legacy-open", legacy("70001")]);
    await it.read.sql("insert into state_row (sheet, id, data) values ('door_progress', $1, $2::text::jsonb)", ["legacy-gone", legacy("70002")]);
    const start = () => runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
    let door: { stop(): Promise<void> } | null = null;
    const untouched = async () => {
      const rows = await it.read.sheet("door_progress");
      expect(rows.map((row) => row.id).sort()).toEqual(["legacy-gone", "legacy-open"]);
      expect(rows.find((row) => row.id === "legacy-open")!.data.post_id).toBe("70001");
      expect(rows.find((row) => row.id === "legacy-gone")!.data.post_id).toBe("70002");
      for (const row of rows) expect(row.data.key, "no ledger key was ever given to it").toBeUndefined();
    };
    try {
      door = await start();
      // The acked clock runs out for the open input: its evidence is written, and its card is nobody's to make.
      await until("the clock's own evidence was written", async () => (await it.read.ledger({ stream: "clock" })).some((one) => one.subject === "legacy-open"), 20_000);
      await Bun.sleep(2500);
      expect(it.fake.posts(), "no second message about the same input").toEqual([]);
      expect(it.fake.edits(), "and the old one is not edited").toEqual([]);
      expect((await it.read.sql("select count(*)::int as n from platform_effect"))[0].n, "nothing was asked of the ledger").toBe(0);
      expect(chatLogLines(it.stateDir, PERSON, AGENT).some((line) => /still waiting: the loop has not accepted this message/.test(line.text))).toBe(true);
      await untouched();

      // Another door finds the same rows and treats them the same way.
      await door.stop();
      door = await start();
      await Bun.sleep(2500);
      expect(it.fake.posts()).toEqual([]);
      expect(it.fake.edits()).toEqual([]);
      await untouched();
    } finally {
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// The runner's trailing write.
// ---------------------------------------------------------------------------

test(
  "MSG-10 a burst of real events followed by silence still leaves the last count and the moment of the last event on the sheet: written once by the trailing write, stamped with the event and never with the timer, with no heartbeat and none of the output",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
    const chatText = () => [...it.fake.posts(), ...it.fake.edits()].filter((one) => one.chat === CHAT).map((one) => one.text);
    /** The runner's progress row for the open turn, and the moment it was written, or null when there is none. */
    const sheet = async (): Promise<{ data: Record<string, unknown>; writtenAt: number } | null> => {
      const [row] = await it.read.sql("select data, updated_at from state_row where sheet = 'turn_progress'");
      return row === undefined ? null : { data: row.data as Record<string, unknown>, writtenAt: new Date(row.updated_at as Date).getTime() };
    };
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: "crawl the listings" });
      await until("the loop started answering", async () => (await it.read.ledger({ stream: "inbound", kind: "started" })).length >= 1, 45_000);
      await until("the sheet holds the turn", async () => (await sheet()) !== null, 15_000);

      // Twelve tool starts inside one tick, then the loop's own text, which is the last thing it does.
      const names = ["Glob", "Read", "Grep", "Read", "Bash", "Edit", "Read", "Grep", "Glob", "Read", "Bash", "Write"];
      for (const name of names) {
        it.scripted.sendProgress({ kind: "action", text: name });
        await Bun.sleep(25);
      }
      const before = Date.now();
      it.scripted.sendProgress({ kind: "text", text: "RAW-MODEL-OUTPUT-SECRET" });
      const after = Date.now();

      await until("the trailing write landed", async () => {
        const seen = await sheet();
        return seen !== null && Number(seen.data.actions) === names.length && seen.data.activity === "text";
      }, 10_000, async () => JSON.stringify(await sheet()));
      const row = (await sheet())!;
      expect(row.data.last_action).toBe("Write");
      const eventAt = Date.parse(String(row.data.activity_at));
      // The moment is the event's own. The write that carried it came later, and the timer's moment is nowhere on the sheet.
      expect(eventAt).toBeGreaterThanOrEqual(before - 50);
      expect(eventAt).toBeLessThanOrEqual(after + 50);
      expect(row.writtenAt - eventAt, "written after the event, stamped with the event").toBeGreaterThan(20);
      expect(JSON.stringify(row.data)).not.toContain("RAW-MODEL-OUTPUT-SECRET");

      // Silence writes nothing and moves nothing: no heartbeat.
      await Bun.sleep(2500);
      const quiet = (await sheet())!;
      expect(quiet.writtenAt).toBe(row.writtenAt);
      expect(quiet.data.activity_at).toBe(row.data.activity_at);
      expect(Number(quiet.data.actions)).toBe(names.length);

      // The door had it without a further event, and none of the output reached the chat.
      await until("the card says twelve tool calls", () => chatText().some((text) => text.includes("tool calls: 12")), 10_000, () => `chat=${JSON.stringify(chatText())}`);
      expect(chatText().some((text) => text.includes("RAW-MODEL-OUTPUT-SECRET"))).toBe(false);
    } finally {
      it.scripted.holdTurnEnd(false);
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// The corrections of the second review.
// ---------------------------------------------------------------------------

type Staged = Awaited<ReturnType<typeof stageHub>>;

/** The card's messages in one chat, in the order the platform got them. */
function cardsIn(it: Staged, chat: string) {
  const posts = () => it.fake.posts().filter((one) => one.chat === chat);
  const cards = () => posts().filter((one) => MARKER.test(one.text));
  const edits = () => it.fake.edits().filter((one) => one.chat === chat);
  const shown = () => [...cards(), ...edits()].sort((left, right) => left.at - right.at);
  return { posts, cards, edits, shown };
}

const answered = async (it: Staged): Promise<boolean> => ["answered", "delivered"].includes(String((await it.read.inbound())[0]?.state));

/**
 * AN EMPTY `wanted` IS WHAT THE DOOR HEARD, NOT WHAT THE LEDGER HOLDS. The first request of a
 * card commits in one statement and is read back in another. Here the door role may no longer
 * read the ledger, so the request commits (the function is the owner's) and its read-back fails,
 * as does every read after it, until the privilege is given back. The turn ends in between, so
 * no later paint could have repaired what the door believes.
 */
test(
  "MSG-10 a first request that committed while its confirmation was lost still gets its card finished: the tracking row survives a failed read of the ledger, the last content is asked for on the same card once it can be read, and no card ends unconfirmed",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
    const sql: Sql = (query, values) => it.read.sql(query, values);
    const chat = cardsIn(it, CHAT);
    const question = "a question whose first card request commits and is not confirmed";
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      await sql("revoke select on platform_effect from hub_door");
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: question });
      await until("the card's first request committed", async () => Number((await sql("select count(*)::int as n from platform_effect"))[0].n) === 1, 45_000,
        () => `posts=${JSON.stringify(it.fake.posts())}`);
      const [inbound] = await it.read.inbound();
      const key = keyOf(String(inbound.id));

      // Ticks go by with the turn open: each paint asks again, each read-back fails, and the ledger
      // still holds the first content with nothing created.
      await Bun.sleep(2500);
      const asked = await effectOf(sql, key);
      expect(asked.state).toBe("not_sent");
      expect(String(asked.wanted_content)).toMatch(/^\[door\] in progress · /);
      expect(chat.cards(), "the effects task cannot read the ledger either").toEqual([]);
      expect((await it.read.sheet("door_progress")).length, "the tracking row was written before the request").toBe(1);

      // The turn ends while the ledger still cannot be read. Finalization must ask it, fail, and keep
      // both the row and the work: the input having left the open set is not proof that nothing was asked.
      it.scripted.holdTurnEnd(false);
      await until("the answer is recorded", () => answered(it), 45_000);
      await Bun.sleep(2500);
      expect((await it.read.sheet("door_progress")).length, "a failed read of the ledger drops nothing").toBe(1);
      expect(String((await effectOf(sql, key)).wanted_content), "the last content is still owed").toMatch(/^\[door\] in progress · /);
      expect(chat.cards()).toEqual([]);

      // The ledger can be read again: the existing row continues through the ordinary request, and the
      // one card is made and finished.
      await sql("grant select on platform_effect to hub_door");
      await until("the tracking row goes once the last content is on disk", async () => (await it.read.sheet("door_progress")).length === 0, 30_000,
        async () => JSON.stringify(await effectOf(sql, key)));
      await until("the one card is delivered as it stands", async () => {
        const seen = await effectOf(sql, key);
        return seen?.state === "confirmed" && seen.edit_state === "idle" && Number(seen.applied_revision) === Number(seen.wanted_revision);
      }, 30_000, async () => JSON.stringify(await effectOf(sql, key)));
      expect(String((await effectOf(sql, key)).wanted_content)).toMatch(/^\[door\] finished · /);
      expect(chat.cards().length, "one message for the whole turn").toBe(1);
      const shown = chat.shown();
      expect(bare(shown[shown.length - 1].text)).toMatch(/^\[door\] finished · /);
      expect(shown.some((one) => /no longer active/.test(one.text)), "no card ended without its outcome").toBe(false);
      for (const edit of chat.edits()) expect(edit.id).toBe(String(chat.cards()[0].id));
      await until("the reply was posted", () => it.fake.posts().some((one) => one.text === scriptedReply(question)), 45_000);
    } finally {
      it.scripted.holdTurnEnd(false);
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-10 a first request that truly did not commit makes no card when its input ends: the ledger is asked, holds nothing, the tracking row goes, and no ended card is created",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
    const sql: Sql = (query, values) => it.read.sql(query, values);
    const chat = cardsIn(it, CHAT);
    const question = "a question whose first card request is refused outright";
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      // The door role may not ask for a message at all, so nothing commits, and the ledger can be read.
      await sql("revoke execute on function hub_effect_want(text, text, text, text, text, text) from hub_door");
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: question });
      await until("the tracking row was written", async () => (await it.read.sheet("door_progress")).length === 1, 45_000);
      await Bun.sleep(2500);
      expect(Number((await sql("select count(*)::int as n from platform_effect"))[0].n), "nothing was committed").toBe(0);
      expect(chat.cards()).toEqual([]);

      it.scripted.holdTurnEnd(false);
      const released = Date.now();
      await until("the reply was posted", () => it.fake.posts().some((one) => one.text === scriptedReply(question)), 45_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((one) => one.text))}`);
      const reply = it.fake.posts().find((one) => one.text === scriptedReply(question))!;
      expect(reply.at - released, "the answer did not wait on a card that was never made").toBeLessThan(PROMPT_MS);
      await until("the tracking row is gone", async () => (await it.read.sheet("door_progress")).length === 0, 15_000);
      await Bun.sleep(1500);
      expect(Number((await sql("select count(*)::int as n from platform_effect"))[0].n), "no message was asked for because the input ended").toBe(0);
      expect(it.fake.posts().map((one) => one.text), "the reply and nothing else").toEqual([scriptedReply(question)]);
      expect(it.fake.edits()).toEqual([]);
    } finally {
      it.scripted.holdTurnEnd(false);
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

/**
 * A card belongs to the chat it was posted in. The agent's own chat is an ordinary registry edit and
 * moves under an open input; the card must stay where it is, through a restart that inherits it,
 * while the next input follows the chat the agent is in now.
 */
const CHAT_B = "1000000002";

test(
  "MSG-10 a chat edit under an open card leaves the card in the chat it was made in, through a restart: every later edit and the last content stay under its own identity, and the next input's card is made in the new chat",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
    const sql: Sql = (query, values) => it.read.sql(query, values);
    const before = cardsIn(it, CHAT);
    const after = cardsIn(it, CHAT_B);
    const first = "a question asked where the agent used to be";
    const second = "a question asked where the agent is now";
    const start = () => runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      door = await start();
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: first });
      await until("the card was posted in the first chat", () => before.cards().length >= 1, 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
      const card = before.cards()[0];
      const [one] = await it.read.inbound();
      const keyOne = keyOf(String(one.id));

      // The agent moves to another chat while its input is open.
      editAgent(it.registryFile, AGENT, { chat: CHAT_B });
      await until("the door reads the new chat", () => it.fake.pulls().some((pull) => pull.chat === CHAT_B), 30_000);

      // The card's content changes: the request for it must still be the card's own.
      it.scripted.sendProgress({ kind: "action", text: "Bash" });
      await Bun.sleep(1200);
      it.scripted.sendProgress({ kind: "action", text: "Read" });
      await until("the card in the first chat says the second tool call", () => before.edits().some((edit) => edit.text.includes("Read")), 30_000,
        () => `edits=${JSON.stringify(it.fake.edits().map((edit) => [edit.chat, edit.text]))}`);
      expect(after.cards(), "no card was made in the new chat for the old input").toEqual([]);
      expect(after.edits()).toEqual([]);
      expect(String((await sql("select chat from platform_effect where key = $1", [keyOne]))[0].chat)).toBe(CHAT);
      expect(String((await it.read.sheet("door_progress"))[0].data.chat), "the tracking row keeps the card's chat").toBe(CHAT);

      // A door that starts under the new chat inherits the card in the old one.
      const pulls = it.fake.pulls().filter((pull) => pull.chat === CHAT_B).length;
      await door.stop();
      door = await start();
      it.scripted.sendProgress({ kind: "action", text: "Grep" });
      await Bun.sleep(1200);
      it.scripted.sendProgress({ kind: "action", text: "Write" });
      await until("the restarted door edited the card it inherited, in the chat it was made in", () => before.edits().some((edit) => edit.text.includes("Write")), 30_000,
        () => `edits=${JSON.stringify(it.fake.edits().map((edit) => [edit.chat, edit.text]))}`);
      expect(after.cards()).toEqual([]);
      expect(after.edits()).toEqual([]);

      // The input ends: the last content is asked for under the card's identity and is delivered there.
      it.scripted.holdTurnEnd(false);
      await until("the card finished in the chat it was made in", () => before.edits().some((edit) => /^\[door\] finished · /.test(bare(edit.text))), 30_000,
        () => `edits=${JSON.stringify(it.fake.edits().map((edit) => [edit.chat, edit.text]))}`);
      await until("the tracking row is gone", async () => (await it.read.sheet("door_progress")).length === 0, 15_000);
      await until("the first reply was posted", () => it.fake.posts().some((post) => post.text === scriptedReply(first)), 45_000);
      expect(before.cards().length, "one card for the first input").toBe(1);
      for (const edit of before.edits()) expect(edit.id).toBe(String(card.id));
      expect(String((await effectOf(sql, keyOne)).wanted_content)).toMatch(/^\[door\] finished · /);
      expect(after.cards(), "the old input never had a card in the new chat").toEqual([]);

      // The next input follows the chat the agent is in now.
      await until("the door is reading the new chat", () => it.fake.pulls().filter((pull) => pull.chat === CHAT_B).length > pulls, 30_000);
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: second, chat: CHAT_B });
      await until("the second input's card was posted in the new chat", () => after.cards().length >= 1, 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
      expect(before.cards().length, "and none more in the old one").toBe(1);
      const two = (await it.read.inbound()).find((row) => row.body === second)!;
      expect(String((await sql("select chat from platform_effect where key = $1", [keyOf(String(two.id))]))[0].chat)).toBe(CHAT_B);
      it.scripted.holdTurnEnd(false);
      await until("the second reply was posted in the new chat", () => after.posts().some((post) => post.text === scriptedReply(second)), 45_000);
    } finally {
      it.scripted.holdTurnEnd(false);
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

/**
 * The runner's error cleanup. The child dies with a burst of events unwritten, so a trailing write is
 * armed; the cleanup then waits on the queue of writes, which a lock on the sheet's table holds; the
 * timer's time passes and one more event arrives. None of it may write the turn's sheet row after the
 * cleanup clears it, the event still counts as evidence, and the input is held with nothing fed again.
 */
test(
  "MSG-10 a child that dies with a trailing write armed leaves no progress row behind: the timer and a callback buffered during the cleanup write nothing, the evidence still counts every event, and the input is held and never fed again",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
    retrySettings(it);
    const sql: Sql = (query, values) => it.read.sql(query, values);
    const edge = controlledAdapter(it.adapterName);
    edge.hold((message) => message.id === "burst-input");
    const barrier = await superStore(cluster, it.db);
    let runner: { stop(): Promise<void> } | null = null;
    let release: () => void = () => {};
    let holding: Promise<unknown> | null = null;
    /** Every write of a `turn_progress` row after `mark`, as the store saw it. */
    const writtenSince = async (mark: number): Promise<number> =>
      Number((await sql("select count(*)::int as n from progress_audit where n > $1", [mark]))[0].n);
    try {
      await sql("create table progress_audit (n serial primary key, actions int)");
      await sql(`create function progress_probe() returns trigger language plpgsql security definer as $$
        begin insert into public.progress_audit (actions) values ((new.data ->> 'actions')::int); return null; end $$`);
      await sql(`create trigger progress_probe_rules after insert or update on state_row
        for each row when (new.sheet = 'turn_progress') execute function progress_probe()`);
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } });
      await insertInbound(cluster, it.db, { id: "burst-input", body: "crawl until the child dies" });
      await until("the loop started answering", async () => (await it.read.ledger({ stream: "inbound", kind: "started" })).length >= 1, 45_000);
      await until("the sheet holds the turn", async () => (await it.read.sheet("turn_progress")).length === 1, 15_000);
      const target = edge.sessions.find((row) => row.fed.some((message) => message.id === "burst-input"))!;

      // The startup is not the burst. The scripted loop's first event is text: it is written at once (the
      // sheet's first row) and, arriving inside the same tick, arms a trailing write of its own. That
      // write is legitimate work of the startup, so it is let land BEFORE the baseline is taken and the
      // queue is held; what is counted afterwards is only the controlled burst. It is observed in the
      // store (the row's second write), not waited out.
      await until("the startup's own trailing write reached the sheet", async () =>
        Number((await sql("select count(*)::int as n from progress_audit"))[0].n) >= 2, 15_000);
      const mark = Number((await sql("select coalesce(max(n), 0)::int as n from progress_audit"))[0].n);

      // The lock that holds the queue: writes to the sheet's table wait until it is let go.
      let opened!: () => void;
      const gate = new Promise<void>((resolve) => { opened = resolve; });
      let locked!: () => void;
      const gotLock = new Promise<void>((resolve) => { locked = resolve; });
      release = () => opened();
      holding = barrier.sql.begin(async (tx) => {
        await tx`lock table state_row in share mode`;
        locked();
        await gate;
      });
      await gotLock;

      // Nothing is armed now: the startup's trailing write has fired and no event has come since. The
      // sleep is only margin past the tick since the sheet's last cadence write, so the first tool start
      // is written at once (and waits in the queue) and the second only counts and arms the trailing write.
      await Bun.sleep(1200);
      target.loop.sendProgress({ kind: "action", text: "Bash" });
      target.loop.sendProgress({ kind: "action", text: "Read" });
      target.fail();

      // The cleanup is waiting on the queue. The trailing write's time passes, and one more event is delivered.
      await Bun.sleep(1600);
      target.loop.sendProgress({ kind: "action", text: "Write" });
      await Bun.sleep(300);
      expect(await writtenSince(mark), "nothing reached the sheet while the queue was held").toBe(0);

      release();
      await holding;
      await until("the death is recorded and the retry set", async () =>
        (await it.read.sheet("agent_health")).some((row) => row.id === AGENT && typeof row.data.retry_at === "string"), 30_000);
      expect(await it.read.sheet("turn_progress"), "the cleanup cleared the row and nothing wrote it again").toEqual([]);
      expect(await writtenSince(mark), "only the write that was queued before the failure; neither the timer nor the buffered callback").toBe(1);

      // Past the retry deadline: still no row, and the held input is not fed again by anything.
      await Bun.sleep(2500);
      expect(await it.read.sheet("turn_progress")).toEqual([]);
      expect(await writtenSince(mark)).toBe(1);
      const [row] = (await it.read.inbound()).filter((one) => one.id === "burst-input");
      expect(row.claimed_by).toBeNull();
      const [hold] = await sql("select cause, state from replay_hold where inbound_id = 'burst-input'");
      expect(hold).toEqual({ cause: "interrupted", state: "held" });
      expect(edge.sessions.filter((one) => one !== target && one.fed.some((message) => message.id === "burst-input")), "no implicit continuation").toEqual([]);
      expect((await it.read.outbox()).some((one) => one.inbound_id === "burst-input")).toBe(false);
      // What the loop reported is still the attempt's evidence, the event delivered during the cleanup included.
      const [attempt] = await sql("select effects from execution where inbound_id = 'burst-input'");
      expect(attempt.effects).toEqual({ actions: 3, lastAction: "Write" });
    } finally {
      release();
      await holding?.catch(() => {});
      await barrier.close().catch(() => {});
      if (runner) await runner.stop();
      await edge.stop();
      await it.stop();
    }
  },
  SLOW,
);

/**
 * A reply waits, for a bounded time, for the last content of its card. The wait ends early when the
 * door stops, which says nothing about the card, and the reply then belongs to whoever serves next.
 */
test(
  "MSG-10 a reply that is waiting for its card's last content is left pending when the door stops: the leaving task sends nothing, the row stays undelivered, and the next door sends it once",
  async () => {
    cluster ??= await startCluster();
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
    const sql: Sql = (query, values) => it.read.sql(query, values);
    const real = it.fake.platform;
    // The card's create is held in flight, so its last content is never going to be delivered in time.
    let opened!: () => void;
    const gate = new Promise<void>((resolve) => { opened = resolve; });
    const platform = {
      ...real,
      async post(options: { chat: string; text: string }) {
        if (MARKER.test(options.text)) await gate;
        return await real.post(options);
      },
    };
    const question = "a question whose reply waits on its card";
    const isReply = (one: { text: string }) => one.text === scriptedReply(question);
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    let stopping: Promise<void> | null = null;
    try {
      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform });
      runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: question });
      await until("the card's create is in flight", async () => (await sql("select state from platform_effect"))[0]?.state === "in_flight", 45_000);
      const [inbound] = await it.read.inbound();
      it.scripted.holdTurnEnd(false);
      await until("the reply is waiting in the outbox", async () => (await it.read.outbox()).some((one) => one.inbound_id === String(inbound.id)), 45_000);
      // The last content is asked for and the tracking row gone: the reply is now inside its wait.
      await until("the last content is on disk", async () => (await it.read.sheet("door_progress")).length === 0, 30_000);
      await Bun.sleep(300);
      expect(it.fake.posts().some(isReply), "the reply is held for the card").toBe(false);

      stopping = door.stop();
      door = null;
      await Bun.sleep(1000);
      expect(it.fake.posts().some(isReply), "the leaving task did not send the reply").toBe(false);
      opened();
      await stopping;
      expect(it.fake.posts().some(isReply)).toBe(false);
      const [waiting] = (await it.read.outbox()).filter((one) => one.inbound_id === String(inbound.id));
      expect(waiting.delivered_at, "the row is left for the successor").toBeNull();

      door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform });
      await until("the next door sent the reply", () => it.fake.posts().some(isReply), 30_000);
      await Bun.sleep(1500);
      expect(it.fake.posts().filter(isReply).length, "sent once").toBe(1);
    } finally {
      opened();
      it.scripted.holdTurnEnd(false);
      await stopping?.catch(() => {});
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

/**
 * A door that starts after its input finished has the card and the queued reply, and no delivery task
 * yet: the first posting pass runs before the task does. Nothing could deliver the card then, so the
 * reply does not spend its wait on it; the task delivers the last content once it is running.
 */
for (const mode of ["lands", "unknown"] as const) {
  test(
    mode === "lands"
      ? "MSG-10 a door that starts after its turn finished sends the queued reply without spending the card wait, and the same card is finished once the delivery task runs"
      : "MSG-10 a door that starts after its turn finished sends the queued reply without spending the card wait, and a final edit whose outcome is not known stays on disk as the card's content",
    async () => {
      cluster ??= await startCluster();
      const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: QUIET });
      await quickLooks(it.registryFile);
      const sql: Sql = (query, values) => it.read.sql(query, values);
      const chat = cardsIn(it, CHAT);
      const real = it.fake.platform;
      let failing = false;
      const platform = {
        ...real,
        async edit(options: { chat: string; id: string; text: string }) {
          if (failing) throw new Error("the connection was lost");
          return await real.edit(options);
        },
      };
      const question = "a question that is answered while the door is down";
      const isReply = (one: { text: string }) => one.text === scriptedReply(question);
      let door: { stop(): Promise<void> } | null = null;
      let runner: { stop(): Promise<void> } | null = null;
      try {
        door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform });
        runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
        it.scripted.holdTurnEnd(true);
        it.fake.deliver({ text: question });
        await until("the card was posted", () => chat.cards().length >= 1, 45_000, () => `posts=${JSON.stringify(it.fake.posts())}`);
        const card = chat.cards()[0];
        const [inbound] = await it.read.inbound();
        const key = keyOf(String(inbound.id));
        await until("the card is delivered as it stands", async () => {
          const seen = await effectOf(sql, key);
          return seen?.state === "confirmed" && seen.edit_state === "idle" && Number(seen.applied_revision) === Number(seen.wanted_revision);
        }, 20_000, async () => JSON.stringify(await effectOf(sql, key)));

        // The door goes away with the turn open, and the loop finishes while nothing watches.
        await door.stop();
        door = null;
        failing = mode === "unknown";
        it.scripted.holdTurnEnd(false);
        await until("the answer is recorded while the door is down", () => answered(it), 45_000);
        await until("the reply is queued", async () => (await it.read.outbox()).some((one) => one.inbound_id === String(inbound.id)), 30_000);
        expect((await it.read.sheet("door_progress")).length, "the card is still owed its last content").toBe(1);

        const began = Date.now();
        door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform });
        expect(Date.now() - began, "the start did not spend the card wait on a task that was not running").toBeLessThan(PROMPT_MS);
        expect(it.fake.posts().some(isReply), "the queued reply went out in the first pass").toBe(true);

        await until("the card's last content is on disk and its tracking row is gone", async () =>
          String((await effectOf(sql, key))?.wanted_content ?? "").startsWith("[door] finished · ")
          && (await it.read.sheet("door_progress")).length === 0, 30_000, async () => JSON.stringify(await effectOf(sql, key)));
        if (mode === "lands") {
          await until("the same card was edited to finished", () => chat.edits().some((edit) => /^\[door\] finished · /.test(bare(edit.text))), 30_000,
            () => `edits=${JSON.stringify(chat.edits().map((edit) => edit.text))}`);
          await until("the ledger says it is delivered", async () => {
            const seen = await effectOf(sql, key);
            return seen?.state === "confirmed" && seen.edit_state === "idle" && Number(seen.applied_revision) === Number(seen.wanted_revision);
          }, 30_000, async () => JSON.stringify(await effectOf(sql, key)));
        } else {
          await until("the ledger holds that edit as one whose outcome is not known", async () => (await effectOf(sql, key))?.edit_state === "unknown", 30_000,
            async () => JSON.stringify(await effectOf(sql, key)));
          await Bun.sleep(1500);
          const held = await effectOf(sql, key);
          expect(String(held.wanted_content), "the intended content is still on disk").toMatch(/^\[door\] finished · /);
          expect(Number(held.applied_revision), "nothing says the card is up to date").toBeLessThan(Number(held.wanted_revision));
          expect(it.fake.edits().some((edit) => /finished/.test(edit.text)), "no edit says finished").toBe(false);
        }
        expect(chat.cards().length, "one card for the whole turn").toBe(1);
        for (const edit of chat.edits()) expect(edit.id).toBe(String(card.id));
        expect(it.fake.posts().filter(isReply).length, "the reply was sent once").toBe(1);
      } finally {
        it.scripted.holdTurnEnd(false);
        if (runner) await runner.stop();
        if (door) await door.stop();
        await it.stop();
      }
    },
    SLOW,
  );
}
