// The transcribing interval is a SIXTH measure, beside the five, and the five
// are untouched. (SPEC §2, RUN-15)
//
// WHAT WAS READ FIRST AND WHAT IT DECIDED. `test/metrics-stamps.test.ts` was
// read whole before a line of this file was written, to answer one question:
// does it compare a whole `measures` object with `toEqual`, or assert the
// printed table's ROW COUNT? It does NEITHER. Every per-measure assertion there
// reads `measures[id]` by key, its only `toEqual` on a whole object is the
// five-entry constant itself, and it reads the printed table by finding the ONE
// line carrying a scope, an id, a window and a metric rather than by counting
// lines. A sixth key and a sixth row therefore cost that file nothing and it is
// left byte-unchanged.
//
// THE FIVE ARE ASSERTED HERE TOO, VALUE BY VALUE. A build that folded the sixth
// into `STAMP_METRICS` turns this file red before it turns the shipped one red,
// and the two files run separately, so either one alone says the constant did
// not move.
//
// THE INTERVAL IS THE DIARY STREAM'S OWN and never the column beside it. A row
// carrying `media_done_at` with no `media` entries contributes nothing, which
// is what stops this measure becoming a second copy of what the door recorded
// for the ack clock.
//
// EVERYTHING IS PLANTED AND NOTHING IS SLEPT FOR. `readStampMetrics` takes its
// own `now`, so every window below is arithmetic.
//
// Red reason: behaviour absent. `TRANSCRIBE_METRIC` is not exported and
// `readStampMetrics` answers five keys per row.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { hubPath, seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { MEDIA_KINDS, MEDIA_STREAM } from "../src/voice/records.ts";

const SLOW = 120_000;
const RUNNER_PI = "runner-pi";
/** The first person's second agent, which never speaks. */
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

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  await cluster?.stop();
});

/**
 * `percentile_cont`'s own definition, computed by the CHECK: linear
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

/** One person with two agents and a second person, the shipped metrics shape. */
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

/**
 * One message, planted whole through the superuser reader.
 *
 * The insert carries `media_done_at` rather than a second statement setting it:
 * the shipped trigger closes a row's transcription state once it has been shown
 * to somebody, so an update would be refused by that fence rather than by a
 * defect in what this file is about.
 */
async function plantMessage(
  it: StagedHub,
  what: {
    id: string;
    person: string;
    agent: string;
    receivedAt: Date;
    mediaDoneAt?: Date | null;
  },
): Promise<void> {
  const done = what.mediaDoneAt ?? null;
  await it.read.sql(
    `insert into inbound (id, person, agent, body, kind, received_at, media_state, media_done_at)
     values ($1, $2, $3, $4, 'human', $5::timestamptz, $6, $7::timestamptz)`,
    [
      what.id,
      what.person,
      what.agent,
      `a message called ${what.id}`,
      what.receivedAt.toISOString(),
      done === null ? null : "done",
      done === null ? null : done.toISOString(),
    ],
  );
  // The first stamp is the door's own and nothing writes it for a row planted
  // by hand, so it is planted here rather than left for the five to miss.
  await plantStamp(it, what.id, "received", what.receivedAt);
}

async function plantStamp(it: StagedHub, id: string, kind: string, at: Date): Promise<void> {
  const actor = kind === "received" || kind === "delivered" ? "door" : "runner";
  await it.read.sql(
    `insert into ledger_event (at, stream, subject, kind, actor)
     values ($1, 'inbound', $2, $3, $4)`,
    [at.toISOString(), id, kind, actor],
  );
}

/** The four later stamps, at chosen offsets in SECONDS from the moment named. */
async function plantFive(
  it: StagedHub,
  id: string,
  from: Date,
  offsets: { acked: number; started: number; answered: number; delivered: number },
): Promise<void> {
  const after = (seconds: number) => new Date(from.getTime() + seconds * 1000);
  await plantStamp(it, id, "acked", after(offsets.acked));
  await plantStamp(it, id, "started", after(offsets.started));
  await plantStamp(it, id, "answered", after(offsets.answered));
  await plantStamp(it, id, "delivered", after(offsets.delivered));
}

/** One line of the `media` diary stream, as the door writes it. */
async function plantMedia(
  it: StagedHub,
  id: string,
  kind: (typeof MEDIA_KINDS)[number],
  at: Date,
): Promise<void> {
  await it.read.sql(
    `insert into ledger_event (at, stream, subject, kind, actor)
     values ($1, $2, $3, $4, 'door')`,
    [at.toISOString(), MEDIA_STREAM, id, kind],
  );
}

