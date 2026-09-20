// Four failures, each one a person or a fact with nothing said about it,
// which is the class of defect this file exists to close.
//
// M1: a `hub.imprnt` naming a command that is not there ends the agent's
// serving loop for good. `Bun.spawn` throws synchronously on a command it
// cannot find (measured, bun 1.3.14), `applyNote` has no try around it, and the
// throw leaves `harvestTurn`, leaves the `while` the runner serves from, and
// lands in the outer catch that writes one diary line and falls through to the
// `finally`. The person's own messages stop being answered and nothing in a
// chat says so. THE DEFAULT CONFIGURATION REACHES IT: `hub.imprnt` is optional
// and falls back to the bare word `imprnt`, and the rendered unit files set no
// PATH at all.
//
// M2: a demand harvest whose recomputed slice is EMPTY settles and returns
// before the line back, so a person who typed the phrase reads silence. It is
// reachable in ordinary use, because `readSlice` drops every line that IS the
// phrase: type it, let it file, type it again with nothing said in between.
// The answer is pinned for exactly this case, because the silence is "the sin
// this project is named after".
//
// S2: the door's one read of open turns was narrowed to `kind = 'human'`, and
// SPEC §2 puts `report` at rank 0 for the same reason it puts `human` there:
// "rank 0 is anything a human is waiting on (a human's message, a report on a
// job that answers a human's message)". A report row was getting typing, a
// progress line and all three clock lines before the narrowing and none after it.
//
// S4: `classifyApply` answers `note: ""` when a marker line carries no path at
// the skip index, and an empty entry joined into the report line renders
// `[door] saved. Notes: .`, a sentence about nothing. The three forms exist so
// a person never reads one.
//
// THE LOOP IS SCRIPTED AND THE FILING IS REAL, the same split every harvest
// check is built on.

import { authorizeFixture } from "./helpers/authorized-registry.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { seam, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import {
  plantLine,
  stageHarvest,
  type ChatLine,
  type HarvestStage,
} from "./helpers/harvest-stage.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  insertInbound,
  scratchDir,
  superStore,
} from "./helpers/hub-fixture.ts";
import { announceClock, clockGate, clockSuffix } from "./helpers/clock-gate.ts";
import { readOpenTurns } from "../src/store/turns.ts";
import { scriptedReply } from "./helpers/scripted-adapter.ts";

let cluster: Cluster;

const SLOW = 120_000;
const TICK_SECONDS = 2;
const RETRY_SECONDS = 2;

/** M2 plants five minutes back and delivers two demands at a two second tick. */
const GATE_M2 = clockGate(10);
announceClock(GATE_M2, "review M2, a demand over an empty slice");

/** The pinned Russian nothing line, written out here and never imported. */
const RU_NOTHING = "[дверь] в этот раз сохранять нечего.";

const NOTE_FEE = `---
type: note
domain: finances
kind: reference
summary: The monthly card fee rises from nine to eleven in October.
tags: [banking, fees]
---

# Card fee rises in October

The bank said the monthly card fee goes from nine to eleven in October.`;

function envelope(...notes: string[]): string {
  return notes.map((one) => `=== NOTE ===\n${one}\n=== END ===`).join("\n\n");
}

