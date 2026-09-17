// REVIEW M3 and S3. Two things the door's fourth task does with a demand and
// with a minimum.
//
// M3: the pass opens by SPLICING the demand queue and everything that can throw
// comes after it, so a pass that fails loses the demand for good. A
// half-written registry is an ordinary moment (SPEC §6: "the installer, the web
// board and an editor edit the same file"), `loadRegistry` on one throws, the
// catch swallows it the way a pass should, and the person's typed phrase lives
// nowhere else. It is worst for the person whose `harvest_report` is off, whose
// demand line is the only line she would ever read.
//
// S3: D-145 pins the firing path as "recomputes the filtered count between
// `from` and `until`, writes the row in one transaction WHEN THE COUNT IS AT
// LEAST THE APPLICABLE MINIMUM". The build recomputed the count and never gated
// on it, so the minimum was only ever measured against the door's own stale
// bound. A door that has just come up has no bound at all, so it counts every
// line in the window, and on a per-token key that buys a paid model turn on a
// slice the minimum exists to refuse.
//
// THE GATE IS THE KEY PRESET'S OWN, AND THE PLAN CONTROL BESIDE IT SAYS SO.
// `test/door-harvest.test.ts`'s stage 4 pins the opposite behaviour for a PLAN
// harvester: a restarted door over one line against a minimum of three writes
// the row, and BUILD-NOTES 1 argues why. The two are reconcilable and the
// reason is D-110's: a plan preset carries the three window thresholds and
// phase 4's pause, notice and hold are what fence its cost, while "an agent on
// a per-token key has no window" at all, so the minimum is the ONLY cost fence
// a key harvester has. Both halves are asserted here, in one file, so the
// distinction is deliberate rather than discovered.
//
// Nothing here waits out a real quiet period and nothing waits for midnight:
// every line is planted with a chosen `at` in the past.

import { authorizeFixture } from "./helpers/authorized-registry.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { seam, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import {
  plantLine,
  stageHarvest,
  type ChatLine,
  type HarvestStage,
} from "./helpers/harvest-stage.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  chatLogLines,
} from "./helpers/hub-fixture.ts";
import { announceClock, clockGate, clockSuffix } from "./helpers/clock-gate.ts";

let cluster: Cluster;

const SLOW = 120_000;
const TICK_SECONDS = 2;

/** M3 plants five minutes back and runs a door over three broken ticks. */
const GATE_M3 = clockGate(12);
/** S3 plants five minutes back and runs two doors. */
const GATE_S3 = clockGate(12);
announceClock(GATE_M3, "review M3, a demand that survives a failed pass");
announceClock(GATE_S3, "review S3, the recomputed minimum on a key harvester");

/** A per-token key harvester. D-110: a key preset carries no window at all. */
const KEY_HARVESTER: Record<string, string> = {
  adapter: "a-loop",
  model: "a-cheaper-model-name",
  provider: "a-provider",
  effort: "low",
  paid: "key",
};

/** Every `harvest` row on the table right now, oldest first. */
async function harvestRows(stage: HarvestStage): Promise<Record<string, unknown>[]> {
  return (await stage.hub.read.sql(
    `select id, person, agent, kind, body, rank, state from inbound
      where kind = 'harvest' order by received_at, id`,
  )) as Record<string, unknown>[];
}

/**
 * A watermark for this chat, written the way the runner's settle writes one.
 *
 * Through `$2::jsonb` with a serialised string, which is how every check in
 * this phase plants one and which stores a jsonb SCALAR STRING rather than an
 * object (BUILD-NOTES 2). `readWatermark` unwraps both.
 */
