// A door restarted mid-turn edits the progress line it already posted,
// and never posts a second one.
//
// SPEC §2 and L6: the progress line "is updated as it goes... ending with the
// totals". ONE platform message, overwritten, is the whole shape of it: a door
// that posts a second line leaves the first frozen in the chat at whatever
// second count it had, never edited to its totals, and the person reads two
// lines about one turn.
//
// The clock half of this already holds: `readSpokenClocks` restores what the
// door before it said, so a restarted door speaks once (test/door-clock.test.ts
// check 18). The progress half did not, because the platform's message id lived
// only in memory. This is the same restart, asked about the other line.
//
// The door is a PROCESS here, for the reason test/door-clock.test.ts gives: what
// is being asserted is that a restart drops nothing, and a handle in the check's
// own runtime cannot say that.
//
// Red reason: behaviour absent. `own.progress` is a map created per agent in
// `serve`, nothing writes the platform message id anywhere the next door could
// read it, and `lineDueAt` is satisfied again from the surviving
// `turn_progress` sheet, so the restarted door posts a second line.

import { stageHub } from "./helpers/authorized-registry.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  startReadySubprocess,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { AGENT, CHAT, DOOR, PERSON, RUNNER } from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;

/** The pinned templates, written out by the TEST and never imported. */
const WORKING = /^\[door\] in progress · /;
const TOTALS = /^\[door\] finished · /;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "MSG-10 a door restarted mid-turn edits the progress line it already posted and never posts a second: one post for the whole turn, every edit carries its id, and the totals land on it before the reply (SPEC §2, L6)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");

    const it = await stageHub(cluster, {
      servers: true,
      language: "en",
      hub: { tick_seconds: 1 },
    });
    let door: ReadyProcess | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    const startDoor = () =>
      startReadySubprocess("test/helpers/door-subprocess.ts", [
        it.registryFile,
        DOOR,
        it.platformUrl,
      ]);

    const progressPosts = () =>
      it.fake.posts().filter((one) => one.chat === CHAT && WORKING.test(one.text));

    try {
      door = await startDoor();
      runner = (await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      })) as { stop(): Promise<void> };

      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: "a question the loop is still working on" });
      await until(
        "the agent started answering",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "started" })).length >= 1,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await until(
        "the first door posted the progress line",
        () => progressPosts().length >= 1,
        30_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => p.text))}`,
      );
      const line = progressPosts()[0];
      expect(line.id).not.toBeNull();

      // --- the door goes down with the turn still open.
      await door.stop();
      door = null;
      door = await startDoor();

      // --- the work goes on, so the restarted door has something to say about
      //     the line it inherited.
      it.scripted.sendProgress({ kind: "action", text: "read" });
      await Bun.sleep(1200);
      it.scripted.sendProgress({ kind: "action", text: "grep" });
      await until(
        "the restarted door edited the line it inherited",
        () =>
          it.fake
            .edits()
            .filter((one) => one.chat === CHAT && WORKING.test(one.text)).length >= 1,
        30_000,
        () =>
          `posts=${JSON.stringify(it.fake.posts().map((p) => p.text))} ` +
          `edits=${JSON.stringify(it.fake.edits().map((e) => [e.id, e.text]))}`,
      );

      // --- 1. ONE post for the whole turn. A second "working" line leaves the
      //     first frozen in the chat and puts two lines about one turn in front
      //     of a person.
      expect(progressPosts().length).toBe(1);
      // --- 2. and every edit is an edit of THAT message.
      for (const edit of it.fake.edits().filter((one) => one.chat === CHAT)) {
        expect(edit.id).toBe(String(line.id));
      }

      // --- 3. the totals land on the same message, before the reply, which is
      //     what a restart must not cost either.
      it.scripted.holdTurnEnd(false);
      await until(
        "the reply was delivered",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "delivered" })).length >= 1,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await Bun.sleep(1000);
      const reply = it.fake
        .posts()
        .find((one) => one.chat === CHAT && one.text.includes("reply to"))!;
      expect(reply).toBeDefined();
      const totals = it.fake
        .edits()
        .filter((one) => one.chat === CHAT && TOTALS.test(one.text) && one.at <= reply.at);
      expect(totals.length).toBeGreaterThanOrEqual(1);
      expect(totals[totals.length - 1].id).toBe(String(line.id));
      expect(progressPosts().length).toBe(1);

      // --- 4. and the door's own sheet leaves no line behind once the turn is
      //     over (L17).
      expect(await it.read.sheet("door_progress")).toEqual([]);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// A turn that COMPLETES while no door is up.
//
// The door before it asked for the card's contents in the message-effect ledger
// and kept a tracking row that says the card's LAST content is still owed. The
// door that starts after the turn has ended finishes the card from the store's
// own answer, before the row goes. An earlier build swept such a row at connect
// and left the card saying "in progress" for good.
// ---------------------------------------------------------------------------

/** What is asked of the ledger for one input's card: the key is one per input. */
const keyOf = (inboundId: string) => `turn-card:${DOOR}:${inboundId}`;

/**
 * The ledger looks for a request that may still land after `door.delivery_retry_seconds`,
 * which is thirty. One second keeps the check short and changes nothing about what a look
 * may conclude: a platform with no readback concludes nothing, whatever the interval.
 */
async function quickLooks(registryFile: string): Promise<void> {
  await Bun.write(registryFile, `${await Bun.file(registryFile).text()}\n[door]\ndelivery_retry_seconds = 1\ndelivery_max_attempts = 3\n`);
}

async function completedOffline(failEdit: boolean): Promise<void> {
  const { runRunner } = await seam("src/runner/run.ts");
  const it = await stageHub(cluster, { servers: true, language: "en", hub: { tick_seconds: 1 } });
  await quickLooks(it.registryFile);
  let door: ReadyProcess | null = null;
  let runner: { stop(): Promise<void> } | null = null;
  const startDoor = () =>
    startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, DOOR, it.platformUrl]);
  const cardPosts = () => it.fake.posts().filter((one) => one.chat === CHAT && WORKING.test(one.text));
  const edits = () => it.fake.edits().filter((one) => one.chat === CHAT);
  const effectOf = async (key: string) =>
    (await it.read.sql(
      "select state, edit_state, applied_revision, wanted_revision, wanted_content, failure from platform_effect where key = $1",
      [key],
    ))[0];
  const question = "a question whose turn ends while the door is down";
  try {
    door = await startDoor();
    runner = (await (runRunner as Function)({
      runner: RUNNER,
      registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter },
    })) as { stop(): Promise<void> };
    it.scripted.holdTurnEnd(true);
    it.fake.deliver({ text: question });
    await until("the first door posted the card", () => cardPosts().length >= 1, 45_000,
      () => `posts=${JSON.stringify(it.fake.posts().map((p) => p.text))}`);
    const card = cardPosts()[0];
    const [row] = await it.read.inbound();
    const key = keyOf(String(row.id));
    // Nothing of the card is left in flight when the door goes: the ledger says the
    // message exists and shows what was last asked for.
    await until("the ledger holds the card as delivered", async () => {
      const seen = await effectOf(key);
      return seen?.state === "confirmed" && seen.edit_state === "idle" && Number(seen.applied_revision) === Number(seen.wanted_revision);
    }, 20_000, async () => JSON.stringify(await effectOf(key)));
    expect(String((await effectOf(key)).wanted_content).startsWith("[door] in progress · ")).toBe(true);
    await door.stop();
    door = null;

    // --- the turn ends with no door up. The row that promises a last content is still there.
    it.scripted.holdTurnEnd(false);
    await until("the turn was answered with no door", async () =>
      (await it.read.ledger({ stream: "inbound", kind: "answered" })).length >= 1, 45_000,
      async () => JSON.stringify(await it.read.inbound()));
    expect((await it.read.sheet("door_progress")).length, "the last content is still owed").toBe(1);
    const editsBefore = edits().length;
    if (failEdit) {
      // The platform refuses every edit from here on. Over the socket that is a lost answer,
      // which is not proof that the edit did not land.
      it.fake.platform.edit = async () => { throw new Error("the platform refused the edit"); };
    }

    // --- the door that starts now finishes the card from the store's own answer.
    door = await startDoor();
    await until("the last content is on disk in the ledger", async () => {
      const seen = await effectOf(key);
      return String(seen?.wanted_content ?? "").startsWith("[door] finished · ");
    }, 30_000, async () => JSON.stringify(await effectOf(key)));
    await until("the tracking row is gone only after that", async () => (await it.read.sheet("door_progress")).length === 0, 15_000);
    await until("the reply was delivered", async () =>
      (await it.read.ledger({ stream: "inbound", kind: "delivered" })).length >= 1, 45_000,
      async () => JSON.stringify(await it.read.inbound()));

    // ONE message for the whole turn, restart included, and no other kind of card.
    expect(cardPosts().length).toBe(1);
    if (!failEdit) {
      await until("the final edit landed on the same message", async () => {
        const now = await effectOf(key);
        return now?.state === "confirmed" && now.edit_state === "idle" && Number(now.applied_revision) === Number(now.wanted_revision);
      }, 20_000, async () => JSON.stringify(await effectOf(key)));
      const last = edits()[edits().length - 1];
      expect(last.text).toMatch(/^\[door\] finished · /);
      for (const edit of edits()) expect(edit.id).toBe(String(card.id));
    } else {
      // The final content is durable and is NOT claimed delivered: the ledger keeps the edit
      // as one whose outcome is unknown, so nothing newer is sent over it, and the card the
      // chat shows is exactly what it was. Nothing here turned a missing row into a success.
      await until("the edit is recorded as not known to have landed", async () => {
        const now = await effectOf(key);
        return now?.edit_state === "unknown" || (now?.failure as { permanent?: boolean } | null)?.permanent === true;
      }, 20_000, async () => JSON.stringify(await effectOf(key)));
      const now = await effectOf(key);
      expect(Number(now.applied_revision)).toBeLessThan(Number(now.wanted_revision));
      expect(String(now.wanted_content).startsWith("[door] finished · ")).toBe(true);
      expect(edits().length, "no edit went through").toBe(editsBefore);
      expect(edits().some((edit) => /finished/.test(edit.text))).toBe(false);
    }
    expect(await it.read.sheet("door_progress")).toEqual([]);
  } finally {
    if (runner) await runner.stop();
    if (door) await door.stop();
    await it.stop();
  }
}

test(
  "MSG-10 a turn that completed while no door was up is finished by the door that starts next: the same message is edited to finished, the tracking row goes only after the last content is on disk, and the reply is delivered",
  () => completedOffline(false),
  SLOW,
);

test(
  "MSG-10 a turn that completed while no door was up and whose final edit cannot be sent keeps that last content durable: the reply is still delivered, nothing claims the card was updated, and the tracking row does not stand in for a delivery",
  () => completedOffline(true),
  SLOW,
);
