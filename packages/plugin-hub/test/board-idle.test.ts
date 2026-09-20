// A board nobody is looking at is asleep, and a view costs what its readers
// cost. (SPEC §1, §2)
//
// A REFRESH IS A PERSON'S TAP. There is no timer, no `LISTEN`, no auto-refresh
// in the page and no script on it that could ask for one, so a phone left open
// overnight costs nothing after its last render. The board holds its store
// handle open, which issues no statement, and `Bun.serve` sleeps on accept.
//
// THIS FILE IS NEW AND BORROWS THE HARNESS. `test/wait-idle.test.ts` is one of
// the six windows this phase stays outside of, so its window length and its
// bound are copied here as values rather than imported: a test file exports
// nothing, and editing it to export a constant would be the edit this phase
// promised not to make. Both numbers are that file's own.
//
// THE CONTROL IS WHAT MAKES IT A CHECK. A pair of assertions that only ever
// says "this process is quiet" cannot fail on a box where the reader is broken,
// so a process that really does spin is measured in the SAME window with the
// SAME reader and must come out over the bound, and one deliberate statement is
// issued inside every window the counter is trusted in.
//
// THE BOARD IS A SUBPROCESS HERE, and it is the real program the operating
// system starts rather than a handle in this runtime: processor time is a
// question about a process, and an in-process server's is the test runner's.
//
// `check now` is deliberately NOT pressed in any of it. It is the one act with
// a cost and it runs when a person presses it.
//
// Red reason: behaviour absent, in the honest sense. Before the build there is
// no board process to measure, so this file is red at the start rather than on
// an assertion.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath, startCluster, statementWatch, until, type Cluster } from "./helpers/cluster.ts";
import { stageHub, type StagedHub } from "./helpers/hub-fixture.ts";
import { cpuSeconds } from "./helpers/cpu.ts";
import { freePort } from "./helpers/board.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { boardBindFailed } from "../src/door/lines.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const PAGES = ["/", "/people", "/findings", "/metrics"] as const;

/** The shipped idle window and its bound, both `test/wait-idle.test.ts`'s own. */
const WINDOW_MS = 3_000;
const BOUND_SECONDS = 0.3;

/**
 * An address in the documentation range, which no box on any network this
 * household has holds. A tailnet-shaped one would really be bound on a Mac
 * that is on the tailnet, and the assertion below would be about nothing.
 */
const NOT_HELD_HERE = "192.0.2.1";

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

async function stage(bind = "127.0.0.1"): Promise<{ it: StagedHub; entry: RunSpec }> {
  const tree = mkdtempSync(join(tmpdir(), "hub-idle-tree-"));
  scratch.push(tree);
  const entry: RunSpec = {
    id: "board",
    kind: "board",
    machine: HERE,
    schedule: "always",
    memory_limit_mb: 128,
    bind,
    port: await freePort(),
  };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: HERE, os: HERE_OS }],
    people: [{ id: "p1", tree }],
    run: [DOOR_ENTRY, RUNNER_ENTRY, entry],
  });
  return { it, entry };
}

interface BoardProcess {
  proc: ReturnType<typeof Bun.spawn>;
  pid: number;
  url: string;
  said(): Promise<string>;
  stop(): Promise<void>;
}

