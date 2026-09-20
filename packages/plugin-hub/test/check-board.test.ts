// `check` watches the board with the findings it already has, and opens
// nothing to do it. (RUN-13, SPEC §6, L4, L13)
//
// RUN-13's third piece is watched exactly as the first two. `unit-missing` and
// `unit-extra` from the OS diff, `crash-loop` from the restart counter and
// `peak-missing` for a resident `always` entry all apply to a board entry
// unchanged, and nothing new is needed for any of them. What this file proves
// is that the board travels those shipped paths rather than a path of its own.
//
// `CHECK` NEVER OPENS THE BOARD'S PORT. A read that could start work is not a
// read, and a board page can run `check` itself, so a `check` that fetched a
// page would be a check that could ask for its own work. The listener below is
// real and counts its accepts, and it is proved to count by a deliberate
// connection, so a zero that came from a broken counter fails.
//
// EVERYTHING IS PLANTED AND NOTHING IS SLEPT FOR: `runCheck` is handed its own
// `now`, the credential prober is the fake one so no login is reached, and the
// OS seam is a recording one whose unit list this file writes by hand. Every
// assertion filters to its own finding kinds.
//
// Red reason: behaviour absent. `loadRegistry` refuses `kind = "board"`, so the
// stage's own registry will not load and the first assertion is red at the
// stage. That is a missing loader arm, not a `check` defect.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam, startCluster, statementWatch, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { RunSpec } from "./helpers/registry.ts";
import type { Finding } from "./helpers/finding.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";
import { systemd } from "../src/os/systemd.ts";
import { launchd } from "../src/os/launchd.ts";
import { unitName } from "../src/os/names.ts";
import { resetCommand, startCommand, stopCommand } from "../src/os/diff.ts";
import type { OsSeam, UnitState } from "../src/os/types.ts";

const SLOW = 120_000;
const MACHINE = process.platform === "darwin" ? "mac" : "pi";
const MACHINE_OS = process.platform === "darwin" ? "macos" : "linux";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";
const SUFFIX = FLAVOUR === "systemd" ? ".service" : "";
/** The shipped threshold the crash-loop finding fires at. */
const CRASH_LOOP_RESTARTS = 2;

const scratch: string[] = [];
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({
    settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '" },
  });
});
afterAll(async () => {
  try {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  } finally {
    await cluster?.stop();
  }
});

function ownDir(what: string): string {
  const dir = mkdtempSync(join(tmpdir(), what));
  scratch.push(dir);
  return dir;
}

/** A manager whose listing this file writes by hand and which acts on nothing. */
function plantedOs(unitDir: string) {
  mkdirSync(unitDir, { recursive: true });
  const renderer = FLAVOUR === "systemd" ? systemd({ unitDir }) : launchd({ unitDir });
  const units = new Map<string, UnitState>();
  const calls: { operation: string; target: string }[] = [];
  const unit = (name: string, over: Partial<UnitState> = {}): UnitState => ({
    name,
    loaded: true,
    running: true,
    pid: 4242,
    runs: 1,
    ran: true,
    restarts: 0,
    lastExit: null,
    since: null,
    state: "running",
    result: null,
    ...over,
  });
  const os: OsSeam = {
    flavour: FLAVOUR,
    render: renderer.render,
    async install(files) {
      calls.push({ operation: "install", target: files[0]?.path ?? "" });
      return files.map((file) => file.path);
    },
    async start(id) {
      calls.push({ operation: "start", target: id });
    },
    async stop(id) {
      calls.push({ operation: "stop", target: id });
    },
    async restart(id) {
      calls.push({ operation: "restart", target: id });
    },
    async remove(id) {
      calls.push({ operation: "remove", target: id });
    },
    async list() {
      return [...units.values()];
    },
    async show(id) {
      return units.get(`${unitName(id)}${SUFFIX}`) ?? null;
    },
    async memory() {
      return { current_bytes: 4096, peak_bytes: 8192, source: "ps-rss" };
    },
    async available() {
      return { ok: true, reason: "a manager this check writes by hand" };
    },
  };
  return {
    os,
    calls,
    plant(id: string, over: Partial<UnitState> = {}) {
      const name = `${unitName(id)}${SUFFIX}`;
      units.set(name, unit(name, over));
    },
    plantStray(name: string) {
      units.set(name, unit(name));
    },
    forget(id: string) {
      units.delete(`${unitName(id)}${SUFFIX}`);
    },
    clear() {
      units.clear();
    },
  };
}

