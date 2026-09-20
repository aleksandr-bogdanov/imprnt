// Four pages, each a read of the one store and the OS seam through the
// functions the command line already calls. (SPEC §1, §2, §6, RUN-05)
//
// THE PAGE COMPUTES NOTHING. Where a card needs one word, the word is whether
// the `check` sheet holds a finding whose subject is this thing, which is
// `check`'s answer and never the page's opinion, so the two can never disagree
// about whether a household is in trouble. That is the rule the earlier board
// learned the hard way and it is the one this file binds hardest.
//
// A STATE PAGE SHOWS STATE AND NEVER CONVERSATIONS. Nobody reaching the bind
// address is identified, so what a reader sees is the list, the difference,
// findings and numbers, and no page carries a word anybody typed.
//
// WHAT EACH PAGE READ is asserted on the SERVER's own statement log rather than
// on a spy, which is the same probe the shipped idle windows use, and every
// logged statement has to match one of the page's named readers or the check
// fails with the statement printed.
//
// NO CURRENT MEMORY READING IS ASSERTED HERE and no voice-facing row is: those
// arrive with the transcriber and this check says so rather than leaving its
// silence to be read as a gap.
//
// Red reason: import missing, `src/board/run.ts`, reached through
// `test/helpers/board.ts`. Every assertion behind it is red for behaviour,
// because no page exists to read anything.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hubPath, startCluster, statementWatch, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, insertInbound, type StagedHub } from "./helpers/hub-fixture.ts";
import { freePort, plantedSeam, recordingSeam, serveBoard, treeDigest, type ServedBoard } from "./helpers/board.ts";
import type { RunSpec } from "./helpers/registry.ts";
import type { Store } from "../src/store/connect.ts";
import { readStatus } from "../src/hub/status.ts";
import { readStampMetrics } from "../src/metrics/stamps.ts";
import { findingId } from "../src/check/finding.ts";
import { cardBroken, cardOk, cardWaiting, pageMissing } from "../src/door/lines.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const THERE = HERE === "mac" ? "pi" : "mac";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const THERE_OS = HERE_OS === "macos" ? "linux" : "macos";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";

/** The four pages, by the path each one answers on. */
const PAGES = ["/", "/people", "/findings", "/metrics"] as const;

/**
 * What each page is allowed to ask the store, by the reader that asks it.
 *
 * A state sheet read carries its sheet as a bound parameter, so the statement
 * text is the same for the `check` sheet, the peaks and the health rows and the
 * shape is what can be matched. Anything a page issued that matches none of
 * these is what this check exists to catch.
 */
const READERS: Record<string, { what: string; sql: RegExp }[]> = {
  "/": [{ what: "a state sheet: the check sheet, the peaks and the control sheet", sql: /from state_row/ }],
  "/people": [
    { what: "a state sheet: agent health, door health and the check sheet", sql: /from state_row/ },
    { what: "readOpenTurns", sql: /from inbound/ },
  ],
  "/findings": [{ what: "the check sheet", sql: /from state_row/ }],
  "/metrics": [
    { what: "readStampMetrics: the gaps", sql: /first_stamp/ },
    { what: "readStampMetrics: who was measured", sql: /distinct person, agent\s+from inbound/ },
  ],
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
/** The entry the file says is down, which is the fourth wanted state. */
const STOPPED_ENTRY: RunSpec = {
  id: "watch-bikes",
  kind: "runner",
  machine: HERE,
  schedule: "every 15m",
  memory_limit_mb: 128,
  child_memory_limit_mb: 512,
  enabled: false,
};
/** An entry on the other machine, whose state is not reachable from here. */
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
  trees: Record<string, string>;
  boardEntry: RunSpec;
  stop(): Promise<void>;
}