async function plantHarvestRow(
  stage: HarvestStage,
  body: { from: string | null; until: string; reason: string; lines: number },
): Promise<string> {
  const id = `harvest:${AGENT}:${body.until}`;
  await insertInbound(cluster, stage.hub.db, {
    id,
    body: JSON.stringify(body),
    kind: "harvest",
  });
  return id;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

// ---------------------------------------------------------------------------
// M1.
// ---------------------------------------------------------------------------

test(
  "REVIEW M1 a hub.imprnt naming a command that is not there refuses the harvest row onto its retry with the command in the line, and the agent goes on answering the person's own messages (SPEC §4, L19, D-152, D-156)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");

    // A path under a scratch directory that this check never creates, so the
    // spawn cannot find it however the household's own PATH is set. The bare
    // word `imprnt` would be found on a developer's Mac and not on the box the
    // unit file starts, which is the configuration this is about, so the
    // fixture names something nothing anywhere can resolve.
    const missingDir = await scratchDir("hub-no-imprnt-");
    const nowhere = join(missingDir, "there-is-no-imprnt-here");
    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: TICK_SECONDS, outage_retry_seconds: RETRY_SECONDS },
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
      shim: nowhere,
    });
    const it = stage.hub;
    authorizeFixture(it.registryFile);
    let runner: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const at = (minutesAgo: number) =>
        new Date(now - minutesAgo * 60_000).toISOString();
      plantLine(stage, { at: at(30), direction: "in", from: PERSON, text: "the bank raised the card fee" });
      plantLine(stage, { at: at(29), direction: "in", from: PERSON, text: "from nine to eleven in October" });

      it.scripted.setAnswer(() => envelope(NOTE_FEE));
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      const rowId = await plantHarvestRow(stage, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: 2,
      });

      // --- 1. THE ROW IS REFUSED, with `refused.harvest` and not with the
      //     `refused.turn` the outer catch writes about the AGENT. The
      //     difference is the whole finding: one is a row coming back on its
      //     own retry, the other is an agent that has stopped serving.
      await until(
        "the missing command refused the harvest row",
        async () =>
          (await it.read.ledger({ stream: "refusal", subject: rowId })).length > 0,
        60_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} refusals=${JSON.stringify(
            await it.read.ledger({ stream: "refusal" }),
          )}`,
      );
      const refusals = await it.read.ledger({ stream: "refusal", subject: rowId });
      expect(refusals.length).toBe(1);
      expect(refusals[0].kind).toBe("refused.harvest");
      expect(refusals[0].actor).toBe("runner");
      // --- 2. AND THE LINE NAMES THE COMMAND, because a household reading its
      //     own diary has to be able to see which setting is wrong. The path
      //     this fixture named is in it.
      expect(String(refusals[0].detail.said)).toContain(nowhere);
      expect(refusals[0].detail.agent).toBe(AGENT);

      // --- 3. the row is back on its retry and the watermark never moved.
      const held = (await it.read.sql(
        "select id, state, claimed_by, retry_at from inbound where id = $1",
        [rowId],
      ))[0] as Record<string, unknown>;
      expect(held.claimed_by).toBeNull();
      expect(held.state).toBe("received");
      expect(held.retry_at).not.toBeNull();
      expect(await it.read.harvestSheet()).toEqual([]);

      // --- 4. THE CONTROL, AND IT IS THE WHOLE POINT: the agent is still
      //     serving. A human message planted after the refusal is answered
      //     through the agent's own session, into the outbox. Against a build
      //     whose throw escaped `harvestTurn` this never happens, because the
      //     `while` the runner serves from is over and the agent answers
      //     nothing again until the process restarts.
      it.scripted.setAnswer(null);
      await insertInbound(cluster, it.db, { id: "m-after", body: "an ordinary message" });
      await until(
        "the agent answered an ordinary message after the harvest failed",
        async () => (await it.read.outbox()).some((chunk) => chunk.inbound_id === "m-after"),
        60_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} refusals=${JSON.stringify(
            await it.read.ledger({ stream: "refusal" }),
          )}`,
      );
      const reply = (await it.read.outbox()).filter((chunk) => chunk.inbound_id === "m-after");
      expect(reply.length).toBe(1);
      expect(reply[0].body).toBe(scriptedReply("an ordinary message"));
      // And no `refused.turn` was written about the agent itself, which is what
      // the outer catch writes on its way out of the serving loop.
      expect(
        (await it.read.ledger({ stream: "refusal" })).filter(
          (one) => one.kind === "refused.turn",
        ),
      ).toEqual([]);
    } finally {
      if (runner) await runner.stop();
      await stage.stop();
      // The scratch directory the missing command was named under goes with the
      // check, so a suite run leaves none behind.
      await rm(missingDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// M2.
// ---------------------------------------------------------------------------

test.skipIf(!GATE_M2.ok)(
  "REVIEW M2 a demand harvest whose slice is empty still answers, in that person's own language, because a person who typed a phrase at the machinery and got silence cannot tell it worked from a hub that is broken (SPEC §4, L19, D-159)" + clockSuffix(GATE_M2),
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    const { runDoor } = await seam("src/door/run.ts");

    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: TICK_SECONDS, outage_retry_seconds: RETRY_SECONDS },
      // The person reads Russian, so the line that comes back is asserted in
      // her own language and not in the one this file is written in. The
      // harvester, the tree and the vault are filled in by the stage.
      // Ten hours and ninety-nine messages, so NOTHING BUT A DEMAND can fire.
      harvestPeople: [
        {
          id: PERSON,
          language: "ru",
          harvest_quiet_minutes: 600,
          harvest_min_messages: 99,
          harvest_report: true,
        },
      ],
    });
    const it = stage.hub;
    authorizeFixture(it.registryFile);
    let runner: { stop(): Promise<void> } | null = null;
    let door: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const at = (minutesAgo: number) =>
        new Date(now - minutesAgo * 60_000).toISOString();
      plantLine(stage, { at: at(5), direction: "in", from: PERSON, text: "банк поднял плату за карту" });
      plantLine(stage, { at: at(4), direction: "in", from: PERSON, text: "с девяти до одиннадцати в октябре" });

      it.scripted.setAnswer(() => envelope(NOTE_FEE));
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      // The first demand has a real slice: two lines nobody has harvested. It
      // files and moves the watermark past both of them.
      it.fake.deliver({ chat: CHAT, text: "сохрани важное" });
      await until(
        "the first demand filed and answered",
        async () => (await it.read.noticeRows()).length >= 1,
        90_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} notices=${JSON.stringify(
            await it.read.noticeRows(),
          )}`,
      );
      const first = (await it.read.noticeRows())[0];
      expect(first.body.startsWith("[дверь] сохранено. Заметки: ")).toBe(true);
      await until(
        "the first demand moved the watermark",
        async () => (await it.read.harvestSheet()).length === 1,
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      // --- THE SECOND DEMAND, with nothing said in between. Its slice is
      //     EMPTY BY CONSTRUCTION: the watermark is past both lines and the
      //     only lines since are the two demand phrases themselves, which
      //     `readSlice` drops because a message addressed to the machinery is
      //     not conversation.
      it.fake.deliver({ chat: CHAT, text: "сохрани важное" });
      await until(
        "the second demand answered too",
        async () => (await it.read.noticeRows()).length >= 2,
        90_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} turns=${JSON.stringify(
            await it.read.ledger({ stream: "turn" }),
          )} notices=${JSON.stringify(await it.read.noticeRows())}`,
      );
      const second = (await it.read.noticeRows())[1];
      // --- 1. THE PINNED LINE, WHOLE, in the person's own language.
      expect(second.body).toBe(RU_NOTHING);
      // --- 2. and it is about the SECOND row, keyed on that row's own id.
      expect(second.notice_key).not.toBe(first.notice_key);
      expect(String(second.notice_key).startsWith("harvest:")).toBe(true);
      // --- 3. the slice really was empty, said by the turn record rather than
      //     assumed: no model turn was bought for it.
      const rows = (await it.read.sql(
        "select id from inbound where kind = 'harvest' order by received_at, id",
      )) as { id: string }[];
      expect(rows.length).toBe(2);
      // The empty-slice branch answers the person first and settles the turn
      // after, in a transaction of its own, so the notice this test waited for
      // is not evidence that the turn record exists yet.
      await until(
        "the second demand's turn record settled",
        async () => (await it.read.ledger({ stream: "turn", subject: rows[1].id })).length > 0,
        60_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "turn" })),
      );
      const record = (await it.read.ledger({ stream: "turn", subject: rows[1].id }))[0];
      expect((record.detail.harvest as Record<string, unknown>).lines).toBe(0);
      expect(record.detail.input_tokens).toBeNull();
      // --- 4. and the door really posted it into the chat, which is where a
      //     person reads it.
      await until(
        "the door posted the second line into the chat",
        () => it.fake.posts().some((post) => post.text === RU_NOTHING),
        60_000,
        () => JSON.stringify(it.fake.posts()),
      );
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await stage.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// S2 and S4.
// ---------------------------------------------------------------------------

