// HARV-02 and SPEC §2. Two checks about the two reads underneath a harvest.
//
// Check 3: the watermark is one row per chat on a state sheet the RUNNER may
// write. SPEC §4: "A watermark per chat log, advanced only after the filing
// landed." SPEC §7: a state sheet holds one row per id, edited in place. L17.
//
// Check 4: the door's one read of open turns returns a person's own message and
// never machinery. SPEC §2's Forbidden "an expired clock with no chat line and
// no finding", read the other way round: no clock line, no typing and no
// progress line is ever about a row nobody sent. L6, L19.
//
// CHECK 4 IS A CONTRACT RULE AND NOT A SPEC LINE, and that is answered here
// rather than argued later. The second seat is right that neither SPEC section
// 2's nor section 4's Check and Forbidden lines say "no clock about machinery"
// in so many words. The rule is D-143, which stands on L6 ("the door speaks
// about a person's own wait") and on a shipped precedent: `readStampRows` and
// `readStampMetrics` already select `kind = 'human'` for exactly this reason,
// and every consumer of `readOpenTurns` is about a person's own wait. D-143
// also names the defect it closes: with the shipped reader the door would post
// `[door] still waiting: the loop has not accepted this message. 45 s so far.`
// into a person's chat about a row nobody sent. 05-CONTEXT is a binding
// document in this project, so a contract entry with a ruling behind it and a
// precedent beside it is a rule this check may hold to.
//
// Both run against the throwaway cluster, and check 3 runs through the real
// `hub_runner` role because the grant is half of what it binds. D-115 gave the
// runner `insert, update, delete on state_row` in phase 4, so phase 5 adds no
// schema object at all and a build that reached for a new table fails.
//
// Red reasons: check 3 is import missing, `src/harvest/sheet.ts`. Check 4 is
// behaviour absent: `src/store/turns.ts`'s one statement is
// `where agent = $1 and state in ('received','acked','started')` with no filter
// on kind, so it returns all three planted rows.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import {
  AGENT,
  AGENT2,
  PERSON,
  PERSON2,
  insertInbound,
  stageHub,
  superStore,
} from "./helpers/hub-fixture.ts";
import { clockDeadlines } from "../src/door/clock.ts";
import { readOpenTurns } from "../src/store/turns.ts";

let cluster: Cluster;

const SLOW = 90_000;