async function stage(options: { people?: boolean } = {}): Promise<Staged> {
  const withPeople = options.people !== false;
  const trees: Record<string, string> = {
    p1: scratchDir("hub-board-p1-"),
    p2: scratchDir("hub-board-p2-"),
  };
  const boardEntry: RunSpec = {
    id: "board",
    kind: "board",
    machine: HERE,
    schedule: "always",
    memory_limit_mb: 128,
    bind: "127.0.0.1",
    port: await freePort(),
  };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [
      { id: HERE, os: HERE_OS },
      { id: THERE, os: THERE_OS },
    ],
    people: withPeople
      ? [
          { id: "p1", tree: trees.p1 },
          { id: "p2", tree: trees.p2 },
        ]
      : [{ id: "p1", tree: trees.p1 }],
    agents: withPeople
      ? [
          {
            id: "p2-lair",
            person: "p2",
            preset: "daily",
            chat: "fixture-chat-2",
            door: DOOR_ENTRY.id,
            runner: RUNNER_ENTRY.id,
          },
        ]
      : [],
    run: [DOOR_ENTRY, RUNNER_ENTRY, HUB_ENTRY, STOPPED_ENTRY, THERE_ENTRY, boardEntry],
  });
  const store = await superStore(cluster, it.db);
  const seam = plantedSeam(FLAVOUR);
  const recorder = recordingSeam(seam.os);
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
    seam,
    recorder,
    trees,
    boardEntry,
    async stop() {
      await board.stop();
      await store.close();
      await it.stop();
    },
  };
}

/** One `check` sheet row, planted the way `check` itself writes it. */
async function plantFinding(
  it: StagedHub,
  finding: { machine: string; kind: string; subject: string; says: string; fix: string },
): Promise<string> {
  const id = findingId(finding.machine, finding.kind, finding.subject);
  // The object is BOUND, never serialised first: this client sends an already
  // serialised object as a jsonb string, and the row a page then reads back is
  // a string whose contents look like the finding rather than the finding.
  await it.read.sql(
    `insert into state_row (sheet, id, data) values ('check', $1, $2)
       on conflict (sheet, id) do update set data = excluded.data, updated_at = now()`,
    [id, { id, ...finding }],
  );
  return id;
}

async function removeFinding(it: StagedHub, id: string): Promise<void> {
  await it.read.sql(`delete from state_row where sheet = 'check' and id = $1`, [id]);
}

async function bodyOf(board: ServedBoard, path: string): Promise<string> {
  const answer = await board.get(path);
  expect(answer.status, `${path} answered ${answer.status}`).toBe(200);
  return await answer.text();
}