/**
 * One voice note, whole: the row, its two diary lines, and the four later
 * stamps measured from the moment its words landed, which is what a real voice
 * row looks like.
 */
async function plantVoice(
  it: StagedHub,
  what: { id: string; person: string; agent: string; receivedAt: Date; seconds: number },
): Promise<void> {
  const startedAt = new Date(what.receivedAt.getTime() + 1000);
  const doneAt = new Date(startedAt.getTime() + what.seconds * 1000);
  await plantMessage(it, {
    id: what.id,
    person: what.person,
    agent: what.agent,
    receivedAt: what.receivedAt,
    mediaDoneAt: doneAt,
  });
  await plantMedia(it, what.id, "transcribe.started", startedAt);
  await plantMedia(it, what.id, "transcribe.done", doneAt);
  await plantFive(it, what.id, doneAt, { acked: 5, started: 15, answered: 25, delivered: 35 });
}

function measure(
  rows: MetricsRow[],
  scope: string,
  id: string,
  window: string,
  metric: string,
): Measure {
  const row = rows.find((one) => one.scope === scope && one.id === id && one.window === window);
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
      `the ${scope} ${id} has no ${metric}. Measures: ${JSON.stringify(Object.keys(row.measures))}`,
    );
  }
  return found;
}

/** The measure with no data: nulls and a zero, never a zero measurement. */
const NOTHING: Measure = { p50_ms: null, p99_ms: null, count: 0 };

const FIVE = [
  { id: "time-to-ack", from: "received", to: "acked", alerts: true },
  { id: "time-to-start", from: "received", to: "started", alerts: true },
  { id: "ack-to-start", from: "acked", to: "started", alerts: true },
  { id: "answered-to-delivered", from: "answered", to: "delivered", alerts: true },
  { id: "time-to-delivered", from: "received", to: "delivered", alerts: false },
];

test("the five are unchanged value by value and the sixth is its own exported constant", async () => {
  const { STAMP_METRICS, TRANSCRIBE_METRIC } = await seam("src/metrics/stamps.ts");

  // --- 1. The five, whole. A build that folded the sixth in fails here.
  expect(STAMP_METRICS).toEqual(FIVE);

  // --- 2. The sixth, as a whole object. It names the interval, it reads the
  //     door's own diary stream, and it alerts nothing: the alert is `check`'s
  //     stamp finding, and a second path over the same numbers would be two
  //     implementations of one verb.
  expect(TRANSCRIBE_METRIC).toEqual({
    id: "transcribe",
    stream: MEDIA_STREAM,
    from: "transcribe.started",
    to: "transcribe.done",
    alerts: false,
  });
  // Its two kinds are the door's own, not a second spelling of them.
  const kinds: string[] = [...MEDIA_KINDS];
  expect(kinds).toContain((TRANSCRIBE_METRIC as { from: string }).from);
  expect(kinds).toContain((TRANSCRIBE_METRIC as { to: string }).to);
  // And it lives BESIDE the five rather than inside them.
  expect((STAMP_METRICS as { id: string }[]).map((one) => one.id)).not.toContain("transcribe");
});

