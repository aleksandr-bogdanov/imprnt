// The board's voice-facing rows: the sixth measure, the recognizer's health as
// its sheet holds it, and the current memory reading beside the peak.
// (RUN-05, RUN-13, SPEC §2)
//
// THE PAGE COMPUTES NOTHING, and this file is where that rule meets the two
// numbers a page is most tempted to judge. The interval is whatever
// `readStampMetrics` answered. The recognizer's state is printed in the sheet's
// own words, so a page and `check` cannot disagree about whether transcription
// is working. A resident over its limit appears because `check` wrote a
// finding, in the finding's own words, and the memory cells carry no verdict of
// their own.
//
// THE BOARD NEVER SAMPLES. The current reading is the hub's own record, read
// off the peaks sheet, and the recording seam is asserted to have seen no
// `memory` call at all across a sweep: a read that could start work is not a
// read, and a page that measured memory would be a page that touched every
// process on the box.
//
// NO ROW AT ALL IS A DIFFERENT FACT FROM A FAILURE THAT CLEARED, and a
// household that names no recognizer is a third fact again. All three render
// differently and all three are asserted here.
//
// WHICH ASSERTION IS GREEN FROM THE FIRST RUN, so nobody reads a green as
// evidence: the pinned-sentence scan, because a page that has not learned to
// print a voice row prints no sentence about one either. It earns its keep once
// the build lands and a new render could carry a sentence nothing pinned.
//
// Red reason: behaviour absent. `src/board/pages.ts` renders the five measures
// and the peak and knows nothing about the sixth, the `voice_health` sheet or
// the current reading, so the first assertion is red against the shipped page
// with every import resolving.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, statementWatch, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import { freePort, plantedSeam, recordingSeam, serveBoard, type ServedBoard } from "./helpers/board.ts";
import type { RecognizerSpec, RunSpec } from "./helpers/registry.ts";
import type { Store } from "../src/store/connect.ts";
import { findingId } from "../src/check/finding.ts";
import { readStampMetrics, type MetricsRow } from "../src/metrics/stamps.ts";
import { recordPeak } from "../src/hub/peak.ts";
import { readVoiceHealth, voiceFailed, voiceSucceeded } from "../src/voice/health.ts";
import { MEDIA_STREAM } from "../src/voice/records.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const THERE = HERE === "mac" ? "pi" : "mac";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const THERE_OS = HERE_OS === "macos" ? "linux" : "macos";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";
const MB = 1024 * 1024;
const RECOGNIZER = "local";

const LOCAL: Record<string, RecognizerSpec> = {
  local: {
    provider: "sherpa-onnx",
    model: "a-speech-model-directory",
    runtime: "/var/lib/imprnt-hub/voice",
    chunk_seconds: 60,
  },
};

let cluster: Cluster;
const scratch: string[] = [];

beforeAll(async () => {
  cluster = await startCluster({
    settings: {
      log_statement: "'all'",
      log_line_prefix: "'pid=%p '",
      log_min_duration_statement: "-1",
    },
  });
});

afterAll(async () => {
  try {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  } finally {
    await cluster?.stop();
  }
});

function scratchDir(what: string): string {
  const dir = mkdtempSync(join(tmpdir(), what));
  scratch.push(dir);
  return dir;
}

const DOOR_ENTRY: RunSpec = {
  id: "door-fake",
  kind: "door",
  machine: HERE,
  platform: "fake",
  person: "p1",
  token_file: "/dev/null",
  schedule: "always",
  memory_limit_mb: 192,
};
const RUNNER_ENTRY: RunSpec = {
  id: "runner-test",
  kind: "runner",
  machine: HERE,
  schedule: "always",
  memory_limit_mb: 512,
  child_memory_limit_mb: 2048,
};
const HUB_ENTRY: RunSpec = {
  id: "hub-one",
  kind: "hub",
  machine: HERE,
  schedule: "always",
  memory_limit_mb: 128,
};
const THERE_ENTRY: RunSpec = {
  id: "runner-there",
  kind: "runner",
  machine: THERE,
  schedule: "always",
  memory_limit_mb: 512,
  child_memory_limit_mb: 2048,
};

