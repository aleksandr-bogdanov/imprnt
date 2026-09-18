// MSG-10. A door restarted mid-turn edits the progress line it already posted,
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

/** 04-CONTEXT's pinned templates, written out by the TEST and never imported. */
const WORKING = /^\[door\] working: /;
const TOTALS = /^\[door\] done\./;

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
