// The registry shape this phase adds costs the shipped windows nothing.
// (SPEC §2)
//
// WHAT THIS FILE IS. It does not copy the six protected windows and it does not
// re-derive them: they run as themselves, in the same batch, and they are the
// authority on their own bounds. What is new here is ONE registry shape, loaded
// all at once, that none of them stages: a board entry, an entry the file
// stopped, and an agent whose door is on one machine and whose runner is on
// another. So this file loads that shape, runs a door and a runner under it
// with a board up beside them, and measures the same two things the shipped
// windows measure, with the board ABSENT as the control and both numbers
// printed.
//
// THE FIRST ASSERTION IS THE ONE THAT MATTERS MOST and it is not a measurement:
// the six files are byte-unchanged, and the digests below were taken from the
// commit this branch grew from rather than from the working tree, so a bound
// this phase relaxed anywhere in its own history is caught here.
//
// WHICH ASSERTIONS ARE TRIVIALLY GREEN WITHOUT A BOARD, so nobody reads a green
// window as evidence: the six digests, and the last test, whose finding and
// whose registry shape are the loader's and the check's rather than the board
// process's. The measurements in between are the ones that need it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hubPath,
  startCluster,
  startReadySubprocess,
  statementWatch,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { CHAT, DOOR, PERSON, PERSON2, RUNNER, stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import { cpuSeconds } from "./helpers/cpu.ts";
import { freePort, plantedSeam } from "./helpers/board.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { runCheck, CHECK_SHEET } from "../src/check/run.ts";

const SLOW = 180_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const THERE = HERE === "mac" ? "pi" : "mac";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const THERE_OS = HERE_OS === "macos" ? "linux" : "macos";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";

/** The shipped idle window and its bound, `test/wait-idle.test.ts`'s own. */
const WINDOW_MS = 3_000;
const BOUND_SECONDS = 0.3;

/**
 * The six windows, by content, as they stand in the commit this branch grew
 * from. A digest read off the working tree could only catch a change made after
 * this file was written, which is not what the promise is about.
 */
const WINDOWS: Record<string, string> = {
  "test/door-typing.test.ts": "26bf5dfd5068c8ab1a5c3287fd3b9c7f53d021d1c60d678852c7f409c683a1e9",
  "test/door-outbox.test.ts": "019b343c1affd068ef5b37adda3bdb065081bda083a8262b51d10a4d3afc5be9",
  "test/door-clock.test.ts": "bacd4b48bac4b2755876a78c82aa7631f1704b3d1a945e783ef792fc303b605a",
  "test/runner-drain.test.ts": "e8a8a14e7a1025a12624915a0e1b8a90691d1af9c96a1c1e45ad8536841c93f8",
  "test/wait-idle.test.ts": "30905f0bc010ee9f10e275d4d5e0c51eded16951700583888ac4acb52897fc39",
  "test/check-silence.test.ts": "5d2007df83b96ccc61b472507537b9e7b90fa688d65e2ea34260d5af51a22c67",
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

test("the six protected windows are byte-unchanged", () => {
  for (const [path, digest] of Object.entries(WINDOWS)) {
    const bytes = readFileSync(hubPath(path));
    expect(createHash("sha256").update(bytes).digest("hex"), `${path} changed`).toBe(digest);
  }
});

const BOARD: RunSpec = {
  id: "board",
  kind: "board",
  machine: HERE,
  schedule: "always",
  memory_limit_mb: 128,
  bind: "127.0.0.1",
  port: 0,
};

/** Two machines, a board, an entry the file stopped, and a cross-machine agent. */
async function stage(): Promise<{ it: StagedHub; board: RunSpec }> {
  const trees = [PERSON, PERSON2].map((who) => {
    const dir = mkdtempSync(join(tmpdir(), `hub-windows-${who}-`));
    scratch.push(dir);
    return { id: who, tree: dir };
  });
  const board = { ...BOARD, port: await freePort() };
  const it = await stageHub(cluster, {
    servers: true,
    hub: { tick_seconds: 1 },
    machines: [
      { id: HERE, os: HERE_OS },
      { id: THERE, os: THERE_OS },
    ],
    people: trees,
    agents: [
      {
        id: "p2-lair",
        person: PERSON2,
        preset: "daily",
        chat: `${CHAT}1`,
        door: DOOR,
        runner: "runner-there",
      },
    ],
    run: [
      {
        id: DOOR,
        kind: "door",
        machine: HERE,
        platform: "fake",
        person: PERSON,
        token_file: "/dev/null",
        schedule: "always",
        memory_limit_mb: 192,
      },
      {
        id: RUNNER,
        kind: "runner",
        machine: HERE,
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 2048,
      },
      // The runner of the cross-machine agent, on the other machine.
      {
        id: "runner-there",
        kind: "runner",
        machine: THERE,
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 2048,
      },
      // The entry the household stopped.
      {
        id: "watch-bikes",
        kind: "runner",
        machine: HERE,
        schedule: "every 15m",
        memory_limit_mb: 128,
        child_memory_limit_mb: 512,
        enabled: false,
      },
      board,
    ],
  });
  await Bun.write(
    it.registryFile,
    (await Bun.file(it.registryFile).text()).replaceAll(
      "[[people]]",
      '[[people]]\nallowed_senders = { "door-fake" = ["fixture-sender"] }',
    ),
  );
  return { it, board };
}

interface BoardProcess {
  pid: number;
  url: string;
  stop(): Promise<void>;
}

async function startBoard(it: StagedHub, entry: RunSpec): Promise<BoardProcess> {
  const proc = Bun.spawn(
    [process.execPath, "run", hubPath("src/entry/board.ts"), it.registryFile, entry.id],
    { cwd: hubPath("."), stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const url = `http://${entry.bind}:${entry.port}`;
  const errors = new Response(proc.stderr).text();
  await until(
    "the board answered its first page",
    async () => {
      if (proc.exitCode !== null) throw new Error(`the board exited: ${(await errors).slice(0, 400)}`);
      try {
        return (await fetch(`${url}/`)).status === 200;
      } catch {
        return false;
      }
    },
    30_000,
    async () => `The board said: ${(await errors).slice(0, 600)}`,
  );
  return {
    pid: proc.pid,
    url,
    async stop() {
      try {
        proc.kill(15);
      } catch {
        // already gone
      }
      await proc.exited.catch(() => {});
    },
  };
}

test(
  "a door and a runner under this phase's registry cost what they cost with a board beside them and with none",
  async () => {
    const { it, board: entry } = await stage();
    let door: ReadyProcess | null = null;
    let runner: ReadyProcess | null = null;
    let board: BoardProcess | null = null;
    const busy = Bun.spawn(
      [
        process.execPath,
        "-e",
        "setInterval(() => { let s = 0; for (let i = 0; i < 6e7; i++) s += i; globalThis.__sink = s; }, 100); setInterval(() => {}, 1e9);",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    const counter = cluster.connect(it.db) as unknown as {
      unsafe(query: string): Promise<unknown>;
      close(): Promise<void>;
    };
    try {
      door = await startReadySubprocess("test/helpers/door-subprocess.ts", [
        it.registryFile,
        DOOR,
        it.platformUrl,
      ]);
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);
      await counter.unsafe("select 1 as warm");

      /**
       * One window: what the pair issued, what the board issued beside them,
       * and what each of them burned.
       *
       * THE PAIR'S STATEMENT COUNT IS PRINTED AND NOT BOUNDED. A door and a
       * runner with nothing to do are not silent: the runner keeps a claim on
       * the bound it reads, which is the behaviour `test/wait-idle.test.ts`
       * says in its own closing note it went back to. What IS bounded is the
       * board's own count, which is the difference between the two watches
       * below, opened over the same window and reading the same log.
       */
      const measure = async (boardPids: number[]) => {
        const everything = await statementWatch(cluster, [await it.read.pid()]);
        const watch = await statementWatch(cluster, [await it.read.pid(), ...boardPids]);
        const before = {
          door: cpuSeconds(door!.pid),
          runner: cpuSeconds(runner!.pid),
          busy: cpuSeconds(busy.pid),
        };
        expect(before.door).not.toBeNull();
        expect(before.runner).not.toBeNull();
        await Bun.sleep(WINDOW_MS);
        await counter.unsafe("select 'the deliberate statement' as said");
        const after = {
          door: cpuSeconds(door!.pid),
          runner: cpuSeconds(runner!.pid),
          busy: cpuSeconds(busy.pid),
        };
        expect(after.door).not.toBeNull();
        expect(after.runner).not.toBeNull();
        const seen = await watch.lines();
        return {
          statements: seen,
          board: (await everything.lines()).length - seen.length,
          door: after.door! - before.door!,
          runner: after.runner! - before.runner!,
          busy: after.busy! - before.busy!,
        };
      };

      // With no board, which is the shape every shipped window already runs in.
      const alone = await measure([]);

      board = await startBoard(it, entry);
      await fetch(`${board.url}/`);
      // The board's own backend is excluded by pid, exactly as the shipped
      // windows exclude the test's, because what is being measured is the door
      // and the runner.
      const backends = (await it.read.sql(
        `select pid from pg_stat_activity where datname = current_database() and application_name = $1`,
        [entry.id],
      )) as { pid: number }[];
      expect(backends.length).toBeGreaterThan(0);
      const beside = await measure(backends.map((row) => Number(row.pid)));

      process.stderr.write(
        `[board-windows] door ${alone.door.toFixed(3)} s alone, ${beside.door.toFixed(3)} s with a board. ` +
          `runner ${alone.runner.toFixed(3)} s alone, ${beside.runner.toFixed(3)} s with a board. ` +
          `the pair issued ${alone.statements.length} statements alone and ${beside.statements.length} with a board, ` +
          `and the board itself issued ${beside.board}.\n`,
      );

      // The control first: the probe can see a process that really spins.
      expect(alone.busy).toBeGreaterThan(BOUND_SECONDS);
      expect(beside.busy).toBeGreaterThan(BOUND_SECONDS);
      // The counter, proved inside each window: a window that counted nothing
      // because its counter was unwired fails here.
      for (const window of [alone, beside]) {
        expect(window.statements.some((line) => line.includes("the deliberate statement"))).toBe(true);
      }
      // A board up beside them asks the store nothing of its own between
      // requests, so the two watches over one window see the same statements.
      expect(beside.board, "the board issued statements while nobody was looking").toBe(0);

      for (const [what, burned] of [
        ["the door alone", alone.door],
        ["the runner alone", alone.runner],
        ["the door with a board", beside.door],
        ["the runner with a board", beside.runner],
      ] as [string, number][]) {
        expect(burned, `${what} burned ${burned} s`).toBeLessThan(BOUND_SECONDS);
      }
    } finally {
      busy.kill(9);
      await busy.exited.catch(() => {});
      await counter.close().catch(() => {});
      await board?.stop();
      await runner?.stop();
      await door?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "check over this registry writes its own sheet and nothing else, with the stopped entry among its findings",
  async () => {
    const { it } = await stage();
    const store = await superStore(cluster, it.db);
    const seam = plantedSeam(FLAVOUR);
    try {
      // The manager is still running the entry the file stopped, which is the
      // one finding this phase adds.
      seam.plant("watch-bikes", true);
      const ledgerBefore = await it.read.ledger();
      const sheetsBefore = (await it.read.sql(
        `select sheet, count(*)::int as n from state_row where sheet <> $1 group by sheet order by sheet`,
        [CHECK_SHEET],
      )) as Record<string, unknown>[];

      const findings = await runCheck({
        machine: HERE,
        registryFile: it.registryFile,
        store,
        os: seam.os,
        kernel: null,
        credentials: { open: async () => ({ ok: true }), secrets: async () => [] },
        now: new Date(),
      });
      expect(findings.some((one) => one.kind === "unit-not-stopped" && one.subject === "watch-bikes")).toBe(true);

      expect((await it.read.ledger()).length).toBe(ledgerBefore.length);
      const sheetsAfter = (await it.read.sql(
        `select sheet, count(*)::int as n from state_row where sheet <> $1 group by sheet order by sheet`,
        [CHECK_SHEET],
      )) as Record<string, unknown>[];
      expect(sheetsAfter).toEqual(sheetsBefore);
      expect((await it.read.sheet(CHECK_SHEET)).length).toBeGreaterThan(0);
    } finally {
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);