interface Staged {
  it: StagedHub;
  store: Store;
  board: ServedBoard;
  seam: ReturnType<typeof plantedSeam>;
  recorder: ReturnType<typeof recordingSeam>;
  boardEntry: RunSpec;
  stop(): Promise<void>;
}

/**
 * A household with a board, and with a recognizer unless one is refused.
 *
 * A `transcriber` entry is only legal while the household names a recognizer
 * that runs here, so the two travel together and the no-recognizer stage drops
 * both.
 */
async function stage(options: { recognizer?: boolean } = {}): Promise<Staged> {
  const withVoice = options.recognizer !== false;
  const boardEntry: RunSpec = {
    id: "board",
    kind: "board",
    machine: HERE,
    schedule: "always",
    memory_limit_mb: 128,
    bind: "127.0.0.1",
    port: await freePort(),
  };
  const transcriber: RunSpec = {
    id: "transcriber-here",
    kind: "transcriber",
    machine: HERE,
    schedule: "always",
    memory_limit_mb: 2048,
    port: await freePort(),
  };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [
      { id: HERE, os: HERE_OS },
      { id: THERE, os: THERE_OS },
    ],
    people: [
      { id: "p1", tree: scratchDir("hub-voice-rows-p1-") },
      { id: "p2", tree: scratchDir("hub-voice-rows-p2-") },
    ],
    agents: [
      {
        id: "p2-lair",
        person: "p2",
        preset: "daily",
        chat: "fixture-chat-2",
        door: DOOR_ENTRY.id,
        runner: RUNNER_ENTRY.id,
      },
    ],
    run: withVoice
      ? [DOOR_ENTRY, RUNNER_ENTRY, HUB_ENTRY, THERE_ENTRY, transcriber, boardEntry]
      : [DOOR_ENTRY, RUNNER_ENTRY, HUB_ENTRY, THERE_ENTRY, boardEntry],
    registry: (base) =>
      withVoice
        ? { ...base, voice: { recognizer: RECOGNIZER }, recognizers: LOCAL }
        : base,
  });
  const store = await superStore(cluster, it.db);
  const planted = plantedSeam(FLAVOUR);
  const recorder = recordingSeam(planted.os);
  const board = await serveBoard({
    registryFile: it.registryFile,
    entryId: boardEntry.id,
    store,
    os: recorder.os,
  });
  return {
    it,
    store,
    board,
    seam: planted,
    recorder,
    boardEntry,
    async stop() {
      await board.stop();
      await store.close();
      await it.stop();
    },
  };
}

async function bodyOf(board: ServedBoard, path: string): Promise<string> {
  const answer = await board.get(path);
  expect(answer.status, `${path} answered ${answer.status}`).toBe(200);
  return await answer.text();
}

/** One planted `check` row, written the way `check` itself writes one. */
async function plantFinding(
  it: StagedHub,
  finding: { machine: string; kind: string; subject: string; says: string; fix: string },
): Promise<string> {
  const id = findingId(finding.machine, finding.kind, finding.subject);
  // The object is BOUND, never serialised first: this client sends an already
  // serialised object as a jsonb string and every reader then sees a string
  // that looks like the finding rather than the finding.
  await it.read.sql(
    `insert into state_row (sheet, id, data) values ('check', $1, $2)
       on conflict (sheet, id) do update set data = excluded.data, updated_at = now()`,
    [id, { id, ...finding }],
  );
  return id;
}

