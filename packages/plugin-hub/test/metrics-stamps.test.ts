// The five metrics of L6's own table, derived from the five
// stamps, with p50, p99 and a count, per person and per agent, over today and
// over this week, and one command that prints the table.
//
// SPEC §2 and L6: "The board shows per person p50 and p99 of every metric over
// today, this week, and per agent." What ships here is the DATA plus the
// smallest honest display: a command that prints
// the table as text, and no web page, no HTTP server and no chart.
//
// EVERY PERCENTILE IS ASSERTED EXACTLY, against a value the test computes
// itself with `percentile_cont`'s own definition (linear interpolation over the
// ordered set). A metrics check that asserted "p99 is a number" cannot fail.
// The distribution is chosen so the mean and the maximum are both different
// answers, so a build that returned either fails.
//
// THE ROW SHAPE IS PINNED HERE, because the seam contract names `MetricsRow`
// and `Measure` without their fields: a scope, an id, a window and one
// `Measure` per metric id, each carrying `count`, `p50_ms` and `p99_ms`. A
// build that names them differently fails on the shape, which is this check's
// own pinning rather than a contract's.
//
// Red reason for both: import missing, `src/metrics/stamps.ts` for the first
// and `src/entry/metrics.ts` for the second.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startCluster, hubPath, seam, type Cluster } from "./helpers/cluster.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  insertInbound,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;
const RUNNER_PI = "runner-pi";
const AGENT_B = "p1-study";

interface Measure {
  count: number;
  p50_ms: number | null;
  p99_ms: number | null;
}

interface MetricsRow {
  scope: string;
  id: string;
  window: string;
  measures: Record<string, Measure>;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/**
 * `percentile_cont`'s own definition, computed by the TEST: linear
 * interpolation over the ordered set. An oracle that asked the code under test
 * would agree with every build.
 */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error("no values");
  const at = p * (sorted.length - 1);
  const below = Math.floor(at);
  const above = Math.ceil(at);
  if (below === above) return sorted[below];
  return sorted[below] + (at - below) * (sorted[above] - sorted[below]);
}

/** Noon UTC today, so every planted time stays inside the day it was meant for. */
function noonUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0),
  );
}

async function plantStamp(
  it: StagedHub,
  messageId: string,
  kind: string,
  at: Date,
): Promise<void> {
  const actor = kind === "received" || kind === "delivered" ? "door" : "runner";
  await it.read.sql(
    `insert into ledger_event (at, stream, subject, kind, actor)
     values ($1, 'inbound', $2, $3, $4)`,
    [at.toISOString(), messageId, kind, actor],
  );
}

/**
 * One whole message, with its four later stamps planted at chosen offsets from
 * the moment it was received. Every offset is in SECONDS.
 */
async function plantMessage(
  it: StagedHub,
  what: {
    id: string;
    person?: string;
    agent?: string;
    receivedAt: Date;
    acked: number;
    started: number;
    answered: number;
    delivered: number;
  },
): Promise<void> {
  await insertInbound(cluster, it.db, {
    id: what.id,
    body: `a message called ${what.id}`,
    person: what.person ?? PERSON,
    agent: what.agent ?? AGENT,
    receivedAt: what.receivedAt.toISOString(),
  });
  const after = (seconds: number) => new Date(what.receivedAt.getTime() + seconds * 1000);
  await plantStamp(it, what.id, "acked", after(what.acked));
  await plantStamp(it, what.id, "started", after(what.started));
  await plantStamp(it, what.id, "answered", after(what.answered));
  await plantStamp(it, what.id, "delivered", after(what.delivered));
}

function measure(rows: MetricsRow[], scope: string, id: string, window: string, metric: string): Measure {
  const row = rows.find(
    (one) => one.scope === scope && one.id === id && one.window === window,
  );
  if (!row) {
    throw new Error(
      `no ${window} row for the ${scope} ${id}. Rows: ${JSON.stringify(
        rows.map((one) => [one.scope, one.id, one.window]),
      )}`,
    );
  }
  const found = row.measures[metric];
  if (!found) {
    throw new Error(
      `the ${scope} ${id} has no ${metric}. Metrics: ${JSON.stringify(Object.keys(row.measures))}`,
    );
  }
  return found;
}