async function plantWatermark(stage: HarvestStage, at: string): Promise<void> {
  await stage.hub.read.sql(
    `insert into state_row (sheet, id, data)
     values ('harvest', $1, $2::jsonb)
     on conflict (sheet, id) do update set data = excluded.data`,
    [
      `${PERSON}/${AGENT}`,
      JSON.stringify({
        at,
        row: `harvest:${AGENT}:${at}`,
        harvested_at: at,
        notes: 1,
        lines: 1,
      }),
    ],
  );
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

// ---------------------------------------------------------------------------
// M3.
// ---------------------------------------------------------------------------

test.skipIf(!GATE_M3.ok)(
  "REVIEW M3 a demand a failed pass could not act on is still there when the pass after it can: a half-written registry loses no phrase a person typed (SPEC §4 and §6, L19, D-146, D-147)" + clockSuffix(GATE_M3),
  async () => {
    const { runDoor } = await seam("src/door/run.ts");
    const { decodeHarvestBody } = await seam("src/harvest/row.ts");
    const bodyOf = decodeHarvestBody as (
      body: string,
    ) => { reason: string; said?: string; lines: number };

    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: TICK_SECONDS },
      // Ten hours and ninety-nine, so NOTHING BUT A DEMAND can fire and a row
      // that appears can only be the one the phrase asked for.
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
    });
    const it = stage.hub;
    authorizeFixture(it.registryFile);
    let door: { stop(): Promise<void> } | null = null;
    // NO RUNNER: this check is about the door alone, and a runner would settle
    // the row and change what is on the table while the check is reading it.
    try {
      const now = Date.now();
      const at = (minutesAgo: number) =>
        new Date(now - minutesAgo * 60_000).toISOString();
      plantLine(stage, { at: at(5), direction: "in", from: PERSON, text: "the dentist moved it" });
      plantLine(stage, { at: at(4), direction: "in", from: PERSON, text: "and the gym is cancelled" });

      const whole = readFileSync(it.registryFile, "utf8");
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });

      // --- HALF A FILE, which is what an editor's save looks like from the
      //     outside for a moment. `loadRegistry` throws on it, and the door's
      //     own pass catches the throw and goes on, which is right for a pass.
      writeFileSync(it.registryFile, whole.slice(0, Math.floor(whole.length / 2)), "utf8");
      // Long enough that a pass has certainly met the broken file, so the
      // demand below cannot be served by a registry read that happened before
      // it was broken.
      await Bun.sleep(TICK_SECONDS * 2 * 1000 + 500);

      it.fake.deliver({ chat: CHAT, text: "harvest this" });

      // --- 1. THE CHAT LOG HAS THE LINE whatever else happens, because the
      //     door appends it before anything can throw. MSG-12: the diary holds
      //     every message in both directions.
      await until(
        "the chat log holds the phrase the person typed",
        () =>
          chatLogLines(it.stateDir, PERSON, AGENT).some(
            (line) => line.direction === "in" && line.text === "harvest this",
          ),
        TICK_SECONDS * 6 * 1000,
        () => JSON.stringify(chatLogLines(it.stateDir, PERSON, AGENT)),
      );

      // --- 2. and NO harvest row while the file is broken, because nothing
      //     can read which preset harvests this person's chats.
      await Bun.sleep(TICK_SECONDS * 2 * 1000 + 500);
      expect(await harvestRows(stage)).toEqual([]);

      // --- 3. THE FILE IS WHOLE AGAIN AND THE DEMAND IS STILL OWED. Nothing
      //     is re-typed and nothing is re-delivered: the only thing that
      //     changed is that the pass can finish now.
      writeFileSync(it.registryFile, whole, "utf8");
      await until(
        "the demand that survived the broken pass produced its harvest row",
        async () => (await harvestRows(stage)).length === 1,
        TICK_SECONDS * 10 * 1000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} registry is whole again`,
      );
      const body = bodyOf(String((await harvestRows(stage))[0].body));
      expect(body.reason).toBe("demand");
      // --- 4. and it carries the person's own bytes, which is what makes L1's
      //     "every human message is on disk" true of a demand in the one table
      //     the hub queries.
      expect(body.said).toBe("harvest this");
      expect(body.lines).toBe(2);

      // --- 5. THE CONTROL: exactly one row, not one per pass that failed. A
      //     build that re-queued the demand and never cleared it would write a
      //     row every tick from here on.
      await Bun.sleep(TICK_SECONDS * 3 * 1000);
      expect((await harvestRows(stage)).length).toBe(1);
    } finally {
      if (door) await door.stop().catch(() => {});
      await stage.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// S3.
// ---------------------------------------------------------------------------

test.skipIf(!GATE_S3.ok)(
  "REVIEW S3 the minimum is applied to the slice the runner will really read and not only to the door's own stale count, on a harvester paid by a per-token key, and a plan harvester's row still lands because its window is what fences its cost (SPEC §4, L19, D-110, D-145)" + clockSuffix(GATE_S3),
  async () => {
    const { runDoor: door_ } = await seam("src/door/run.ts");
    const { decodeHarvestBody } = await seam("src/harvest/row.ts");
    const bodyOf = decodeHarvestBody as (body: string) => { lines: number; reason: string };

    /** Twenty-one lines five minutes back, strictly ordered, one a second. */
    const plantMany = (stage: HarvestStage, now: number): ChatLine[] => {
      const lines: ChatLine[] = [];
      for (let i = 0; i < 21; i++) {
        lines.push(
          plantLine(stage, {
            at: new Date(now - 5 * 60_000 + i * 1000).toISOString(),
            direction: "in",
            from: PERSON,
            text: `something said ${i}`,
          }),
        );
      }
      return lines;
    };

    // --- THE KEY HARVESTER. No `harvest_min_messages` on the entry, so the
    //     default is the one D-138 derives from the harvester preset's own
    //     `paid`: twenty on a key. Twenty-one lines are on disk and the
    //     watermark says twenty of them are already harvested, so the real
    //     slice is ONE line.
    const key = await stageHarvest(cluster, {
      hub: { tick_seconds: TICK_SECONDS },
      harvestPeople: [
        {
          id: PERSON,
          harvester: "harvest-key",
          harvest_quiet_minutes: 2,
        },
      ],
      extraPresets: { "harvest-key": KEY_HARVESTER },
    });
    let keyDoor: { stop(): Promise<void> } | null = null;
    let plan: HarvestStage | null = null;
    let planDoor: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const lines = plantMany(key, now);
      await plantWatermark(key, lines[19].at);

      keyDoor = await (door_ as Function)({
        door: DOOR,
        registryFile: key.hub.registryFile,
        platform: key.hub.fake.platform,
      });
      // The door's own bound is empty at connect, so the trigger sees every one
      // of the twenty-one lines and answers `quiet` against a minimum of
      // twenty. What the runner would really read is one line.
      await Bun.sleep(TICK_SECONDS * 4 * 1000 + 500);
      expect(await harvestRows(key)).toEqual([]);

      // --- AND IT DOES NOT POLL WHILE IT DECLINES. A door that re-read the
      //     watermark on every pass to decline again would issue a statement a
      //     tick per chat for ever, which is SPEC §1's "polling where a
      //     notification exists". Four more ticks, still nothing, and the
      //     window check 6 owns is what binds the statement count itself.
      await Bun.sleep(TICK_SECONDS * 2 * 1000);
      expect(await harvestRows(key)).toEqual([]);

      // --- THE CONTROL, and it is the pair that makes this a rule rather than
      //     a door that never writes: the SAME shape under a PLAN harvester
      //     with a minimum of three writes the row, with `lines: 1`, which is
      //     what `test/door-harvest.test.ts`'s stage 4 already pins. A plan
      //     preset carries the three window thresholds and phase 4's pause,
      //     notice and hold fence its cost; a key preset has no window at all,
      //     so the minimum is the only fence it has.
      plan = await stageHarvest(cluster, {
        hub: { tick_seconds: TICK_SECONDS },
        harvest: { quiet_minutes: 2, min_messages: 3 },
      });
      const planLines = plantMany(plan, now);
      await plantWatermark(plan, planLines[19].at);
      planDoor = await (door_ as Function)({
        door: DOOR,
        registryFile: plan.hub.registryFile,
        platform: plan.hub.fake.platform,
      });
      await until(
        "the plan harvester's row landed on its own stale count",
        async () => (await harvestRows(plan!)).length === 1,
        TICK_SECONDS * 8 * 1000,
        async () => JSON.stringify(await plan!.hub.read.inbound()),
      );
      const body = bodyOf(String((await harvestRows(plan))[0].body));
      expect(body.reason).toBe("quiet");
      expect(body.lines).toBe(1);
    } finally {
      if (planDoor) await planDoor.stop().catch(() => {});
      if (keyDoor) await keyDoor.stop().catch(() => {});
      if (plan) await plan.stop();
      await key.stop();
    }
  },
  SLOW,
);