const DOOR: RunSpec = {
  id: "door-fake",
  kind: "door",
  machine: MACHINE,
  platform: "fake",
  person: "p1",
  token_file: "/dev/null",
  schedule: "always",
  memory_limit_mb: 192,
};
const RUNNER: RunSpec = {
  id: "runner-test",
  kind: "runner",
  machine: MACHINE,
  schedule: "always",
  memory_limit_mb: 512,
  child_memory_limit_mb: 2048,
};
const HUB: RunSpec = {
  id: "hub-one",
  kind: "hub",
  machine: MACHINE,
  schedule: "always",
  memory_limit_mb: 128,
};
/** A real scheduled job, so the board's absence from the job findings is an observation. */
const JOB: RunSpec = {
  id: "watch-bikes",
  kind: "runner",
  machine: MACHINE,
  schedule: "every 15m",
  memory_limit_mb: 128,
  child_memory_limit_mb: 512,
};
const BOARD = (port: number): RunSpec => ({
  id: "board",
  kind: "board",
  machine: MACHINE,
  schedule: "always",
  memory_limit_mb: 128,
  bind: "127.0.0.1",
  port,
});

const CREDENTIALS = { open: async () => ({ ok: true }), secrets: async () => [] };

async function stage(run: RunSpec[]) {
  return await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [
      { id: MACHINE, os: MACHINE_OS },
      { id: MACHINE === "mac" ? "pi" : "mac", os: MACHINE === "mac" ? "linux" : "macos" },
    ],
    run,
  });
}

type Check = (options: Record<string, unknown>) => Promise<Finding[]>;