test(
  "each page issues the statements its own readers issue and no other, and the only manager verbs are reading ones",
  async () => {
    const staged = await stage();
    try {
      const { board, it, recorder } = staged;
      // Warm: the store handle opens its first connection on the first read, and
      // what is being counted is a page view rather than a connect.
      for (const path of PAGES) await bodyOf(board, path);

      for (const path of PAGES) {
        const watch = await statementWatch(cluster, [await it.read.pid()]);
        await bodyOf(board, path);
        const lines = await watch.lines();
        for (const line of lines) {
          const matched = READERS[path].some((reader) => reader.sql.test(line));
          expect(
            matched,
            `${path} issued a statement no named reader of that page issues:\n${line}`,
          ).toBe(true);
        }
        // The count, beside the shapes: the machines page reads three sheets
        // (the findings, the peaks, and the control rows that say what came of
        // an act), the findings page reads one, the people page reads three
        // plus one open turn read per agent, and the metrics page is its two
        // statements.
        const expected: Record<string, number> = { "/": 3, "/people": 5, "/findings": 1, "/metrics": 2 };
        expect(lines.length, `${path} issued:\n${lines.join("\n")}`).toBe(expected[path]);
      }

      // The seam saw reading verbs and nothing else. It throws on every acting
      // one, so a board that called one would have failed the fetch above with
      // the verb named.
      expect(recorder.verbs().every((verb) => ["available", "list", "memory", "show", "unitFiles"].includes(verb))).toBe(
        true,
      );
      expect(recorder.calls.filter((call) => ["install", "remove", "start", "stop", "restart"].includes(call.verb))).toEqual(
        [],
      );
      // And nothing was asked about the other machine, whose state is not
      // reachable from here at all.
      expect(recorder.calls.filter((call) => call.argument === THERE_ENTRY.id)).toEqual([]);

      // THE FINDINGS PAGE DOES NOT RUN `check`. `runCheck` writes the sheet and
      // opens every credential, so it is not a read, and the statements it
      // issues are not among the one this page issued.
      const watch = await statementWatch(cluster, [await it.read.pid()]);
      await bodyOf(board, "/findings");
      const said = await watch.lines();
      expect(said.some((line) => /pg_control_system|pg_stat_activity|ledger_event/.test(line))).toBe(false);
      expect(said.some((line) => /insert into|update |delete from/i.test(line))).toBe(false);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the machines page is this machine live and the other machine from its own sheet, with the peak beside the limit",
  async () => {
    const staged = await stage();
    try {
      const { board, it, seam, recorder } = staged;
      seam.plant(DOOR_ENTRY.id, true);
      seam.plant(RUNNER_ENTRY.id, true);
      seam.plant(HUB_ENTRY.id, true);

      // The other machine's rows come from that machine's own `check` sheet,
      // with the sheet's own time beside them, because nothing here can ask its
      // manager anything.
      await plantFinding(it, {
        machine: THERE,
        kind: "unit-missing",
        subject: THERE_ENTRY.id,
        says: `${THERE_ENTRY.id} is on the registry's list and the service manager is not running it`,
        fix: "start it there",
      });
      await plantFinding(it, {
        machine: THERE,
        kind: "crash-loop",
        subject: THERE_ENTRY.id,
        says: `${THERE_ENTRY.id} has been started again 4 times`,
        fix: "reset it there",
      });
      await it.read.sql(
        `insert into state_row (sheet, id, data) values ('memory_peak', $1, $2)
           on conflict (sheet, id) do update set data = excluded.data`,
        [RUNNER_ENTRY.id, { bytes: 456_123_000, at: new Date().toISOString(), how: "vmhwm", machine: HERE, pid: 4242 }],
      );

      const text = await bodyOf(board, "/");

      // This machine, live, and the same answer `readStatus` gives when it is
      // asked directly, so the page cannot be reading something else.
      const status = await readStatus({ registryFile: it.registryFile, machine: HERE, os: recorder.os });
      for (const row of status) {
        expect(text).toContain(row.id);
        expect(text, `${row.id} should carry its wanted state`).toMatch(
          new RegExp(`${row.id}[\\s\\S]{0,400}?${row.wanted}`),
        );
      }
      expect(status.find((row) => row.id === RUNNER_ENTRY.id)).toMatchObject({ wanted: "running", seen: "running" });
      expect(status.find((row) => row.id === STOPPED_ENTRY.id)).toMatchObject({ wanted: "stopped", seen: "stopped" });

      // The other machine, from its sheet, with what the sheet said and when.
      expect(text).toContain(THERE_ENTRY.id);
      expect(text).toContain(`${THERE_ENTRY.id} has been started again 4 times`);
      expect(text).toContain("unit-missing");

      // The peak beside the limit, both by value.
      expect(text).toContain("456123000");
      expect(text).toContain(String(RUNNER_ENTRY.memory_limit_mb));

      // A resident with NO peak row shows the absence rather than a zero,
      // because a zero in a table a person reads is a claim.
      const withoutPeak = new RegExp(`${DOOR_ENTRY.id}[\\s\\S]{0,400}?</tr>`);
      const row = withoutPeak.exec(text)?.[0] ?? "";
      expect(row, "the door's row should be on the page").not.toBe("");
      expect(row).toContain("-");
      expect(row).not.toMatch(/>\s*0\s*</);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the one word on a card is the check sheet's answer and is decided from the sheet alone",
  async () => {
    const staged = await stage();
    try {
      const { board, it } = staged;
      const wordOn = async (agent: string): Promise<string> => {
        const text = await bodyOf(board, "/people");
        const found = new RegExp(`${agent}[\\s\\S]{0,600}?</tr>`).exec(text)?.[0] ?? "";
        expect(found, `${agent} should have a row`).not.toBe("");
        for (const word of [cardBroken("en"), cardWaiting("en"), cardOk("en")]) {
          if (found.includes(`>${word}<`)) return word;
        }
        return `no word at all in: ${found}`;
      };

      // Nothing planted at all: the word is ok.
      expect(await wordOn("p1-lair")).toBe(cardOk("en"));

      // A finding about this person's agent, and the word flips.
      const said = await plantFinding(it, {
        machine: HERE,
        kind: "agent-retry",
        subject: "p1-lair",
        says: "p1-lair is retrying",
        fix: "imprnt hub recover <registry> agent:p1-lair",
      });
      expect(await wordOn("p1-lair")).toBe(cardBroken("en"));
      // And the other person is untouched by it.
      expect(await wordOn("p2-lair")).toBe(cardOk("en"));

      // Removed, and it goes back. The page holds no opinion of its own to
      // remember.
      await removeFinding(it, said);
      expect(await wordOn("p1-lair")).toBe(cardOk("en"));

      // An open turn and no finding is waiting.
      await insertInbound(cluster, it.db, { id: "open-one", body: "a question nobody answered" });
      expect(await wordOn("p1-lair")).toBe(cardWaiting("en"));

      // Both, and broken outranks waiting.
      await plantFinding(it, {
        machine: HERE,
        kind: "agent-retry",
        subject: "p1-lair",
        says: "p1-lair is retrying",
        fix: "imprnt hub recover <registry> agent:p1-lair",
      });
      expect(await wordOn("p1-lair")).toBe(cardBroken("en"));

      // A finding about the person's DOOR is their word too, because a door
      // that cannot be read is a person who is not being answered.
      await removeFinding(it, said);
      await insertInbound(cluster, it.db, { id: "open-two", body: "another question", person: "p2", agent: "p2-lair" });
      expect(await wordOn("p2-lair")).toBe(cardWaiting("en"));
      await plantFinding(it, {
        machine: HERE,
        kind: "chat-unreadable",
        subject: `${DOOR_ENTRY.id}/fixture-chat-2`,
        says: "the chat cannot be read",
        fix: "imprnt hub recover <registry> door:door-fake",
      });
      expect(await wordOn("p2-lair")).toBe(cardBroken("en"));
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the metrics page is readStampMetrics's own answer, cell for cell, and a measure with no data is not a zero",
  async () => {
    const staged = await stage();
    try {
      const { board, it, store } = staged;
      await insertInbound(cluster, it.db, { id: "measured-one", body: "a message that was answered" });
      const now = new Date();
      for (const [kind, offset] of [
        ["received", 0],
        ["acked", 2_000],
        ["started", 4_000],
        ["answered", 9_000],
        ["delivered", 11_000],
      ] as [string, number][]) {
        await it.read.sql(
          `insert into ledger_event (stream, subject, kind, actor, detail, at)
             values ('inbound', 'measured-one', $1, 'door', '{}'::jsonb, $2)`,
          [kind, new Date(now.getTime() + offset).toISOString()],
        );
      }

      // A second person with a message and no stamps beyond its arrival, so the
      // page has a measure with nothing in it to print.
      await insertInbound(cluster, it.db, { id: "measured-none", body: "nothing came of it", person: "p2", agent: "p2-lair" });

      const rows = await readStampMetrics(store, { now: new Date(now.getTime() + 20_000) });
      expect(rows.length).toBeGreaterThan(0);
      const text = await bodyOf(board, "/metrics");
      for (const row of rows) {
        for (const [metric, measure] of Object.entries(row.measures)) {
          if (measure.count === 0) continue;
          expect(text, `${row.scope} ${row.id} ${row.window} ${metric} p50`).toContain(
            String(Math.round(measure.p50_ms ?? 0)),
          );
          expect(text).toContain(String(Math.round(measure.p99_ms ?? 0)));
        }
        expect(text).toContain(row.id);
      }
      // A measure with nothing in it prints the same nothing the command line
      // prints, and never a zero, because a zero is a claim about a duration
      // nobody measured.
      const none = rows.find((row) => row.id === "p2")!;
      expect(Object.values(none.measures).every((measure) => measure.count === 0)).toBe(true);
      expect(text).toContain("-");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a state page carries no conversation, writes nothing, renders every value as text and runs no script",
  async () => {
    const staged = await stage();
    try {
      const { board, it, trees, store } = staged;
      const secret = "the sentence a person typed into their own chat";
      const answered = "the sentence an agent typed back";
      await insertInbound(cluster, it.db, {
        id: "said-one",
        body: secret,
        source: {
          log_id: "1",
          at: new Date().toISOString(),
          from: "p1",
          text: secret,
          door: "door-fake",
          chat: "fixture-chat",
          sender_id: "fixture-sender",
        },
      });
      await it.read.sql(
        `insert into outbox (inbound_id, seq_in_reply, body) values ('said-one', 1, $1)`,
        [answered],
      );

      // A value somebody chose, carrying markup, in three places a page reads.
      const nasty = `<script>alert(1)</script>&"'`;
      await plantFinding(it, {
        machine: HERE,
        kind: "agent-retry",
        subject: nasty,
        says: `${nasty} is retrying`,
        fix: "nothing",
      });

      const digests = {
        state: treeDigest(it.stateDir),
        p1: treeDigest(trees.p1),
        p2: treeDigest(trees.p2),
        registry: treeDigest(dirname(it.registryFile)),
      };

      for (const path of PAGES) {
        const text = await bodyOf(board, path);
        // 8. No page carries the text of anything anybody said.
        expect(text, `${path} carries a planted inbound line`).not.toContain(secret);
        expect(text, `${path} carries a planted outbox line`).not.toContain(answered);
        // 10. Every value is TEXT. The raw sequence appears nowhere and the
        //     escaped one appears where the value belongs.
        expect(text, `${path} rendered a planted value as markup`).not.toContain("<script>alert(1)</script>");
        expect(text).not.toMatch(/<script/i);
        // The group is not decoration: written without it, the pattern spells a
        // family word between two non-word characters and the repository's own
        // information shield reads it as one.
        expect(text).not.toMatch(/\s(on[a-z]+)\s*=/i);
        expect(text).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
      }
      const findings = await bodyOf(board, "/findings");
      expect(findings).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;");

      // 9. The board wrote nothing, anywhere a board could write.
      expect(treeDigest(it.stateDir)).toEqual(digests.state);
      expect(treeDigest(trees.p1)).toEqual(digests.p1);
      expect(treeDigest(trees.p2)).toEqual(digests.p2);
      expect(treeDigest(dirname(it.registryFile))).toEqual(digests.registry);

      // The structural control beside it: no module under `src/board/` even
      // imports a way to write a file, so a build that wrote somewhere this
      // check did not walk is still caught.
      const dir = hubPath("src/board");
      const modules = readdirSync(dir).filter((name) => name.endsWith(".ts"));
      expect(modules.length).toBeGreaterThan(0);
      for (const name of modules) {
        const source = readFileSync(join(dir, name), "utf8");
        for (const writer of ["writeFile", "appendFile", "mkdir", "createWriteStream", "rmSync", "Bun.write", "openSync"]) {
          expect(source, `src/board/${name} reaches for ${writer}`).not.toContain(writer);
        }
      }

      // 11. A path no route claims is the one sentence and nothing else.
      const missing = await board.get("/nothing-of-the-sort");
      expect(missing.status).toBe(404);
      expect((await missing.text()).trim()).toBe(pageMissing("en"));

      expect(store.url).toContain(it.db);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "every page answers on a household with nothing in it at all",
  async () => {
    // The control on the whole file: a build whose pages threw on an empty
    // household would pass everything above and fail here, in the house that
    // has just been installed rather than the one with a person in it.
    const dir = scratchDir("hub-board-empty-");
    mkdirSync(join(dir, "tree"), { recursive: true });
    const staged = await stage({ people: false });
    try {
      for (const path of PAGES) {
        const answer = await staged.board.get(path);
        expect(answer.status, `${path} on an empty household`).toBe(200);
        const text = await answer.text();
        expect(text).toContain("<h1");
        expect(text.length).toBeGreaterThan(0);
      }
      writeFileSync(join(dir, "tree", "nothing.txt"), "", "utf8");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a machine whose service manager does not answer still has a page",
  async () => {
    // A box with no manager to ask is a degraded board and not a dead one: the
    // list, the limits, the other machine's findings and the acts are all still
    // readable, and the columns only the manager could fill print nothing
    // rather than a guess. A container without systemd is exactly this box, and
    // so is a Linux machine whose user manager is not running.
    const staged = await stage();
    let board: ServedBoard | undefined;
    try {
      // The staged board goes first: what is being served here is the same
      // entry with a manager that refuses to answer.
      await staged.board.stop();
      const inner = plantedSeam(FLAVOUR);
      const broken = recordingSeam({
        ...inner.os,
        async show() {
          throw new Error("Executable not found in $PATH");
        },
        async list() {
          throw new Error("Executable not found in $PATH");
        },
      });
      board = await serveBoard({
        registryFile: staged.it.registryFile,
        entryId: staged.boardEntry.id,
        store: staged.store,
        os: broken.os,
        now: () => new Date(),
      });
      const answer = await board.get("/");
      expect(answer.status).toBe(200);
      const text = await answer.text();
      for (const entry of [DOOR_ENTRY, RUNNER_ENTRY, STOPPED_ENTRY]) expect(text).toContain(entry.id);
      expect(text).toContain(String(RUNNER_ENTRY.memory_limit_mb));
      // And the other three pages never asked the manager anything at all.
      for (const path of ["/people", "/findings", "/metrics"]) {
        expect((await board.get(path)).status, path).toBe(200);
      }
    } finally {
      await board?.stop();
      await staged.it.stop();
      await staged.store.close();
    }
  },
  SLOW,
);