/** One message with a transcript, as the five stamps and the two diary lines. */
async function plantVoiceNote(
  it: StagedHub,
  what: { id: string; person: string; agent: string; receivedAt: Date; seconds: number },
): Promise<void> {
  const startedAt = new Date(what.receivedAt.getTime() + 1000);
  const doneAt = new Date(startedAt.getTime() + what.seconds * 1000);
  await it.read.sql(
    `insert into inbound (id, person, agent, body, kind, received_at, media_state, media_done_at)
     values ($1, $2, $3, $4, 'human', $5::timestamptz, 'done', $6::timestamptz)`,
    [
      what.id,
      what.person,
      what.agent,
      `a message called ${what.id}`,
      what.receivedAt.toISOString(),
      doneAt.toISOString(),
    ],
  );
  for (const [kind, at, actor] of [
    ["received", what.receivedAt, "door"],
    ["acked", new Date(doneAt.getTime() + 5000), "runner"],
    ["started", new Date(doneAt.getTime() + 15_000), "runner"],
    ["answered", new Date(doneAt.getTime() + 25_000), "runner"],
    ["delivered", new Date(doneAt.getTime() + 35_000), "door"],
  ] as [string, Date, string][]) {
    await it.read.sql(
      `insert into ledger_event (at, stream, subject, kind, actor)
       values ($1, 'inbound', $2, $3, $4)`,
      [at.toISOString(), what.id, kind, actor],
    );
  }
  for (const [kind, at] of [
    ["transcribe.started", startedAt],
    ["transcribe.done", doneAt],
  ] as [string, Date][]) {
    await it.read.sql(
      `insert into ledger_event (at, stream, subject, kind, actor)
       values ($1, $2, $3, $4, 'door')`,
      [at.toISOString(), MEDIA_STREAM, what.id, kind],
    );
  }
}

/**
 * The cells of one row, inside the one table a named column identifies.
 *
 * The table is found by a column of its own rather than by position, because a
 * page carries several and a finding's subject is an entry's id, so a row
 * picked by its first cell alone would match in two tables at once.
 */
