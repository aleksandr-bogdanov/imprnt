// A board unit installed, loaded and taken off again through the REAL service
// manager, and `check` run against the same one. (RUN-05, RUN-13, SPEC §6)
//
// THIS IS THE ROW NO FAKED SEAM CAN CLOSE. Every other board check drives a
// manager a check wrote, which answers whatever it was planted with. What is
// asserted here is what the box's own manager says: the unit file it read, the
// argv it carries, the process it started, the page that process answers, and
// the emptiness it reports once the unit has been removed.
//
// GATED TO THE OPERATING SYSTEM IT IS FOR, with a visible skip on the other
// naming the one it wanted, in the test name and on stderr. A skip closes no
// gate, which is the sentence the phase's inventory enforces.
//
// EVERY NAME CARRIES A RUN-TIME RANDOM SUFFIX and is removed in a `finally`,
// because this box runs the household's own units out of the same place. The
// census of units this file did not create is read before and after and must be
// identical, so "it disturbed nothing" is proved rather than promised. And
// every install is preceded by an assertion that the manager does NOT already
// carry that name, so a leftover from a crashed run is a failure and not a
// pass.
//
// WHAT IS RESTATED HERE RATHER THAN OWNED. The bind that fails and the exit it
// makes are owned by the idle check, which runs on both operating systems
// against a socket. This file restates it against a real socket on this one,
// which is the gated half of the same clause.
//
// Red reason: behaviour absent for whatever the faked seams could not reach.
// This is the one place a manager's own answers are compared with the ones a
// check planted.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { hubPath, seam, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import { announceGate, gateSuffix, osGate, thisMachine } from "./helpers/os-gate.ts";
import { pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { freePort, setOnEntry } from "./helpers/board.ts";
import type { RunSpec } from "./helpers/registry.ts";
import type { OsSeam } from "../src/os/types.ts";
import type { Finding } from "./helpers/finding.ts";
import { programForKind } from "../src/hub/program.ts";
import { readStatus } from "../src/hub/status.ts";
import { unitName } from "../src/os/names.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { loadRegistry, type RunEntry } from "../src/registry/load.ts";
import { boardBindFailed } from "../src/door/lines.ts";

const SLOW = 180_000;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
const MACHINE = thisMachine();
const CREDENTIALS = { open: async () => ({ ok: true }), secrets: async () => [] };

/**
 * An address in the documentation range, which no box on any network this
 * household has holds.
 */
const NOT_HELD_HERE = "192.0.2.1";

let cluster: Cluster;
let foreignBefore: string[] = [];

beforeAll(async () => {
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
  announceGate(gate, "the board against the real service manager");
  process.stderr.write(
    `[board-native] the ${process.platform === "darwin" ? "launchd" : "systemd"} half runs here and the other prints its skip\n`,
  );
  cluster = await startCluster();
});

afterAll(async () => {
  try {
    await fixture.removeAll();
  } finally {
    try {
      if (gate.ok) {
        const after = (await fixture.listWatched()).sort();
        if (JSON.stringify(after) !== JSON.stringify(foreignBefore)) {
          throw new Error(
            `this file disturbed the box: watch-prefix units were\n${foreignBefore.join(", ")}\nand are now\n${after.join(", ")}`,
          );
        }
      }
    } finally {
      await cluster?.stop();
    }
  }
});

/** The reason a half that is not for this platform prints beside its skip. */
function wants(platform: "darwin" | "linux"): string {
  if (!gate.ok) return gateSuffix(gate);
  if (process.platform === platform) return "";
  const wanted = platform === "darwin" ? "macos" : "linux";
  return ` [skipped: this half wants ${wanted} and this box is ${process.platform}]`;
}

const here = (platform: "darwin" | "linux") => !gate.ok || process.platform !== platform;

interface Board {
  it: StagedHub;
  entry: RunEntry;
  entryId: string;
  /** The runner declared beside it, which is the piece a household may stop. */
  runner: RunEntry;
  runnerId: string;
  os: OsSeam;
  context: Record<string, unknown>;
  argv: string[];
}

/**
 * A household with one board, under a name nothing else on this box can hold.
 *
 * The registry is a real one on a real store, because the unit's `ExecStart`
 * names the real program and a board that could not open a store would tell us
 * nothing about the manager.
 */
async function stageBoard(options: { bind?: string; stopped?: boolean } = {}): Promise<Board> {
  const entryId = fixture.entryId("board");
  // A name of this run's own, because a unit this check installs into the real
  // manager must not collide with one another run left behind.
  const runnerId = fixture.entryId("runner");
  const boardEntry: RunSpec = {
    id: entryId,
    kind: "board",
    machine: MACHINE.id,
    schedule: "always",
    memory_limit_mb: 128,
    bind: options.bind ?? "127.0.0.1",
    port: await freePort(),
  };
  const it = await stageHub(cluster, {
    machines: [MACHINE],
    run: [
      {
        id: runnerId,
        kind: "runner",
        machine: MACHINE.id,
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 2048,
      },
      boardEntry,
    ],
  });
  // THE STOPPED ENTRY IS THE RUNNER AND NOT THE BOARD. The file refuses a
  // stopped board, because a stopped board cannot offer the start that would
  // bring it back, so the state this check is about is asked of the piece a
  // household really does stop.
  if (options.stopped) setOnEntry(it.registryFile, runnerId, "enabled", "false");
  const { thisOs } = await seam("src/os/index.ts");
  const os = (thisOs as Function)({ unitDir: fixture.unitDir() }) as OsSeam;
  const entry = listRunEntries(loadRegistry(it.registryFile)).find((one) => one.id === entryId)!;
  const context = {
    machine: MACHINE.id,
    execPath: process.execPath,
    entryScript: programForKind("board"),
    registryFile: it.registryFile,
    restartDelaySeconds: 1,
    giveUpAfter: 5,
    giveUpWindowSeconds: 300,
  };
  return {
    it,
    entry,
    entryId,
    runnerId,
    runner: listRunEntries(loadRegistry(it.registryFile)).find((one) => one.id === runnerId)!,
    os,
    context,
    argv: [process.execPath, "run", programForKind("board"), it.registryFile, entryId],
  };
}

/** What the manager itself says about a unit, in its own words. */
async function managerSays(id: string): Promise<string> {
  const label = unitName(id);
  const argv =
    process.platform === "darwin"
      ? ["launchctl", "print", `gui/${process.getuid?.() ?? 0}/${label}`]
      : ["systemctl", "--user", "cat", `${label}.service`];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return `${out}\n${err}`;
}

/** Whether the manager carries anything at all under this name. */
async function carried(id: string): Promise<boolean> {
  const label = unitName(id);
  return (await fixture.listWatched()).some((one) => one === label || one.startsWith(`${label}.`));
}

/** Every file in the fixture's unit directory whose name begins with this one. */
function filesFor(id: string): string[] {
  const label = unitName(id);
  return readdirSync(fixture.unitDir()).filter((one) => one.startsWith(label));
}

test.skipIf(!gate.ok)(
  `RUN-05 the program a board unit names is really there, and the unit installs, loads, answers on its own address and comes off again through the real service manager${gateSuffix(gate)}`,
  async () => {
    // --- 1. A unit whose `ExecStart` points at a missing script crash-loops on
    //     a real box, so the existence is bound where a real manager is about
    //     to read it. The idle check owns this assertion on both operating
    //     systems and this is where a manager acts on it.
    const program = programForKind("board");
    expect(existsSync(program)).toBe(true);
    expect(program).toBe(hubPath("src/entry/board.ts"));

    const board = await stageBoard();
    try {
      // THE CONTROL: the manager does not already carry this name, so a
      // leftover from a crashed run is a failure rather than a pass.
      expect(await carried(board.entryId)).toBe(false);
      expect(filesFor(board.entryId)).toEqual([]);

      const files = board.os.render(board.entry, board.context as never);
      const written = await board.os.install(files);
      expect([...written].sort()).toEqual(files.map((one) => one.path).sort());

      // --- 2 and 3. The manager's OWN WORDS carry the argv this check computed
      //     from the registry, element by element.
      const said = await managerSays(board.entryId);
      for (const piece of board.argv) {
        expect(said, `the manager's own record does not carry ${piece}`).toContain(piece);
      }

      const startedAt = Date.now();
      await board.os.start(board.entryId);
      await until(
        "the manager reports the board loaded and running with a real pid",
        async () => {
          const found = await board.os.show(board.entryId);
          return !!found && found.loaded === true && found.running === true && Number(found.pid) > 0;
        },
        60_000,
        async () => JSON.stringify(await board.os.show(board.entryId)),
      );
      const running = (await board.os.show(board.entryId))!;
      expect(pidAlive(Number(running.pid))).toBe(true);

      // --- 7. The process the manager started really answers on the address
      //     the registry gave it, once.
      const url = `http://${board.entry.bind}:${board.entry.port}/`;
      await until(
        "the board the manager started answered its first page",
        async () => {
          try {
            return (await fetch(url, { redirect: "manual" })).status === 200;
          } catch {
            return false;
          }
        },
        60_000,
        async () => `the manager says ${JSON.stringify(await board.os.show(board.entryId))}`,
      );

      process.stderr.write(
        `[board-native] the ${board.os.flavour} manager started the board and it answered its first page in ${Date.now() - startedAt} ms\n`,
      );

      // `readStatus` against the real manager, for this machine.
      const status = await readStatus({
        registryFile: board.it.registryFile,
        machine: MACHINE.id,
        os: board.os,
      });
      expect(status.find((one) => one.id === board.entryId)).toMatchObject({
        wanted: "running",
        seen: "running",
      });

      // --- and off again, from the manager AND from the disk.
      await board.os.remove(board.entryId);
      await until(
        "the manager let the board go",
        async () => !(await carried(board.entryId)),
        30_000,
        async () => (await fixture.listWatched()).join(", "),
      );
      expect(filesFor(board.entryId)).toEqual([]);
      // And nothing answers on that address any more.
      await expect(
        Bun.connect({
          hostname: "127.0.0.1",
          port: Number(board.entry.port),
          socket: { data() {}, open(socket) { socket.end(); } },
        }),
      ).rejects.toThrow();
    } finally {
      await board.os.remove(board.entryId).catch(() => {});
      await board.it.stop();
    }
  },
  SLOW,
);

test.skipIf(here("linux"))(
  `RUN-05 the systemd half: the unit file the manager read is a service under the render prefix and its removal takes the file with it${wants("linux")}`,
  async () => {
    const board = await stageBoard();
    try {
      expect(await carried(board.entryId)).toBe(false);
      const files = board.os.render(board.entry, board.context as never);
      // A resident renders one service file and no timer at all.
      expect(files.map((one) => one.path.slice(one.path.lastIndexOf("/") + 1))).toEqual([
        `${unitName(board.entryId)}.service`,
      ]);
      await board.os.install(files);
      const said = await managerSays(board.entryId);
      expect(said).toContain("Restart=always");
      expect(said).toContain(`MemoryMax=${board.entry.memory_limit_mb}M`);
      expect(said).toContain("[Install]");
      await board.os.remove(board.entryId);
      expect(filesFor(board.entryId)).toEqual([]);
    } finally {
      await board.os.remove(board.entryId).catch(() => {});
      await board.it.stop();
    }
  },
  SLOW,
);

test.skipIf(here("darwin"))(
  `RUN-05 the launchd half: the job is bootstrapped under the render label, the manager prints it, and booting it out takes the plist with it${wants("darwin")}`,
  async () => {
    const board = await stageBoard();
    try {
      expect(await carried(board.entryId)).toBe(false);
      const files = board.os.render(board.entry, board.context as never);
      expect(files.map((one) => one.path.slice(one.path.lastIndexOf("/") + 1))).toEqual([
        `${unitName(board.entryId)}.plist`,
      ]);
      await board.os.install(files);
      const said = await managerSays(board.entryId);
      expect(said).toContain(unitName(board.entryId));
      expect(said).toContain("path = ");
      await board.os.remove(board.entryId);
      expect(filesFor(board.entryId)).toEqual([]);
    } finally {
      await board.os.remove(board.entryId).catch(() => {});
      await board.it.stop();
    }
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `RUN-05 an entry the registry says is stopped reads stopped against the real manager, wanted and seen${gateSuffix(gate)}`,
  async () => {
    // The one state a faked seam could only approximate, asserted as the
    // observable rather than as the branch that produces it.
    const board = await stageBoard({ stopped: true });
    try {
      expect(await carried(board.runnerId)).toBe(false);
      const files = board.os.render(board.runner, {
        ...board.context,
        entryScript: programForKind("runner"),
      } as never);
      await board.os.install(files);

      const status = await readStatus({
        registryFile: board.it.registryFile,
        machine: MACHINE.id,
        os: board.os,
      });
      expect(status.find((one) => one.id === board.runnerId)).toMatchObject({
        wanted: "stopped",
        seen: "stopped",
      });
      // And the manager is not running it either, which is the half a fake
      // could only assert about itself.
      expect((await board.os.show(board.runnerId))?.running ?? false).toBe(false);
      // The control on the render: a stopped entry asks neither to be restarted
      // nor to be pulled in at boot.
      const text = files[0].text;
      expect(text).not.toContain("Restart=always");
      expect(text).not.toContain("[Install]");
    } finally {
      await board.os.remove(board.runnerId).catch(() => {});
      await board.it.stop();
    }
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `RUN-13 check reports a missing board unit against the real manager and nothing once it is there, and opens no connection to the board's port${gateSuffix(gate)}`,
  async () => {
    // TWO STAGES, and the reason is a trap this check walked into first: a
    // board whose port is already held by the listener below cannot bind, so
    // the manager restarts it forever and `check` reads it as missing for a
    // reason that has nothing to do with what is being asserted. So the unit
    // half gets a port of its own and the port half installs no unit at all.
    const board = await stageBoard();
    const store = await superStore(cluster, board.it.db);
    const { runCheck } = await seam("src/check/run.ts");
    const ask = async (registryFile: string, where: unknown, os: OsSeam): Promise<Finding[]> =>
      (await (runCheck as Function)({
        machine: MACHINE.id,
        registryFile,
        store: where,
        os,
        kernel: null,
        credentials: CREDENTIALS,
        now: new Date(),
      })) as Finding[];
    try {
      expect(await carried(board.entryId)).toBe(false);

      // With no unit for it, the real manager has nothing and `check` says so.
      const missing = await ask(board.it.registryFile, store, board.os);
      expect(missing.filter((one) => one.kind === "unit-missing").map((one) => one.subject)).toContain(
        board.entryId,
      );

      // With a unit the manager really carries and whose process really
      // answers, nothing. The wait is on the page rather than on the manager's
      // first word about the process, because a job that was spawned and then
      // died reads as running for a moment.
      await board.os.install(board.os.render(board.entry, board.context as never));
      await board.os.start(board.entryId);
      const url = `http://${board.entry.bind}:${board.entry.port}/`;
      await until(
        "the board the manager started answered its first page",
        async () => {
          try {
            return (await fetch(url, { redirect: "manual" })).status === 200;
          } catch {
            return false;
          }
        },
        60_000,
        async () => JSON.stringify(await board.os.show(board.entryId)),
      );
      const present = await ask(board.it.registryFile, store, board.os);
      expect(
        present.filter((one) => one.kind === "unit-missing").map((one) => one.subject),
      ).not.toContain(board.entryId);
    } finally {
      await board.os.remove(board.entryId).catch(() => {});
      await store.close();
      await board.it.stop();
    }

    // The port half. A listener standing in for the board, so the number that
    // says `check` never asked it for a page is a count rather than a claim.
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
    const entryId = fixture.entryId("board");
    const it = await stageHub(cluster, {
      machines: [MACHINE],
      run: [
        {
          id: "runner-test",
          kind: "runner",
          machine: MACHINE.id,
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 2048,
        },
        {
          id: entryId,
          kind: "board",
          machine: MACHINE.id,
          schedule: "always",
          memory_limit_mb: 128,
          bind: "127.0.0.1",
          port,
        },
      ],
    });
    const second = await superStore(cluster, it.db);
    const { thisOs } = await seam("src/os/index.ts");
    const os = (thisOs as Function)({ unitDir: fixture.unitDir() }) as OsSeam;
    try {
      const found = await ask(it.registryFile, second, os);
      expect(Array.isArray(found)).toBe(true);
      // A READ THAT COULD START WORK IS NOT A READ, and the board's own pages
      // can run `check`, so a `check` that fetched one could ask for its own
      // work. The number that says it did not is zero.
      expect(accepts).toBe(0);
      // The control on that zero: the listener counts, proved from here.
      await fetch(`http://127.0.0.1:${port}/`);
      expect(accepts).toBe(1);
    } finally {
      await listener.stop(true);
      await second.close();
      await it.stop();
    }
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `RUN-05 a bind this machine does not hold kills the board with the cause named, against a real socket on this operating system${gateSuffix(gate)}`,
  async () => {
    // THE OWNING ASSERTION IS IN THE IDLE CHECK, which runs on both operating
    // systems. This is the gated restatement: the same registry shape, the same
    // pinned line, and a socket on this box rather than one a seam described.
    const board = await stageBoard({ bind: NOT_HELD_HERE });
    try {
      const proc = Bun.spawn(
        [process.execPath, "run", hubPath("src/entry/board.ts"), board.it.registryFile, board.entryId],
        { cwd: hubPath("."), stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      );
      const said = await new Response(proc.stderr).text();
      expect(await proc.exited).not.toBe(0);
      const cause = /cannot listen on [^:]+:\d+: (.*)\.$/m.exec(said.trim())?.[1] ?? "";
      expect(cause, `the board said:\n${said.slice(0, 600)}`).not.toBe("");
      expect(said).toContain(
        boardBindFailed("en", { bind: board.entry.bind, port: board.entry.port, cause }),
      );
      await expect(
        Bun.connect({
          hostname: "127.0.0.1",
          port: Number(board.entry.port),
          socket: { data() {}, open(socket) { socket.end(); } },
        }),
      ).rejects.toThrow();
    } finally {
      await board.it.stop();
    }
  },
  SLOW,
);