/** The tests' own copy of the row a watermark is, never imported. */
interface Watermark {
  at: string;
  row: string;
  harvested_at: string;
  notes: number;
  lines: number;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

// ---------------------------------------------------------------------------
// Check 3.
// ---------------------------------------------------------------------------

test(
  "HARV-02 the watermark is one row per chat on a state sheet the runner's own role may write, carrying the last harvested LINE's time and never the writer's clock, and nothing harvested is no row at all (SPEC §4 and §7, L19, L17, D-141)",
  async () => {
    const { HARVEST_SHEET, watermarkId, watermarkRow, readWatermark } = await seam(
      "src/harvest/sheet.ts",
    );
    expect(typeof watermarkId).toBe("function");
    expect(typeof watermarkRow).toBe("function");
    expect(typeof readWatermark).toBe("function");

    const id = watermarkId as (person: string, agent: string) => string;
    const row = watermarkRow as (args: Record<string, unknown>) => {
      id: string;
      data: Record<string, unknown>;
    };
    const read = readWatermark as (
      store: unknown,
      where: { person: string; agent: string },
    ) => Promise<Watermark | null>;

    const it = await stageHub(cluster);
    const opened: { close(): Promise<void> }[] = [];
    try {
      // --- 1. the names and the id, computed by the TEST from the pinned
      //     shape. Two chats of one person are two ids, and one agent id under
      //     two people is two ids, so the sheet is per CHAT and not per person.
      expect(HARVEST_SHEET).toBe("harvest");
      expect(id(PERSON, AGENT)).toBe(`${PERSON}/${AGENT}`);
      expect(id(PERSON, AGENT2)).toBe(`${PERSON}/${AGENT2}`);
      expect(id(PERSON2, AGENT)).toBe(`${PERSON2}/${AGENT}`);
      expect(new Set([id(PERSON, AGENT), id(PERSON, AGENT2), id(PERSON2, AGENT)]).size).toBe(3);

      // --- 2. the row shape, PURE. `at` is the value handed in and NEVER
      //     `new Date()`. D-141 is why: `at` is the last harvested LINE's own
      //     time, and an `in` line's clock is the platform's while an `out`
      //     line's is the door's, so a line whose clock ran a second behind
      //     would otherwise be invisible for ever.
      const lastLine = "2026-09-16T20:59:58.000Z";
      const rowId = "harvest:p1-lair:2026-09-16T21:00:00.000Z";
      const made = row({
        person: PERSON,
        agent: AGENT,
        at: lastLine,
        row: rowId,
        harvestedAt: "2026-09-16T21:00:05.000Z",
        notes: 2,
        lines: 7,
      });
      expect(made.id).toBe(`${PERSON}/${AGENT}`);
      expect(Object.keys(made.data).sort()).toEqual([
        "at",
        "harvested_at",
        "lines",
        "notes",
        "row",
      ]);
      expect(made.data.at).toBe(lastLine);
      expect(made.data.row).toBe(rowId);
      expect(made.data.notes).toBe(2);
      expect(made.data.lines).toBe(7);
      // The writer's own clock is minutes away from the line's, so a build that
      // stamped `Date.now()` into `at` fails on this one number.
      expect(made.data.at).not.toBe(made.data.harvested_at);

      const { openStore, closeStore, storeUrlAs } = await seam("src/store/connect.ts");
      const { putRow, readSheet, removeRow } = await seam("src/records/statesheet.ts");
      const asRunner = (storeUrlAs as Function)(it.storeUrl, "hub_runner") as string;
      const runner = await (openStore as Function)({ url: asRunner });
      opened.push(runner as { close(): Promise<void> });

      // --- 5. NOTHING HARVESTED YET IS NO ROW, never a row saying zero. This
      //     goes before the write, because it is what "no row means nothing has
      //     been harvested" really asserts, and it is a different fact from a
      //     harvest that found nothing.
      expect(await read(runner, { person: PERSON, agent: AGENT })).toBeNull();
      expect(((await (readSheet as Function)(runner, "harvest")) as unknown[]).length).toBe(0);

      // --- 3. the grant, exercised through the real `hub_runner` role rather
      //     than through the superuser. D-115 granted it in phase 4, so this is
      //     the assertion that says the sheet needs no schema change at all.
      await (putRow as Function)(runner, HARVEST_SHEET, made.id, made.data);
      const back = await read(runner, { person: PERSON, agent: AGENT });
      expect(back).toEqual({
        at: lastLine,
        row: rowId,
        harvested_at: "2026-09-16T21:00:05.000Z",
        notes: 2,
        lines: 7,
      });

      // --- 4. ONE ROW PER ID (L17). A second put for the same chat EDITS that
      //     row rather than adding one.
      const later = row({
        person: PERSON,
        agent: AGENT,
        at: "2026-09-16T21:30:00.000Z",
        row: "harvest:p1-lair:2026-09-16T21:31:00.000Z",
        harvestedAt: "2026-09-16T21:31:05.000Z",
        notes: 1,
        lines: 3,
      });
      await (putRow as Function)(runner, HARVEST_SHEET, later.id, later.data);
      const sheet = (await (readSheet as Function)(runner, HARVEST_SHEET)) as {
        id: string;
        data: Watermark;
      }[];
      expect(sheet.length).toBe(1);
      expect(sheet[0].id).toBe(`${PERSON}/${AGENT}`);
      expect(sheet[0].data.at).toBe("2026-09-16T21:30:00.000Z");
      expect((await read(runner, { person: PERSON, agent: AGENT }))?.notes).toBe(1);

      // A second CHAT is a second row, which is the other half of "one row per
      // chat": the sheet grows by chat and never by harvest.
      const second = row({
        person: PERSON2,
        agent: AGENT2,
        at: "2026-09-16T21:40:00.000Z",
        row: "harvest:p2-lair:2026-09-16T21:41:00.000Z",
        harvestedAt: "2026-09-16T21:41:05.000Z",
        notes: 0,
        lines: 2,
      });
      await (putRow as Function)(runner, HARVEST_SHEET, second.id, second.data);
      expect(((await (readSheet as Function)(runner, HARVEST_SHEET)) as unknown[]).length).toBe(2);
      // And one chat's watermark is not another's, which is what a build
      // keyed on the person alone would fail.
      expect((await read(runner, { person: PERSON2, agent: AGENT2 }))?.lines).toBe(2);
      expect(await read(runner, { person: PERSON2, agent: AGENT })).toBeNull();

      // --- the control: the shipped `outage` sheet still behaves exactly as
      //     test/runner-outage.test.ts expects, through the same connection, so
      //     a build that changed `state_row` rather than adding a value to its
      //     `sheet` column fails here.
      await (putRow as Function)(runner, "outage", "a-credential", { cause: "login" });
      const outage = (await (readSheet as Function)(runner, "outage")) as {
        id: string;
        data: Record<string, unknown>;
      }[];
      expect(outage.length).toBe(1);
      expect(outage[0].data.cause).toBe("login");
      await (removeRow as Function)(runner, "outage", "a-credential");
      expect(((await (readSheet as Function)(runner, "outage")) as unknown[]).length).toBe(0);
      // And removing the outage row left the harvest rows alone.
      expect(((await (readSheet as Function)(runner, HARVEST_SHEET)) as unknown[]).length).toBe(2);
    } finally {
      for (const one of opened) await one.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 4.
// ---------------------------------------------------------------------------

test(
  "SPEC §2 the door's one read of open turns returns a person's own message and never machinery, so no clock line, no typing and no progress line is ever about a row nobody sent (L6, L19, D-143, D-155)",
  async () => {
    const it = await stageHub(cluster);
    let store: Awaited<ReturnType<typeof superStore>> | null = null;
    try {
      // Three rows for one agent, all at `received`: a person's own message,
      // the harvest row the door will write from phase 5 on, and the triage row
      // phase 6's watcher will write. All three are what the shipped statement
      // returns today.
      await insertInbound(cluster, it.db, { id: "m-human", body: "a human message" });
      await insertInbound(cluster, it.db, {
        id: "harvest:p1-lair:2026-09-16T21:00:00.000Z",
        body: '{"from":null,"until":"2026-09-16T21:00:00.000Z","reason":"quiet","lines":3}',
        kind: "harvest",
      });
      await insertInbound(cluster, it.db, {
        id: "triage:p1-lair:1",
        body: "something a watcher saw",
        kind: "triage",
      });

      store = await superStore(cluster, it.db);

      // --- 1. the HUMAN row and nothing else. This is the assertion that is
      //     red against the shipped statement, which has no `kind` filter.
      const open = await readOpenTurns(store, { agent: AGENT });
      expect(open.map((row) => row.id)).toEqual(["m-human"]);

      // --- 4. both other kinds, not only harvest. Phase 6's watcher triage is
      //     the other rank-1 kind and it arrives on this same table, so a
      //     filter written as `kind <> 'harvest'` passes assertion 1 and fails
      //     here.
      expect(open.some((row) => row.id === "triage:p1-lair:1")).toBe(false);
      expect(open.some((row) => row.id.startsWith("harvest:"))).toBe(false);

      // --- 2. the control, without which this is a check on a reader that
      //     returns nothing. D-126's shipped rule, unchanged: a row still opens
      //     at `acked` and leaves at `answered`.
      await it.read.sql(
        `insert into ledger_event (stream, subject, kind, actor)
         values ('inbound', 'm-human', 'acked', 'runner')`,
      );
      await it.read.sql(
        "update inbound set claimed_by = 'runner-test' where id = 'm-human'",
      );
      const acked = await readOpenTurns(store, { agent: AGENT });
      expect(acked.length).toBe(1);
      expect(acked[0].state).toBe("acked");
      expect(acked[0].claimed_by).toBe("runner-test");

      // --- 3. the consequence, asserted rather than argued. `clockDeadlines`
      //     is pure and correct and would arm a clock on ANY row it is handed,
      //     which is the point: the FILTER is what keeps it from ever being
      //     asked about machinery. A build that filtered inside `clockDeadlines`
      //     instead would leave typing and the progress line still firing on a
      //     harvest row, so the assertion is that the filter lives in the READ.
      const thresholds = {
        acked_seconds: 30,
        started_seconds: 60,
        answered_seconds: 900,
        delivered_seconds: 60,
      };
      const armed = acked.flatMap((row) => clockDeadlines(row, thresholds));
      expect(armed.length).toBe(1);
      expect(armed[0].stamp).toBe("started");
      const harvestRow = (await it.read.inbound()).find((row) =>
        row.id.startsWith("harvest:"),
      )!;
      expect(
        clockDeadlines(
          { state: "received", received_at: harvestRow.received_at },
          thresholds,
        ).length,
      ).toBe(1);

      // --- and the other half of the control: an `answered` row leaves the
      //     read, which is shipped behaviour and must stay exactly as it is.
      await it.read.sql(
        `insert into ledger_event (stream, subject, kind, actor)
         values ('inbound', 'm-human', 'answered', 'runner')`,
      );
      expect((await readOpenTurns(store, { agent: AGENT })).length).toBe(0);
    } finally {
      if (store) await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