function cellsFor(text: string, column: string, id: string): string[] {
  const tables = [...text.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((one) => one[1]);
  const mine = tables.filter((one) => one.includes(`<th>${column}</th>`));
  if (mine.length !== 1) {
    throw new Error(`the page has ${mine.length} tables carrying a ${column} column`);
  }
  const rows = [...mine[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((one) =>
    [...one[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].trim()),
  );
  const found = rows.filter((cells) => cells.length > 0 && cells[0] === id);
  if (found.length !== 1) {
    throw new Error(`the ${column} table has ${found.length} rows whose first cell is ${id}`);
  }
  return found[0];
}

/** One entry's row on the machines page. */
const entryRow = (text: string, id: string) => cellsFor(text, "peak bytes", id);

/** One recognizer's row on the metrics page. */
const healthRow = (text: string, id: string) => cellsFor(text, "recognizer", id);

/**
 * Every `<p>` and every `<th>` the page carries, as text.
 *
 * Those two and not the headings, because a heading on these pages carries a
 * page name, a machine id or a scope name, which is a value. What this reads is
 * the prose and the column labels, which are the two places a sentence nobody
 * pinned could be assembled.
 */
function prose(text: string): string[] {
  return [
    ...[...text.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((one) => one[1]),
    ...[...text.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((one) => one[1]),
  ]
    .map((one) => one.replace(/<[^>]*>/g, "").trim())
    .filter((one) => one !== "");
}

test(
  "the metrics page carries the transcribing interval, by value and after the five",
  async () => {
    const staged = await stage();
    try {
      const { board, it, store } = staged;
      const now = new Date();
      await plantVoiceNote(it, {
        id: "voice-one",
        person: "p1",
        agent: "p1-lair",
        receivedAt: new Date(now.getTime() - 10 * 60 * 1000),
        seconds: 45,
      });
      await plantVoiceNote(it, {
        id: "voice-two",
        person: "p2",
        agent: "p2-lair",
        receivedAt: new Date(now.getTime() - 9 * 60 * 1000),
        seconds: 12,
      });

      const rows: MetricsRow[] = await readStampMetrics(store, { now: new Date(now.getTime() + 60_000) });
      const text = await bodyOf(board, "/metrics");

      // --- 1. The page's cells for the interval ARE the reader's own answer,
      //     per person and per agent, today and this week.
      let asserted = 0;
      for (const row of rows) {
        const measure = row.measures["transcribe"];
        expect(measure, `${row.scope} ${row.id} ${row.window} has no transcribe`).toBeDefined();
        if (measure.count === 0) continue;
        asserted += 1;
        expect(text, `${row.scope} ${row.id} ${row.window} p50`).toContain(
          String(Math.round(measure.p50_ms ?? 0)),
        );
        expect(text).toContain(String(Math.round(measure.p99_ms ?? 0)));
      }
      // Two scopes, two windows, two chats: a run where nothing was asserted
      // would otherwise pass.
      expect(asserted).toBe(8);

      // --- and it sits AFTER the five, in the same table, asserted by order on
      //     one scope's own lines.
      const lines = text.split("\n");
      const at = (metric: string) =>
        lines.findIndex(
          (line) => line.includes("p1-lair") && line.includes("today") && line.includes(metric),
        );
      const placed = [
        "time-to-ack",
        "time-to-start",
        "ack-to-start",
        "answered-to-delivered",
        "time-to-delivered",
        "transcribe",
      ].map((metric) => {
        const where = at(metric);
        expect(where, `the metrics page has no row for ${metric}`).toBeGreaterThan(-1);
        return where;
      });
      for (let nth = 1; nth < placed.length; nth++) {
        expect(placed[nth], `the page prints the six out of order at ${placed}`).toBeGreaterThan(
          placed[nth - 1],
        );
      }
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the metrics page prints the recognizer's health as the sheet holds it, and a failure that cleared is not a recognizer that never failed",
  async () => {
    const staged = await stage();
    try {
      const { board, store } = staged;

      // --- 2a. NO ROW AT ALL means nothing has ever failed, which the page
      //     says in its own empty line rather than by claiming health.
      const first = await bodyOf(board, "/metrics");
      expect(first).toContain("no recognizer has ever failed.");

      // --- 2b. A failing episode, planted through the writer the door uses, so
      //     the values on the page are the values the sheet really holds.
      const retryAt = new Date(Date.now() + 300_000);
      await voiceFailed(store, {
        recognizer: RECOGNIZER,
        class: "infra",
        cause: "the recognizer did not answer",
        retry_at: retryAt,
      });
      await voiceFailed(store, {
        recognizer: RECOGNIZER,
        class: "infra",
        cause: "the recognizer did not answer",
        retry_at: retryAt,
      });
      const failing = (await readVoiceHealth(store)).get(RECOGNIZER)!;
      expect(failing.since).not.toBeNull();
      expect(failing.attempts).toBe(2);

      const said = await bodyOf(board, "/metrics");
      expect(said).not.toContain("no recognizer has ever failed.");
      const cells = healthRow(said, RECOGNIZER);
      for (const value of [
        failing.since,
        failing.class,
        failing.cause,
        String(failing.attempts),
        failing.retry_at,
      ] as string[]) {
        expect(cells, `the health row has no cell holding ${value}`).toContain(value);
      }
      // `last_ok_at` is empty while the episode is open, and an empty field
      // prints the nothing mark rather than a word.
      expect(failing.last_ok_at).toBeNull();
      expect(cells).toContain("-");

      // --- 2c. Cleared, through the writer a successful note uses. The row
      //     stays, `since` is gone and `last_ok_at` is set, which is a
      //     different rendering from the never-failed case above.
      await voiceSucceeded(store, RECOGNIZER);
      const cleared = (await readVoiceHealth(store)).get(RECOGNIZER)!;
      expect(cleared.since).toBeNull();
      expect(cleared.last_ok_at).not.toBeNull();

      const after = await bodyOf(board, "/metrics");
      expect(after).not.toContain("no recognizer has ever failed.");
      expect(after).not.toContain(failing.cause as string);
      const clearedCells = healthRow(after, RECOGNIZER);
      expect(clearedCells).toContain(cleared.last_ok_at as string);
      expect(clearedCells).not.toContain(failing.since as string);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the metrics page reads the measures and the recognizer's health, and issues no other statement",
  async () => {
    const staged = await stage();
    try {
      const { board, it, store } = staged;
      await voiceFailed(store, {
        recognizer: RECOGNIZER,
        class: "content",
        cause: "the note held no speech",
        retry_at: null,
      });
      // Warm: the store handle opens its first connection on the first read,
      // and what is counted is a page view rather than a connect.
      await bodyOf(board, "/metrics");

      // --- 3. Every logged statement is matched to one of the page's two
      //     readers, and anything unmatched fails with the statement printed.
      const readers = [
        { what: "readStampMetrics: the gaps and the interval", sql: /first_stamp/ },
        { what: "readStampMetrics: who was measured", sql: /distinct person, agent\s+from inbound/ },
        { what: "the recognizer's health sheet", sql: /from state_row/ },
      ];
      const watch = await statementWatch(cluster, [await it.read.pid()]);
      await bodyOf(board, "/metrics");
      const lines = await watch.lines();
      for (const line of lines) {
        expect(
          readers.some((reader) => reader.sql.test(line)),
          `the metrics page issued a statement no named reader of that page issues:\n${line}`,
        ).toBe(true);
      }
      // The count beside the shapes: two for the measures, one for the sheet.
      expect(lines.length, `the metrics page issued:\n${lines.join("\n")}`).toBe(3);
      // And it computed no verdict about voice: the page carries none of the
      // words a card uses.
      const text = await bodyOf(board, "/metrics");
      for (const word of ["broken", "waiting", "ok"]) {
        expect(text, `the metrics page carries the card word ${word}`).not.toMatch(
          new RegExp(`class="word"[^>]*>${word}`),
        );
      }
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the machines page shows the current reading beside the peak and the limit, and the board measures nothing",
  async () => {
    const staged = await stage();
    try {
      const { board, store, recorder, seam } = staged;
      for (const id of [DOOR_ENTRY.id, RUNNER_ENTRY.id, HUB_ENTRY.id, "board"]) seam.plant(id, true);

      // The hub's own record, written by the hub's own writer, so the page is
      // reading the shape production makes.
      await recordPeak(store, {
        id: RUNNER_ENTRY.id,
        bytes: 456 * MB,
        how: "sampled",
        machine: HERE,
        reading_bytes: 312 * MB,
      });
      // A resident with a peak and NO current reading: the second half of the
      // assertion, and the reason the absent case is a mark rather than a zero.
      await recordPeak(store, {
        id: DOOR_ENTRY.id,
        bytes: 91 * MB,
        how: "sampled",
        machine: HERE,
      });

      const text = await bodyOf(board, "/");

      // --- 4. The peak, the reading and the entry's own limit, all three by
      //     value, on the resident's own row.
      const runner = entryRow(text, RUNNER_ENTRY.id);
      expect(runner).toContain(String(456 * MB));
      expect(runner).toContain(String(312 * MB));
      expect(runner).toContain(String(RUNNER_ENTRY.memory_limit_mb));

      const door = entryRow(text, DOOR_ENTRY.id);
      expect(door).toContain(String(91 * MB));
      expect(door).toContain("-");
      expect(door, "an absent reading printed as a zero").not.toContain("0");

      // --- and THE PAGE MEASURES NOTHING. The reading is the hub's own record,
      //     and a board that sampled would be a board that touched every
      //     process on the box.
      for (const path of ["/", "/people", "/findings", "/metrics"]) await bodyOf(board, path);
      expect(
        recorder.calls.filter((call) => call.verb === "memory"),
        "the board asked the operating system how large a process is",
      ).toEqual([]);
      // The control on that emptiness: the recorder really does write down a
      // reading verb, proved by the calls the machines page did make.
      expect(recorder.verbs()).toContain("show");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a resident over its limit is check's finding in check's own words, and the row carries no verdict of its own",
  async () => {
    const staged = await stage();
    try {
      const { board, it, store, seam } = staged;
      for (const id of [DOOR_ENTRY.id, RUNNER_ENTRY.id, HUB_ENTRY.id, "board"]) seam.plant(id, true);
      await recordPeak(store, {
        id: RUNNER_ENTRY.id,
        bytes: 900 * MB,
        how: "sampled",
        machine: HERE,
        reading_bytes: 880 * MB,
      });
      const says = `${RUNNER_ENTRY.id} was last measured holding 880 MB and its entry asks for 512 MB`;
      const fix = `raise memory_limit_mb for ${RUNNER_ENTRY.id} or find out what it is holding`;
      await plantFinding(it, {
        machine: HERE,
        kind: "memory-over-limit",
        subject: RUNNER_ENTRY.id,
        says,
        fix,
      });

      // --- 5. The finding, with its own sentence and its own command.
      const text = await bodyOf(board, "/");
      expect(text).toContain(says);
      expect(text).toContain(fix);
      expect(text).toContain("memory-over-limit");

      // And the row's own memory cells carry the numbers and NO word: that is
      // the hard-won rule applied to the one number a page is most tempted to
      // judge.
      const runner = entryRow(text, RUNNER_ENTRY.id);
      expect(runner).toContain(String(880 * MB));
      for (const verdict of ["over", "broken", "too large", "warning", "danger"]) {
        expect(runner.join(" ").toLowerCase(), `the row says ${verdict} of its own`).not.toContain(
          verdict,
        );
      }
      expect(text).not.toContain('class="over"');
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a household that names no recognizer sees no voice rows at all and still gets a page",
  async () => {
    const staged = await stage({ recognizer: false });
    try {
      const { board, it } = staged;
      // A message and its stamps, so the measures table is not empty and the
      // absence below is about voice rather than about an empty page.
      await it.read.sql(
        `insert into inbound (id, person, agent, body, kind) values ('typed-one', 'p1', 'p1-lair', 'a message', 'human')`,
      );
      await it.read.sql(
        `insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'typed-one', 'received', 'door')`,
      );

      // --- 6. No health block at all, and no interval row beyond the empty
      //     measure every row already carries.
      const answer = await board.get("/metrics");
      expect(answer.status).toBe(200);
      const text = await answer.text();
      expect(text).toContain("p1-lair");
      expect(text).not.toContain("no recognizer has ever failed.");
      expect(text).not.toContain("<th>recognizer</th>");
      expect(text).not.toContain("last worked");
      // The interval is still a measure of every row, and with no voice at all
      // it prints the nothing mark rather than a number.
      const lines = text.split("\n");
      const row = lines.find(
        (line) => line.includes("p1-lair") && line.includes("today") && line.includes("transcribe"),
      );
      expect(row, `no interval row on a page with a measured chat:\n${text}`).toBeDefined();
      expect(row).toContain("-");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "every sentence on the voice-facing pages is pinned, a heading, or a value",
  async () => {
    const staged = await stage();
    try {
      const { board, store, it, seam } = staged;
      for (const id of [DOOR_ENTRY.id, RUNNER_ENTRY.id, HUB_ENTRY.id, "board"]) seam.plant(id, true);
      await voiceFailed(store, {
        recognizer: RECOGNIZER,
        class: "infra",
        cause: "the recognizer did not answer",
        retry_at: null,
      });
      await recordPeak(store, {
        id: RUNNER_ENTRY.id,
        bytes: 456 * MB,
        how: "sampled",
        machine: HERE,
        reading_bytes: 312 * MB,
      });
      await plantFinding(it, {
        machine: HERE,
        kind: "memory-over-limit",
        subject: RUNNER_ENTRY.id,
        says: "a sentence check wrote",
        fix: "a command check wrote",
      });

      // --- 7. NO PAGE ASSEMBLES A SENTENCE FROM FRAGMENTS. Every piece of
      //     prose on the machines page and the metrics page is held here as
      //     data: a column heading, or one of the lines the board ships for an
      //     empty section. Anything else is a sentence somebody wrote into a
      //     render, which is what this assertion exists to catch.
      const known = [
        // The headings and the empty-section lines the two pages carry.
        "entry",
        "kind",
        "wanted",
        "seen",
        "pid",
        "peak bytes",
        "limit mb",
        "target",
        "asked by",
        "state",
        "cause",
        "asked at",
        "finding",
        "subject",
        "what it says",
        "the fix",
        "as of",
        "who",
        "window",
        "measure",
        "p50 ms",
        "p99 ms",
        "count",
        "this machine runs nothing the registry declares.",
        "nobody has asked for anything.",
        "nothing has been measured yet.",
        `nothing is reported for ${THERE} in the check sheet this store holds.`,
        // The voice-facing ones.
        "reading bytes",
        "recognizer",
        "failing since",
        "class",
        "attempts",
        "next try",
        "last worked",
        "no recognizer has ever failed.",
      ];
      for (const path of ["/", "/metrics"]) {
        for (const said of prose(await bodyOf(board, path))) {
          expect(known, `${path} carries a sentence nothing pinned: ${said}`).toContain(said);
        }
      }
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "THE CONTROL: with nothing voice-shaped planted the two pages still carry everything they carried before",
  async () => {
    const staged = await stage();
    try {
      const { board, it, store, seam } = staged;
      for (const id of [DOOR_ENTRY.id, RUNNER_ENTRY.id, HUB_ENTRY.id, "board"]) seam.plant(id, true);
      await recordPeak(store, { id: RUNNER_ENTRY.id, bytes: 456 * MB, how: "sampled", machine: HERE });
      await plantFinding(it, {
        machine: THERE,
        kind: "unit-missing",
        subject: THERE_ENTRY.id,
        says: `the service manager on ${THERE} is not running ${THERE_ENTRY.id}`,
        fix: "start it there",
      });
      await it.read.sql(
        `insert into inbound (id, person, agent, body, kind) values ('typed-two', 'p1', 'p1-lair', 'a message', 'human')`,
      );
      await it.read.sql(
        `insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'typed-two', 'received', 'door')`,
      );

      // A build that rearranged the machines page while adding a column is
      // caught here: every non-voice thing the page carried is asserted again.
      const machines = await bodyOf(board, "/");
      for (const entry of [DOOR_ENTRY, RUNNER_ENTRY, HUB_ENTRY]) {
        const cells = entryRow(machines, entry.id);
        expect(cells).toContain(entry.kind);
        expect(cells).toContain("running");
        expect(cells).toContain(String(entry.memory_limit_mb));
      }
      expect(entryRow(machines, RUNNER_ENTRY.id)).toContain(String(456 * MB));
      expect(machines).toContain(THERE_ENTRY.id);
      expect(machines).toContain(`the service manager on ${THERE} is not running ${THERE_ENTRY.id}`);
      expect(machines).toContain("nobody has asked for anything.");

      // And the metrics page still prints the five it printed before.
      const metrics = await bodyOf(board, "/metrics");
      for (const metric of [
        "time-to-ack",
        "time-to-start",
        "ack-to-start",
        "answered-to-delivered",
        "time-to-delivered",
      ]) {
        expect(metrics, `the metrics page dropped ${metric}`).toContain(metric);
      }
      expect(metrics).toContain("p1-lair");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);