/** The real program, started the way the service manager starts it. */
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
      if (proc.exitCode !== null) {
        throw new Error(`the board exited ${proc.exitCode}: ${(await errors).slice(0, 400)}`);
      }
      try {
        return (await fetch(`${url}/`, { redirect: "manual" })).status === 200;
      } catch {
        return false;
      }
    },
    30_000,
  );
  return {
    proc,
    pid: proc.pid,
    url,
    said: () => errors,
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
  "a board up with nobody looking issues no statement at all and burns no processor time, while a process that really polls is over the bound in the same window",
  async () => {
    const { it, entry } = await stage();
    let board: BoardProcess | null = null;
    // The control: a process that wakes ten times a second and does work each
    // time. It is what proves the reader can see a poll at all.
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
      board = await startBoard(it, entry);
      // One page fetched, so what is measured is a board that has rendered and
      // is waiting rather than one that has not opened its store yet.
      for (const path of PAGES) expect((await fetch(`${board.url}${path}`)).status).toBe(200);
      // The counter's own connection is opened and used BEFORE the window, so
      // what it costs inside the window is one statement and nothing else.
      await counter.unsafe("select 1 as warm");

      const watch = await statementWatch(cluster, [await it.read.pid()]);
      const before = { board: cpuSeconds(board.pid), busy: cpuSeconds(busy.pid) };
      // A reading of null is a process that is gone, and a check that read it
      // as zero would score a crashed board as a quiet one.
      expect(before.board).not.toBeNull();
      expect(before.busy).not.toBeNull();

      await Bun.sleep(WINDOW_MS);
      // The counter, inside the window, so a window that counted nothing
      // because its counter was unwired fails here.
      await counter.unsafe("select 'the deliberate statement' as said");

      const after = { board: cpuSeconds(board.pid), busy: cpuSeconds(busy.pid) };
      expect(after.board).not.toBeNull();
      expect(after.busy).not.toBeNull();
      const burned = {
        board: after.board! - before.board!,
        busy: after.busy! - before.busy!,
      };
      // The control first, so a broken probe fails here rather than reporting a
      // beautifully quiet process it cannot actually read.
      expect(burned.busy).toBeGreaterThan(BOUND_SECONDS);
      expect(burned.board).toBeLessThan(BOUND_SECONDS);

      const lines = await watch.lines();
      expect(lines, `the board issued:\n${lines.join("\n")}`).toHaveLength(1);
      expect(lines[0]).toContain("the deliberate statement");

      // It is still there AND it is silent, which are two facts: a process that
      // had disconnected would be silent too.
      const present = (await it.read.sql(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and application_name = $1`,
        [entry.id],
      )) as { n: number }[];
      expect(Number(present[0].n)).toBeGreaterThan(0);
      expect(cpuSeconds(board.pid)).not.toBeNull();
    } finally {
      busy.kill(9);
      await busy.exited.catch(() => {});
      await counter.close().catch(() => {});
      await board?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a sweep of the four pages issues only selects, and a client that keeps its socket open adds nothing after its render",
  async () => {
    const { it, entry } = await stage();
    let board: BoardProcess | null = null;
    const counter = cluster.connect(it.db) as unknown as {
      unsafe(query: string): Promise<unknown>;
      close(): Promise<void>;
    };
    try {
      board = await startBoard(it, entry);
      for (const path of PAGES) await fetch(`${board.url}${path}`);
      await counter.unsafe("select 1 as warm");

      const sweep = await statementWatch(cluster, [await it.read.pid()]);
      for (const path of PAGES) expect((await fetch(`${board.url}${path}`)).status).toBe(200);
      await counter.unsafe("select 'the deliberate statement' as said");
      const lines = await sweep.lines();
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(
          /\b(insert|update|delete)\b/i.test(line),
          `a page view wrote something:\n${lines.join("\n")}`,
        ).toBe(false);
      }

      // A phone-shaped client: one render, then the socket held open for the
      // window. Nothing on the page runs, so nothing follows the render.
      const held = await new Promise<{ close(): void }>((resolve, reject) => {
        let answered = false;
        Bun.connect({
          hostname: String(entry.bind),
          port: Number(entry.port),
          socket: {
            open(socket) {
              socket.write(
                `GET / HTTP/1.1\r\nHost: ${entry.bind}:${entry.port}\r\nConnection: keep-alive\r\n\r\n`,
              );
            },
            data(socket, chunk) {
              if (answered) return;
              if (new TextDecoder().decode(chunk).includes("</html>")) {
                answered = true;
                resolve({ close: () => socket.end() });
              }
            },
            error(_socket, error) {
              reject(error);
            },
          },
        }).catch(reject);
      });
      const quiet = await statementWatch(cluster, [await it.read.pid()]);
      await Bun.sleep(WINDOW_MS);
      await counter.unsafe("select 'the deliberate statement' as said");
      const after = await quiet.lines();
      expect(after, `an open socket cost:\n${after.join("\n")}`).toHaveLength(1);
      held.close();
    } finally {
      await counter.close().catch(() => {});
      await board?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a bind this machine does not hold kills the process with the cause named, and opens no port at all",
  async () => {
    const { it, entry } = await stage(NOT_HELD_HERE);
    try {
      const proc = Bun.spawn(
        [process.execPath, "run", hubPath("src/entry/board.ts"), it.registryFile, entry.id],
        { cwd: hubPath("."), stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      );
      const said = await new Response(proc.stderr).text();
      const code = await proc.exited;
      expect(code).not.toBe(0);
      // The line, compared whole against the pinned sentence, with whatever the
      // runtime called the failure.
      const cause = /cannot listen on [^:]+:\d+: (.*)\.$/m.exec(said.trim())?.[1] ?? "";
      expect(cause, `the board said:\n${said.slice(0, 600)}`).not.toBe("");
      expect(said).toContain(boardBindFailed("en", { bind: entry.bind, port: entry.port, cause }));

      // AND IT FELL BACK TO NOTHING. There is no retry loop of the board's own
      // either: the service manager is the retry loop, and `check` shows the
      // result as a crash loop or a missing unit.
      await expect(
        Bun.connect({
          hostname: "127.0.0.1",
          port: Number(entry.port),
          socket: { data() {}, open(socket) { socket.end(); } },
        }),
      ).rejects.toThrow();
    } finally {
      await it.stop();
    }
  },
  SLOW,
);

test(
  "the same registry with a bind this machine does hold starts and answers",
  async () => {
    // The control on the assertion above: what killed the process was the
    // address and not the program.
    const { it, entry } = await stage();
    let board: BoardProcess | null = null;
    try {
      board = await startBoard(it, entry);
      expect((await fetch(`${board.url}/`)).status).toBe(200);
    } finally {
      await board?.stop();
      await it.stop();
    }
  },
  SLOW,
);