test(
  "every row carries the sixth under its own key beside the five, a chat with no voice is nothing rather than a zero, and a transcription that failed has no interval to report",
  async () => {
    const { readStampMetrics } = await seam("src/metrics/stamps.ts");
    expect(typeof readStampMetrics).toBe("function");
    const read = readStampMetrics as (store: unknown, o: { now: Date }) => Promise<MetricsRow[]>;

    const it = await stageMetrics();
    try {
      const store = await superStore(cluster, it.db);
      const noon = noonUtc();
      const now = new Date(noon.getTime() + 60 * 60 * 1000);
      const at = (minutes: number) => new Date(noon.getTime() + minutes * 60 * 1000);

      // Three voice notes on the first agent, whose transcripts took thirty,
      // sixty and ninety seconds.
      const spokenGaps = [30, 60, 90];
      for (const [nth, seconds] of spokenGaps.entries()) {
        await plantVoice(it, {
          id: `voice-${nth}`,
          person: PERSON,
          agent: AGENT,
          receivedAt: at(-30 + nth),
          seconds,
        });
      }

      // A typed note on the same agent: the five and no media at all.
      await plantMessage(it, { id: "typed", person: PERSON, agent: AGENT, receivedAt: at(-20) });
      await plantFive(it, "typed", at(-20), { acked: 5, started: 15, answered: 25, delivered: 35 });

      // A note whose transcription FAILED: a start, a failure, and no words.
      await plantMessage(it, { id: "gave-up", person: PERSON, agent: AGENT, receivedAt: at(-19) });
      await plantMedia(it, "gave-up", "transcribe.started", at(-19));
      await plantMedia(it, "gave-up", "transcribe.failed", new Date(at(-19).getTime() + 45_000));
      await plantFive(it, "gave-up", at(-19), { acked: 5, started: 15, answered: 25, delivered: 35 });

      // A note carrying the COLUMN and no diary lines, which is what a row
      // written before the stream existed looks like. The interval is the
      // stream's own, so this one contributes nothing to it.
      const columnOnly = at(-18);
      const columnDone = new Date(columnOnly.getTime() + 300_000);
      await plantMessage(it, {
        id: "column-only",
        person: PERSON,
        agent: AGENT,
        receivedAt: columnOnly,
        mediaDoneAt: columnDone,
      });
      await plantFive(it, "column-only", columnDone, { acked: 5, started: 15, answered: 25, delivered: 35 });

      // The first person's SECOND agent, which never speaks: it has the five
      // and it is the row the nothing case is read off.
      await plantMessage(it, { id: "study", person: PERSON, agent: AGENT_B, receivedAt: at(-17) });
      await plantFive(it, "study", at(-17), { acked: 5, started: 15, answered: 25, delivered: 35 });

      // The second person's own agent, with one voice note of its own, so the
      // two scopes hold different answers.
      await plantVoice(it, {
        id: "voice-second",
        person: PERSON2,
        agent: AGENT2,
        receivedAt: at(-15),
        seconds: 20,
      });

      // And one voice note two days old, so the week holds four and today
      // holds three.
      await plantVoice(it, {
        id: "voice-old",
        person: PERSON,
        agent: AGENT,
        receivedAt: new Date(noon.getTime() - 2 * 24 * 3600 * 1000),
        seconds: 120,
      });

      const rows = await read(store, { now });

      // --- 3. The sixth, by value, per person and per agent, today and this
      //     week. The second person's answer differs, which is what a build
      //     that grouped by one scope alone fails on.
      const today = spokenGaps.map((gap) => gap * 1000);
      const week = [...today, 120_000];
      for (const scope of ["agent", "person"] as const) {
        const who = scope === "agent" ? AGENT : PERSON;
        expect(measure(rows, scope, who, "today", "transcribe")).toEqual({
          count: today.length,
          p50_ms: percentile(today, 0.5),
          p99_ms: percentile(today, 0.99),
        });
        expect(measure(rows, scope, who, "week", "transcribe")).toEqual({
          count: week.length,
          p50_ms: percentile(week, 0.5),
          p99_ms: percentile(week, 0.99),
        });
      }
      for (const [scope, who] of [
        ["agent", AGENT2],
        ["person", PERSON2],
      ] as [string, string][]) {
        expect(measure(rows, scope, who, "today", "transcribe")).toEqual({
          count: 1,
          p50_ms: 20_000,
          p99_ms: 20_000,
        });
      }

      // --- and the five on the SAME rows, with the values today's stamps give
      //     them, so the sixth is proved ADDITIVE rather than a replacement.
      //     Six messages today on the first agent, and time to ack on a voice
      //     row excludes the interval its transcript took, which is the shipped
      //     rule and the reason every one of them reads five seconds.
      const ackMs = [5000, 5000, 5000, 5000, 5000, 5000];
      expect(measure(rows, "agent", AGENT, "today", "time-to-ack")).toEqual({
        count: ackMs.length,
        p50_ms: percentile(ackMs, 0.5),
        p99_ms: percentile(ackMs, 0.99),
      });

      // --- 8. The five are still read BY KEY off a row that also carries the
      //     sixth, so a build that turned `measures` into an ordered array is
      //     caught here rather than in the shipped file.
      const agentToday = rows.find(
        (row) => row.scope === "agent" && row.id === AGENT && row.window === "today",
      )!;
      expect(Array.isArray(agentToday.measures)).toBe(false);
      expect(Object.keys(agentToday.measures).sort()).toEqual(
        [...FIVE.map((one) => one.id), "transcribe"].sort(),
      );
      for (const one of FIVE) {
        expect(agentToday.measures[one.id].count).toBe(ackMs.length);
        expect(typeof agentToday.measures[one.id].p50_ms).toBe("number");
      }
      expect(agentToday.measures["ack-to-start"].p50_ms).toBe(10_000);
      expect(agentToday.measures["answered-to-delivered"].p50_ms).toBe(10_000);

      // --- 4. A chat with no voice is the NOTHING case and not a zero. Zero
      //     milliseconds is a measurement and "nothing was measured" is not.
      //     The row exists and its other five are full, so this is an empty
      //     measure rather than an absent row.
      for (const window of ["today", "week"] as const) {
        expect(measure(rows, "agent", AGENT_B, window, "transcribe")).toEqual(NOTHING);
        expect(measure(rows, "agent", AGENT_B, window, "time-to-ack").count).toBe(1);
      }

      // --- 5. A transcription that FAILED is not an interval. Three of the six
      //     messages the first agent answered today have words and the one that
      //     gave up has none, asserted by count.
      expect(measure(rows, "agent", AGENT, "today", "time-to-ack").count).toBe(6);
      expect(measure(rows, "agent", AGENT, "today", "transcribe").count).toBe(3);

      await store.close();
    } finally {
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a note whose words landed after midnight is measured in the day they landed in",
  async () => {
    // --- 6. THE WINDOW RULE IS THE SHIPPED ONE: a measurement belongs to the
    //     window holding its LATER stamp, because that is the moment the number
    //     became knowable. The pair below starts yesterday and finishes today.
    const { readStampMetrics } = await seam("src/metrics/stamps.ts");
    const read = readStampMetrics as (store: unknown, o: { now: Date }) => Promise<MetricsRow[]>;

    const it = await stageMetrics();
    try {
      const store = await superStore(cluster, it.db);
      const noon = noonUtc();
      const now = new Date(noon.getTime() + 60 * 60 * 1000);
      const midnight = new Date(
        Date.UTC(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate(), 0, 0, 0),
      );
      const startedAt = new Date(midnight.getTime() - 10 * 60 * 1000);
      const doneAt = new Date(midnight.getTime() + 10 * 60 * 1000);
      await plantMessage(it, {
        id: "across-midnight",
        person: PERSON,
        agent: AGENT,
        receivedAt: new Date(startedAt.getTime() - 1000),
        mediaDoneAt: doneAt,
      });
      await plantMedia(it, "across-midnight", "transcribe.started", startedAt);
      await plantMedia(it, "across-midnight", "transcribe.done", doneAt);
      await plantFive(it, "across-midnight", doneAt, { acked: 5, started: 15, answered: 25, delivered: 35 });

      const rows = await read(store, { now });
      expect(measure(rows, "agent", AGENT, "today", "transcribe")).toEqual({
        count: 1,
        p50_ms: 20 * 60 * 1000,
        p99_ms: 20 * 60 * 1000,
      });

      await store.close();
    } finally {
      await it.stop();
    }
  },
  SLOW,
);

test(
  "the printed table carries the sixth after the five and the command line prints exactly what the reader read",
  async () => {
    // --- 7. ONE IMPLEMENTATION, TWO FRONT ENDS, which is the rule
    //     `src/entry/metrics.ts` already states in its own comment. A number a
    //     board can show and a terminal cannot is a second implementation
    //     waiting to happen.
    const { readStampMetrics, renderMetrics } = await seam("src/metrics/stamps.ts");
    expect(typeof renderMetrics).toBe("function");
    const read = readStampMetrics as (store: unknown, o?: { now?: Date }) => Promise<MetricsRow[]>;
    const render = renderMetrics as (rows: MetricsRow[]) => string;

    const it = await stageMetrics();
    try {
      const store = await superStore(cluster, it.db);
      // Planted against the real clock, because the command reads its own.
      const now = new Date();
      await plantVoice(it, {
        id: "voice-printed",
        person: PERSON,
        agent: AGENT,
        receivedAt: new Date(now.getTime() - 10 * 60 * 1000),
        seconds: 40,
      });
      // A chat with no voice, so the nothing mark appears in the printed table
      // as well as in the data.
      await plantMessage(it, {
        id: "study-printed",
        person: PERSON,
        agent: AGENT_B,
        receivedAt: new Date(now.getTime() - 9 * 60 * 1000),
      });
      await plantFive(it, "study-printed", new Date(now.getTime() - 9 * 60 * 1000), {
        acked: 5,
        started: 15,
        answered: 25,
        delivered: 35,
      });

      const text = render(await read(store));

      // The order, on one scope's own lines: the sixth sits AFTER the five, in
      // the order the two constants are declared in.
      const lines = text.split("\n");
      const lineOf = (who: string, metric: string) =>
        lines.findIndex(
          (line) =>
            line.includes("agent") &&
            line.includes(who) &&
            line.includes("today") &&
            line.includes(metric),
        );
      const placed = [...FIVE.map((one) => one.id), "transcribe"].map((metric) => {
        const at = lineOf(AGENT, metric);
        expect(at, `the printed table has no line for ${metric}:\n${text}`).toBeGreaterThan(-1);
        return at;
      });
      for (let nth = 1; nth < placed.length; nth++) {
        expect(
          placed[nth],
          `the table prints the six out of order at ${placed}:\n${text}`,
        ).toBeGreaterThan(placed[nth - 1]);
      }
      // The same columns: the interval is printed in milliseconds beside the
      // five, and a scope that measured none prints the nothing mark.
      expect(text).toContain("40000");
      const silent = lines[lineOf(AGENT_B, "transcribe")];
      expect(silent, `no line for a chat with no voice:\n${text}`).toBeDefined();
      expect(silent).toContain("-");
      expect(silent.split(/\s{2,}/).some((cell) => cell.trim() === "0")).toBe(false);

      // THE COMMAND LINE PRINTS IT TOO, through the shipped verb, compared
      // against the reader's own answer computed here.
      const proc = Bun.spawn(
        [process.execPath, "run", hubPath("src/entry/command.ts"), "metrics", it.registryFile],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited, `the command said: ${err}`).toBe(0);
      expect(err).toBe("");
      expect(out.trim()).toBe(render(await read(store)).trim());
      expect(out).toContain("transcribe");

      await store.close();
    } finally {
      await it.stop();
    }
  },
  SLOW,
);

test(
  "THE CONTROL: over a household with no voice at all the five answer exactly what they answer today, value by value, and the sixth is present and empty",
  async () => {
    const { readStampMetrics } = await seam("src/metrics/stamps.ts");
    const read = readStampMetrics as (store: unknown, o: { now: Date }) => Promise<MetricsRow[]>;

    const it = await stageMetrics();
    try {
      const store = await superStore(cluster, it.db);
      const noon = noonUtc();
      const now = new Date(noon.getTime() + 60 * 60 * 1000);
      const at = (minutes: number) => new Date(noon.getTime() + minutes * 60 * 1000);

      // Nine gaps whose p50 and p99 are neither the mean nor the maximum, so a
      // build that returned either fails.
      const gaps = [1, 2, 3, 4, 5, 6, 7, 8, 100];
      for (const [nth, gap] of gaps.entries()) {
        const id = `plain-${nth}`;
        const received = at(-30 + nth);
        await plantMessage(it, { id, person: PERSON, agent: AGENT, receivedAt: received });
        await plantFive(it, id, received, {
          acked: gap,
          started: gap + 10,
          answered: gap + 20,
          delivered: gap + 30,
        });
      }

      const rows = await read(store, { now });
      const ms = (shift: number) => gaps.map((gap) => (gap + shift) * 1000);
      const spread = (shift: number): Measure => ({
        count: gaps.length,
        p50_ms: percentile(ms(shift), 0.5),
        p99_ms: percentile(ms(shift), 0.99),
      });
      const flat = (value: number): Measure => ({ count: gaps.length, p50_ms: value, p99_ms: value });
      const expected: Record<string, Measure> = {
        "time-to-ack": spread(0),
        "time-to-start": spread(10),
        "ack-to-start": flat(10_000),
        "answered-to-delivered": flat(10_000),
        "time-to-delivered": spread(30),
      };
      for (const [metric, said] of Object.entries(expected)) {
        expect(measure(rows, "agent", AGENT, "today", metric)).toEqual(said);
        expect(measure(rows, "person", PERSON, "today", metric)).toEqual(said);
      }
      // The sixth is there and it is EMPTY, on every row, because a household
      // that has never spoken has nothing measured rather than a zero.
      for (const row of rows) expect(row.measures["transcribe"]).toEqual(NOTHING);

      await store.close();
    } finally {
      await it.stop();
    }
  },
  SLOW,
);