test(
  "REVIEW S2 the door's one read of open turns returns a REPORT row as well as a human one, because rank 0 is anything a human is waiting on, and S4 a note the CLI named no path for never renders a sentence about nothing (SPEC §2, D-143, D-159)",
  async () => {
    const { harvestReport } = await seam("src/door/lines.ts");
    const report = harvestReport as (
      language: string,
      what: { notes: string[]; conflicts: string[] },
    ) => string;

    // --- S4, PURE. An empty entry is dropped rather than joined, so
    //     `[door] saved. Notes: .` is unreachable. `classifyApply` answers
    //     `note: ""` whenever a marker line carries no token at its own skip
    //     index, and that is the one route back to a sentence about nothing.
    expect(report("en", { notes: ["finances/a", ""], conflicts: [] })).toBe(
      "[door] saved. Notes: finances/a.",
    );
    expect(report("ru", { notes: ["", "finances/a"], conflicts: [] })).toBe(
      "[дверь] сохранено. Заметки: finances/a.",
    );
    expect(report("en", { notes: ["finances/a"], conflicts: ["", "life/b"] })).toBe(
      "[door] saved. Notes: finances/a. Already there with different text, not overwritten: life/b.",
    );
    // And a report with nothing left in either list after that is a report
    // about nothing, so it says so rather than rendering an empty list.
    expect(report("en", { notes: [""], conflicts: [] })).toBe(
      "[door] nothing worth keeping this time.",
    );
    expect(report("ru", { notes: [], conflicts: [""] })).toBe(
      "[дверь] в этот раз сохранять нечего.",
    );

    // --- S2, against the cluster. A `report` row is a row a human IS waiting
    //     on: SPEC §2 puts it at rank 0 beside a human's own message, for that
    //     reason and in those words. Unnarrowed it gets typing, a progress
    //     line and all three clock lines from `attend`; the narrowing to
    //     `kind = 'human'` took all of them away, which is SPEC §2's Forbidden
    //     "an expired clock with no chat line and no finding".
    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: TICK_SECONDS },
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
    });
    const it = stage.hub;
    authorizeFixture(it.registryFile);
    let store: Awaited<ReturnType<typeof superStore>> | null = null;
    try {
      await insertInbound(cluster, it.db, { id: "m-human", body: "a human message" });
      await insertInbound(cluster, it.db, {
        id: "m-report",
        body: "the transcriber finished the file you asked about",
        kind: "report",
      });
      await insertInbound(cluster, it.db, {
        id: "harvest:p1-lair:2026-09-17T09:00:00.000Z",
        body: '{"from":null,"until":"2026-09-17T09:00:00.000Z","reason":"quiet","lines":3}',
        kind: "harvest",
      });
      await insertInbound(cluster, it.db, {
        id: "triage:p1-lair:1",
        body: "something a watcher saw",
        kind: "triage",
      });

      store = await superStore(cluster, it.db);
      const open = await readOpenTurns(store, { agent: AGENT });
      // Both rank 0 kinds, and neither rank 1 one.
      expect(open.map((row) => row.id).sort()).toEqual(["m-human", "m-report"]);
      expect(open.some((row) => row.id.startsWith("harvest:"))).toBe(false);
      expect(open.some((row) => row.id === "triage:p1-lair:1")).toBe(false);
      // The generated column is what says those two are the rank 0 pair, so the
      // filter and the schema cannot drift apart without this failing.
      const ranks = (await it.read.sql(
        "select id, kind, rank from inbound order by id",
      )) as { id: string; kind: string; rank: number }[];
      for (const row of ranks) {
        expect(Number(row.rank)).toBe(open.some((one) => one.id === row.id) ? 0 : 1);
      }
      // And an agent nobody planted a row for still comes back empty.
      expect(await readOpenTurns(store, { agent: AGENT2 })).toEqual([]);
    } finally {
      if (store) await store.close().catch(() => {});
      await stage.stop();
    }
  },
  SLOW,
);