test(
  "D-245 the board earns unit-missing, unit-extra, crash-loop and peak-missing exactly as a door does, and nothing when each is satisfied",
  async () => {
    const it = await stage([DOOR, RUNNER, HUB, JOB, BOARD(1)]);
    const store = await superStore(cluster, it.db);
    const os = plantedOs(ownDir("hub-check-board-units-"));
    try {
      const { runCheck } = await seam("src/check/run.ts");
      const check = runCheck as Check;
      const ask = async () =>
        await check({
          machine: MACHINE,
          registryFile: it.registryFile,
          store,
          os: os.os,
          kernel: null,
          credentials: CREDENTIALS,
          now: new Date(),
        });
      const about = (found: Finding[], kind: string) =>
        found.filter((one) => one.kind === kind).map((one) => one.subject);

      // 1. With no unit for it, it is missing, and the fix is the command a
      //    person pastes to start it.
      for (const id of [DOOR.id, RUNNER.id, HUB.id]) os.plant(id);
      let found = await ask();
      expect(about(found, "unit-missing")).toContain("board");
      const missing = found.find((one) => one.kind === "unit-missing" && one.subject === "board")!;
      expect(missing.machine).toBe(MACHINE);
      expect(missing.fix).toBe(startCommand(os.os.flavour, "board"));
      // And the door beside it is not missing, so this is the diff and not a
      // rule about the word "board".
      expect(about(found, "unit-missing")).not.toContain(DOOR.id);

      // With a unit the manager is running, nothing.
      os.plant("board");
      found = await ask();
      expect(about(found, "unit-missing")).not.toContain("board");

      // 2. The two shipped unit findings reach it unchanged. A stray under the
      //    scan prefix that no entry implies is still `unit-extra`, with the
      //    stop command as text.
      os.plantStray(`imprnt-board-of-some-other-version${SUFFIX}`);
      found = await ask();
      const extra = found.find((one) => one.kind === "unit-extra")!;
      expect(extra.subject).toBe(`imprnt-board-of-some-other-version${SUFFIX}`);
      expect(extra.fix).toBe(stopCommand(os.os.flavour, extra.subject));

      // And a board unit the manager has restarted past the threshold is a
      // crash loop, with the command that clears a parked unit.
      os.plant("board", { restarts: CRASH_LOOP_RESTARTS + 1 });
      found = await ask();
      const loop = found.find((one) => one.kind === "crash-loop" && one.subject === "board")!;
      expect(loop).toBeDefined();
      expect(loop.fix).toBe(resetCommand(os.os.flavour, `${unitName("board")}${SUFFIX}`));
      expect(about(found, "crash-loop")).not.toContain(DOOR.id);
      os.plant("board");

      // 3. A resident `always` entry earns a peak until the hub records one.
      found = await ask();
      expect(about(found, "peak-missing")).toContain("board");
      await store.sql`insert into state_row (sheet,id,data) values ('memory_peak','board',${{
        bytes: 33_554_432,
        at: new Date().toISOString(),
        how: "sampled",
        machine: MACHINE,
        pid: null,
      }}) on conflict (sheet,id) do update set data = excluded.data`;
      found = await ask();
      expect(about(found, "peak-missing")).not.toContain("board");

      // 5. The board has no success stamp and no state sheet of its own,
      //    because it is not a scheduled job. Said in a run where a real
      //    scheduled entry DOES earn the finding, so the absence is an
      //    observation rather than a run in which nothing fired.
      expect(about(found, "job-no-stamp")).toContain(JOB.id);
      expect(about(found, "job-no-stamp")).not.toContain("board");
      expect(about(found, "job-stale")).not.toContain("board");
      expect((await it.read.sheet("job_success")).map((row) => row.id)).not.toContain("board");
    } finally {
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "D-245 check opens no connection to the board's port, and the listener is proved to count",
  async () => {
    let accepts = 0;
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        accepts += 1;
        return new Response("a page check must never ask for");
      },
    });
    const port = Number(listener.port);
    const it = await stage([DOOR, RUNNER, HUB, BOARD(port)]);
    const store = await superStore(cluster, it.db);
    const os = plantedOs(ownDir("hub-check-board-port-"));
    try {
      const { runCheck } = await seam("src/check/run.ts");
      const check = runCheck as Check;
      for (const id of [DOOR.id, RUNNER.id, HUB.id, "board"]) os.plant(id);
      const found = await check({
        machine: MACHINE,
        registryFile: it.registryFile,
        store,
        os: os.os,
        kernel: null,
        credentials: CREDENTIALS,
        now: new Date(),
      });
      expect(Array.isArray(found)).toBe(true);
      // 4. A READ THAT COULD START WORK IS NOT A READ. The board's own pages
      //    run `check`, so a `check` that fetched one could ask for its own
      //    work, and the number that says it did not is zero.
      expect(accepts).toBe(0);
      // The control on that zero: the listener counts, proved by connecting to
      // it once from here.
      await fetch(`http://127.0.0.1:${port}/`);
      expect(accepts).toBe(1);
      // And the manager was never acted on either.
      expect(os.calls.filter((call) => call.operation !== "install")).toEqual([]);
    } finally {
      await listener.stop(true);
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "D-245 a whole run over a board entry writes the check sheet and nothing else",
  async () => {
    const it = await stage([DOOR, RUNNER, HUB, BOARD(1)]);
    const store = await superStore(cluster, it.db);
    const os = plantedOs(ownDir("hub-check-board-quiet-"));
    try {
      const { runCheck } = await seam("src/check/run.ts");
      const check = runCheck as Check;
      for (const id of [DOOR.id, RUNNER.id, HUB.id]) os.plant(id);
      // Everything the setup owes is already in the log before the window
      // opens: the reader below is this test's own backend and is excluded.
      const mine = [await it.read.pid()];
      const watch = await statementWatch(cluster, mine);
      await check({
        machine: MACHINE,
        registryFile: it.registryFile,
        store,
        os: os.os,
        kernel: null,
        credentials: CREDENTIALS,
        now: new Date(),
      });
      const lines = await watch.lines();
      // 6. `check-silence` holds by construction here: nothing in the board's
      //    watching writes anything but the `check` sheet.
      const writes = lines.filter((line) => /\b(insert|update|delete)\b/i.test(line));
      expect(writes.length).toBeGreaterThan(0);
      for (const line of writes) {
        expect(line, `a write outside the check sheet: ${line}`).toMatch(/state_row/i);
      }
      expect(
        (await it.read.sheet("check")).some((row) => String(row.id).endsWith(":board")),
        "the run must have written a row about the board, or the window above proves nothing",
      ).toBe(true);
    } finally {
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test("D-245 a wildcard bind is refused by the loader, so check never sees it", async () => {
  // 7. There is nothing left for `check` to report about a wildcard bind,
  //    because the file carrying one does not load at all.
  const it = await stage([DOOR, RUNNER, HUB, { ...BOARD(8794), bind: "0.0.0.0" }]).catch(
    (error: unknown) => error,
  );
  if (it instanceof Error) {
    expect(it).toBeInstanceOf(RegistryRefused);
    expect((it as RegistryRefused).key).toBe("run[3].bind");
    return;
  }
  const staged = it as Awaited<ReturnType<typeof stage>>;
  const store = await superStore(cluster, staged.db);
  const os = plantedOs(ownDir("hub-check-board-wildcard-"));
  try {
    const { runCheck } = await seam("src/check/run.ts");
    const check = runCheck as Check;
    let caught: unknown;
    try {
      await check({
        machine: MACHINE,
        registryFile: staged.registryFile,
        store,
        os: os.os,
        kernel: null,
        credentials: CREDENTIALS,
        now: new Date(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryRefused);
    expect((caught as RegistryRefused).key).toBe("run[3].bind");
    expect((caught as RegistryRefused).reason).toBe(
      "board binds to 0.0.0.0, and a board listens on one specific address, never a wildcard.",
    );
  } finally {
    await store.close();
    await staged.stop();
  }
});

test(
  "D-245 the same registry with no board entry reports nothing about one, and every shipped finding is unchanged",
  async () => {
    // The control on the whole file. Two runs over the same planted manager,
    // one with a board entry and one without, and the difference is the board
    // and nothing else.
    const withOne = await stage([DOOR, RUNNER, HUB, JOB, BOARD(1)]);
    const without = await stage([DOOR, RUNNER, HUB, JOB]);
    const a = await superStore(cluster, withOne.db);
    const b = await superStore(cluster, without.db);
    try {
      const { runCheck } = await seam("src/check/run.ts");
      const check = runCheck as Check;
      const now = new Date();
      const run = async (
        registryFile: string,
        store: unknown,
        os: ReturnType<typeof plantedOs>,
      ) => {
        for (const id of [DOOR.id, RUNNER.id, HUB.id]) os.plant(id);
        return await check({
          machine: MACHINE,
          registryFile,
          store,
          os: os.os,
          kernel: null,
          credentials: CREDENTIALS,
          now,
        });
      };
      // Each stage writes its own registry, and a fix that names the file would
      // differ for that reason alone, so the path is taken out of both.
      const shape = (found: Finding[], registryFile: string) =>
        found
          .filter((one) => one.subject !== "board")
          .map((one) => `${one.kind}:${one.subject}:${one.fix}`.replaceAll(registryFile, "<the registry>"))
          .sort();

      const one = await run(withOne.registryFile, a, plantedOs(ownDir("hub-check-board-with-")));
      const none = await run(without.registryFile, b, plantedOs(ownDir("hub-check-board-without-")));

      expect(none.filter((finding) => finding.subject === "board")).toEqual([]);
      expect(none.some((finding) => /board/.test(finding.says))).toBe(false);
      expect(one.some((finding) => finding.subject === "board")).toBe(true);
      expect(shape(one, withOne.registryFile)).toEqual(shape(none, without.registryFile));
    } finally {
      await a.close();
      await b.close();
      await withOne.stop();
      await without.stop();
    }
  },
  SLOW,
);