/** One staged household: one person with two agents, and a second person. */
async function stageMetrics(): Promise<StagedHub> {
  return await stageHub(cluster, {
    people: [
      { id: PERSON, language: "en" },
      { id: PERSON2, language: "en" },
    ],
    agents: [
      { id: AGENT_B, person: PERSON, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER_PI },
      { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}2`, door: DOOR, runner: RUNNER_PI },
    ],
    registry: (base) => ({
      ...base,
      agents: (base.agents ?? []).map((agent) =>
        agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
      ),
    }),
  });
}

test(
  "MSG-07 and MSG-09 the five metrics are derived from the five stamps with p50, p99 and a count, per person and per agent, over today and this week: the percentiles are exact, a measurement belongs to the window holding its later stamp, and a store with no stamps returns zeroes and nulls rather than throwing (SPEC §2, L6)",
  async () => {
    const { STAMP_METRICS, readStampMetrics, renderMetrics } = await seam(
      "src/metrics/stamps.ts",
    );
    expect(typeof readStampMetrics).toBe("function");
    expect(typeof renderMetrics).toBe("function");

    // --- 1. L6's table, whole, including which of them alert. A build that
    //     dropped one or renamed one fails here rather than in a board.
    expect(STAMP_METRICS).toEqual([
      { id: "time-to-ack", from: "received", to: "acked", alerts: true },
      { id: "time-to-start", from: "received", to: "started", alerts: true },
      { id: "ack-to-start", from: "acked", to: "started", alerts: true },
      { id: "answered-to-delivered", from: "answered", to: "delivered", alerts: true },
      { id: "time-to-delivered", from: "received", to: "delivered", alerts: false },
    ]);

    const it = await stageMetrics();
    try {
      const store = await superStore(cluster, it.db);
      const noon = noonUtc();
      const now = new Date(noon.getTime() + 60 * 60 * 1000);
      const at = (minutes: number) => new Date(noon.getTime() + minutes * 60 * 1000);

      // Nine gaps whose p50 and p99 are neither the mean nor the maximum.
      const ackGaps = [1, 2, 3, 4, 5, 6, 7, 8, 100];
      for (const [nth, gap] of ackGaps.entries()) {
        await plantMessage(it, {
          id: `m-a-${nth}`,
          agent: AGENT,
          receivedAt: at(-30 + nth),
          acked: gap,
          started: gap + 10,
          answered: gap + 20,
          delivered: gap + 30,
        });
      }
      // The SAME person's second agent, with a different distribution, so a
      // build that grouped by only one of the two scopes fails.
      const otherGaps = [50, 51, 52, 53, 54, 55, 56, 57, 500];
      for (const [nth, gap] of otherGaps.entries()) {
        await plantMessage(it, {
          id: `m-b-${nth}`,
          agent: AGENT_B,
          receivedAt: at(-20 + nth),
          acked: gap,
          started: gap + 10,
          answered: gap + 20,
          delivered: gap + 30,
        });
      }

      const rows = (await (readStampMetrics as Function)(store, { now })) as MetricsRow[];

      // --- 2 and 3. per person and per agent, with three different answers.
      const both = [...ackGaps, ...otherGaps].map((gap) => gap * 1000);
      expect(measure(rows, "agent", AGENT, "today", "time-to-ack")).toEqual({
        count: ackGaps.length,
        p50_ms: percentile(ackGaps.map((g) => g * 1000), 0.5),
        p99_ms: percentile(ackGaps.map((g) => g * 1000), 0.99),
      });
      expect(measure(rows, "agent", AGENT_B, "today", "time-to-ack")).toEqual({
        count: otherGaps.length,
        p50_ms: percentile(otherGaps.map((g) => g * 1000), 0.5),
        p99_ms: percentile(otherGaps.map((g) => g * 1000), 0.99),
      });
      // The person's row is the two agents' messages TOGETHER.
      expect(measure(rows, "person", PERSON, "today", "time-to-ack")).toEqual({
        count: both.length,
        p50_ms: percentile(both, 0.5),
        p99_ms: percentile(both, 0.99),
      });

      // Every metric is computed, and `ack-to-start` is not `time-to-start`
      // wearing another name: the two share a stamp and a build that computed
      // one twice passes a check that only looked at one.
      expect(measure(rows, "agent", AGENT, "today", "time-to-start").p50_ms).toBe(
        percentile(ackGaps.map((g) => (g + 10) * 1000), 0.5),
      );
      expect(measure(rows, "agent", AGENT, "today", "ack-to-start").p50_ms).toBe(10_000);
      expect(measure(rows, "agent", AGENT, "today", "answered-to-delivered").p50_ms).toBe(
        10_000,
      );
      expect(measure(rows, "agent", AGENT, "today", "time-to-delivered").p50_ms).toBe(
        percentile(ackGaps.map((g) => (g + 30) * 1000), 0.5),
      );

      // --- 4. today and this week. One settled two days ago is in the week
      //     and not in the day, and one settled eight days ago is in neither.
      await plantMessage(it, {
        id: "m-two-days",
        agent: AGENT2,
        person: PERSON2,
        receivedAt: new Date(noon.getTime() - 2 * 24 * 3600 * 1000),
        acked: 9,
        started: 19,
        answered: 29,
        delivered: 39,
      });
      await plantMessage(it, {
        id: "m-eight-days",
        agent: AGENT2,
        person: PERSON2,
        receivedAt: new Date(noon.getTime() - 8 * 24 * 3600 * 1000),
        acked: 11,
        started: 21,
        answered: 31,
        delivered: 41,
      });
      await plantMessage(it, {
        id: "m-an-hour",
        agent: AGENT2,
        person: PERSON2,
        receivedAt: at(-40),
        acked: 3,
        started: 13,
        answered: 23,
        delivered: 33,
      });
      const withOld = (await (readStampMetrics as Function)(store, { now })) as MetricsRow[];
      expect(measure(withOld, "agent", AGENT2, "today", "time-to-ack").count).toBe(1);
      expect(measure(withOld, "agent", AGENT2, "today", "time-to-ack").p50_ms).toBe(3000);
      // The week is the last SEVEN UTC days including today, so the two-day-old
      // one is in and the eight-day-old one is not.
      expect(measure(withOld, "agent", AGENT2, "week", "time-to-ack").count).toBe(2);
      expect(measure(withOld, "agent", AGENT2, "week", "time-to-ack").p50_ms).toBe(6000);

      // --- 5. THE ANCHOR. A message received at 23:50 yesterday and delivered
      //     at 00:10 today belongs to TODAY, because that is the moment the
      //     number became knowable. A build grouping on received_at puts it in
      //     yesterday and yesterday's numbers keep changing after the day is
      //     over.
      const midnight = new Date(
        Date.UTC(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate(), 0, 0, 0),
      );
      await plantMessage(it, {
        id: "m-midnight",
        agent: AGENT2,
        person: PERSON2,
        receivedAt: new Date(midnight.getTime() - 10 * 60 * 1000),
        acked: 60,
        started: 120,
        answered: 900,
        delivered: 1200,
      });
      const crossing = (await (readStampMetrics as Function)(store, { now })) as MetricsRow[];
      expect(measure(crossing, "agent", AGENT2, "today", "time-to-delivered").count).toBe(2);

      // --- 6. the count is there, and nothing measured is NULL rather than
      //     zero: zero milliseconds is a measurement and "nothing was
      //     measured" is not.
      await insertInbound(cluster, it.db, {
        id: "m-nothing",
        body: "a message with no stamps but its first",
        person: PERSON2,
        agent: AGENT2,
        receivedAt: at(-5).toISOString(),
      });
      const quiet = (await (readStampMetrics as Function)(store, { now })) as MetricsRow[];
      const empty = measure(quiet, "person", PERSON, "week", "answered-to-delivered");
      expect(typeof empty.count).toBe("number");

      // --- 7. no alerting of its own. The alert is `check`'s stamp finding,
      //     and a second path over the same numbers is two implementations of
      //     one verb.
      const sheetsBefore = await it.read.sheet("check");
      await (readStampMetrics as Function)(store, { now });
      expect(await it.read.sheet("check")).toEqual(sheetsBefore);
      expect(JSON.stringify(quiet)).not.toContain("finding");

      await store.close();
    } finally {
      await it.stop();
    }

    // --- THE CONTROL: a store with no stamps at all answers with zeroes and
    //     nulls and throws nothing. A silent day is not an error.
    const empty = await stageMetrics();
    try {
      const store = await superStore(cluster, empty.db);
      const rows = (await (readStampMetrics as Function)(store, {
        now: new Date(),
      })) as MetricsRow[];
      for (const row of rows) {
        for (const one of Object.values(row.measures)) {
          expect(one.count).toBe(0);
          expect(one.p50_ms).toBeNull();
          expect(one.p99_ms).toBeNull();
        }
      }
      await store.close();
    } finally {
      await empty.stop();
    }
  },
  SLOW,
);

test(
  "MSG-09 one command prints the whole table and that is the whole of the board this phase builds: every scope, window and metric appears with its own numbers, nothing measured prints as a marker rather than a zero, the entry reads its registry and nothing else, and nothing under src/metrics/ serves anything (SPEC §2, L6, RUN-07)",
  async () => {
    // The entry point is read as a FILE and never imported: importing an
    // entry runs it, and a check that ran one with its own argv would be
    // driving the thing it is about to drive as a process.
    const entry = hubPath("src/entry/metrics.ts");
    if (!existsSync(entry)) {
      throw new Error(`seam module missing: src/entry/metrics.ts (expected at ${entry})`);
    }
    const { readStampMetrics, renderMetrics } = await seam("src/metrics/stamps.ts");

    const it = await stageMetrics();
    try {
      const store = await superStore(cluster, it.db);
      const noon = noonUtc();
      const now = new Date(noon.getTime() + 60 * 60 * 1000);
      for (const [nth, gap] of [2, 4, 9].entries()) {
        await plantMessage(it, {
          id: `r-${nth}`,
          receivedAt: new Date(noon.getTime() - nth * 60 * 1000),
          acked: gap,
          started: gap + 10,
          answered: gap + 20,
          delivered: gap + 30,
        });
      }
      const rows = (await (readStampMetrics as Function)(store, { now })) as MetricsRow[];
      const text = String((renderMetrics as Function)(rows));

      // --- THE TABLE IS READ AS A TABLE (a
      //     substring search let a count hide inside a percentile's digits,
      //     and a row was selected without its window). Each line is split
      //     into CELLS on two or more spaces, a tab or a pipe, so a renderer
      //     may lay its columns out however it likes and still be read. What
      //     is pinned is that the line for a scope, an id and a window carries,
      //     for every metric, a cell holding that metric's p50, one holding
      //     its p99 and one holding its count.
      const cellsOf = (line: string): string[] =>
        line
          .split(/\s{2,}|\t|\|/)
          .map((cell) => cell.trim())
          .filter((cell) => cell !== "");
      // THE ID IS MATCHED AS A CELL, not as a substring. A
      // person's id is a PREFIX of their agents' (`p1` and `p1-lair`), so a
      // line naming the agent also contains the person's id and a substring
      // filter finds three lines for `p1` where the check needs one. No
      // renderer can answer that, whatever it prints: the fixture ids are
      // pinned and one really is inside the other. The cell split is the one
      // this check already declares as the way to read the table.
      const lineFor = (row: MetricsRow, metric: string): string[] => {
        const candidates = text
          .split("\n")
          .filter(
            (line) =>
              cellsOf(line).includes(row.id) &&
              line.includes(row.window) &&
              line.includes(metric),
          );
        if (candidates.length !== 1) {
          throw new Error(
            `the table has ${candidates.length} lines for the ${row.scope} ${row.id}, window ${row.window}, metric ${metric}, and a table a person reads has one:\n${text}`,
          );
        }
        return cellsOf(candidates[0]);
      };

      for (const row of rows) {
        expect(text).toContain(row.id);
        expect(text).toContain(row.window);
        for (const [metric, one] of Object.entries(row.measures)) {
          expect(text).toContain(metric);
          const cells = lineFor(row, metric);
          if (one.count === 0) {
            // NOTHING MEASURED PRINTS THE MARKER, never a zero, because a zero
            // in a table a human reads is a claim. The marker is
            // the literal `-`.
            expect(cells).toContain("-");
            expect(cells.includes("0")).toBe(false);
            continue;
          }
          const p50 = String(Math.round(one.p50_ms ?? 0));
          const p99 = String(Math.round(one.p99_ms ?? 0));
          expect(cells.some((cell) => cell === p50 || cell.startsWith(`${p50} `))).toBe(true);
          expect(cells.some((cell) => cell === p99 || cell.startsWith(`${p99} `))).toBe(true);
          // The COUNT is a cell of its own and equal to the count, so a
          // renderer that dropped it cannot pass on a digit that happens to
          // sit inside a percentile.
          expect(cells.some((cell) => cell === String(one.count))).toBe(true);
        }
      }

      // And a row with NOTHING measured at all is in the table too, with its
      // marker, rather than left out: a person looking for a person's numbers
      // has to be able to see that there are none.
      const silent = rows.find((row) =>
        Object.values(row.measures).every((one) => one.count === 0),
      );
      if (silent) {
        expect(lineFor(silent, Object.keys(silent.measures)[0])).toContain("-");
      }

      // --- the entry point, as a PROCESS, with the three assertions
      //     every entry carries.
      const run = async (argv: string[], env: Record<string, string> = {}) => {
        const proc = Bun.spawn([process.execPath, "run", entry, ...argv], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...env },
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code: await proc.exited, stdout, stderr };
      };

      const plain = await run([it.registryFile]);
      expect(plain.code).toBe(0);
      expect(plain.stderr).toBe("");
      expect(plain.stdout.length).toBeGreaterThan(0);
      // WHAT THE COMMAND PRINTS IS WHAT THE RENDERER RENDERS (the second
      // seat's finding: a separate command printing a constant passed every
      // assertion here). One implementation, and a richer board would be its
      // second front end rather than a second copy.
      expect(plain.stdout.trim()).toBe(text.trim());

      // No argument: a usage line naming the entry, and a non-zero exit.
      const bare = await run([]);
      expect(bare.code).not.toBe(0);
      expect(`${bare.stdout}${bare.stderr}`).toContain("metrics");

      // Nothing is read from the environment. A variable named after one of
      // the hub's own settings changes nothing.
      const withEnv = await run([it.registryFile], {
        HUB_TICK_SECONDS: "999",
        hub_tick_seconds: "999",
        HUB_STORE_URL: "postgres://127.0.0.1:1/nowhere",
      });
      expect(withEnv.stdout).toBe(plain.stdout);

      // And no argv value switches behaviour: an extra flag either changes
      // nothing or is refused with the usage line.
      const withFlag = await run([it.registryFile, "--today"]);
      if (withFlag.code === 0) {
        expect(withFlag.stdout).toBe(plain.stdout);
      } else {
        expect(`${withFlag.stdout}${withFlag.stderr}`).toContain("metrics");
      }

      // --- THE PHASE 7 BOUNDARY, asserted once, as a source-level scan the
      //     way `test/check-seam-only.test.ts` scans for a manager's name.
      //     This phase is the data plus a printer.
      const forbidden = [
        "Bun.serve",
        "createServer",
        "listen(",
        "<html",
        "<!DOCTYPE",
        "text/html",
      ];
      const metricsDir = hubPath("src/metrics");
      const sources = [entry];
      if (existsSync(metricsDir)) {
        for (const name of await readdir(metricsDir)) sources.push(join(metricsDir, name));
      }
      for (const file of sources) {
        const body = await readFile(file, "utf8");
        for (const one of forbidden) {
          expect(`${file}: ${body}`.includes(one)).toBe(false);
        }
      }

      await store.close();
    } finally {
      await it.stop();
    }
  },
  SLOW,
);
