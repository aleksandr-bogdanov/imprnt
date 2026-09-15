// RUN-03 and L13. The hub installs, starts, stops and removes from the
// registry, and never touches a unit it did not generate. (SPEC §6, D7)
//
// D7: "one hub process per machine, ours, unsandboxed, is the only thing that
// talks to the OS: it watches the registry and installs, starts, stops or
// restarts service files when the registry changes." D-78 fences what it may
// touch: a unit under the RENDER prefix with no entry for this machine is one
// the hub itself generated and the registry no longer wants, so the hub removes
// it. A unit under the SCAN prefix that is NOT under the render prefix was never
// the hub's to write, so it is reported and nothing executes anything.
//
// EVERY CHANGE GOES THROUGH THE REGISTRY FILE, because a live hub is up and a
// check that planted or removed a render-prefix unit behind its back would be
// racing it. The one exception is the planted stray, which is under the watch
// prefix only and is therefore a thing the hub must report and must not touch:
// planting it is the whole point.
//
// THE MACHINE IS NEVER HARD-CODED. D-77 has the hub refuse a machine whose
// declared `os` is not the platform it is running on, so a fixture that wrote
// `pi`/`linux` would be refused before the check started, on a Mac, and would
// read exactly like a hub bug.
//
// Red reason: import missing, src/hub/run.ts, and schema missing, the `hub_hub`
// role: the hub's ledger writes are refused until the schema carries it.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { startCluster, until, type Cluster, type ReadyProcess } from "./helpers/cluster.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { livePid, managerState, pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { stageHub, startHub } from "./helpers/hub-fixture.ts";
import { writeRegistry, type RunSpec } from "./helpers/registry.ts";

const SLOW = 180_000;
const TICK = 1;

const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];
let cluster: Cluster;

beforeAll(async () => {
  announceGate(gate, "check 7, the hub reconciles against the real service manager");
  cluster = await startCluster();
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
});

afterAll(async () => {
  try {
    await fixture.removeAll();
  } finally {
    if (gate.ok) {
      const after = (await fixture.listWatched()).sort();
      if (JSON.stringify(after) !== JSON.stringify(foreignBefore)) {
        throw new Error(
          `this file disturbed the box: watch-prefix units were\n${foreignBefore.join(", ")}\nand are now\n${after.join(", ")}`,
        );
      }
    }
    if (cluster) await cluster.stop();
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(!gate.ok)(
  `RUN-03 the hub reconciles the registry against the operating system on its own tick and never touches a unit it did not generate: an added entry becomes a unit with a LIVE PID in the manager's own record and a machine event naming the hub, a tick that changed nothing writes no event, a removed entry is stopped and its file is gone, and a planted stray under the watch prefix is still running as the SAME PROCESS with no machine event about it at all (SPEC §6, D7, L13, D-78, D-79)${gateSuffix(gate)}`,
  async () => {
    const machine = thisMachine();
    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK, restart_delay_seconds: 1, give_up_after: 5, give_up_window_seconds: 300 },
      machines: [machine],
      run: [],
    });

    // The entry the hub installs is a `kind = "runner"`, so what it renders is
    // the production entry point D-94 pins. No file under `src/entry/` is
    // created by this round: the hub derives that path from the entry's kind.
    const base = {
      hub: {
        store_url: it.storeUrl,
        state_dir: it.stateDir,
        tick_seconds: TICK,
        restart_delay_seconds: 1,
        give_up_after: 5,
        give_up_window_seconds: 300,
      },
      machines: [machine],
    };
    // `writeRegistry` writes `registry.toml` into the dir `stageHub` made, which
    // is the very path the hub was handed, so a rewrite IS the edit it sees.
    const rewrite = (run: RunSpec[]) => writeRegistry(it.stateDir, { ...base, run });
    expect(rewrite([])).toBe(it.registryFile);

    let hub: ReadyProcess | null = null;
    try {
      hub = await startHub(it.registryFile, machine.id, fixture.unitDir());
      const hubPid = hub.pid;
      expect(alive(hubPid)).toBe(true);

      const entryId = fixture.entryId("resident");
      const unit = `imprnt-hub-${entryId}`;

      // --- 1. INSTALL AND START, through the file and nothing else.
      rewrite([
        {
          id: entryId,
          kind: "runner",
          machine: machine.id,
          schedule: "always",
          memory_limit_mb: 64,
          child_memory_limit_mb: 64,
        },
      ]);
      // STARTED means a process, not a label. The second seat's lead: a hub
      // that LOADED the unit without starting it, and wrote `unit.started`
      // anyway, satisfied a census of names. So the pid comes from the
      // manager's own record, through a helper that imports nothing from src/,
      // and is confirmed to be a live process.
      await until(
        "the hub installed and started the added entry, with a live pid of its own",
        async () =>
          (await fixture.listWatched()).some((n) => n.startsWith(unit)) && livePid(unit) !== null,
        60_000,
        async () =>
          `${(await fixture.listWatched()).join(", ")} | ${JSON.stringify(managerState(unit))}`,
      );
      const addedPid = livePid(unit)!;
      expect(pidAlive(addedPid)).toBe(true);
      expect(managerState(unit)!.running).toBe(true);
      expect(managerState(unit)!.ran).toBe(true);
      const events = async (kind?: string) =>
        await it.read.ledger(kind ? { stream: "machine", kind } : { stream: "machine" });
      await until(
        "the hub said so in the ledger",
        async () => (await events("unit.started")).some((e) => e.subject === entryId),
        60_000,
        async () => JSON.stringify(await events()),
      );
      // THE LEDGER LINE IS WHAT SEPARATES "the hub did it" FROM "something did
      // it", and the actor is what says which process.
      const installed = (await events("unit.installed")).filter((e) => e.subject === entryId);
      expect(installed.length).toBe(1);
      expect(installed[0].actor).toBe("hub");
      expect((await events("unit.started")).filter((e) => e.subject === entryId).length).toBe(1);

      // --- 2. NOTHING ON A TICK THAT CHANGED NOTHING. A hub that reinstalled
      //     every tick would churn the OS and make every later assertion about
      //     a pid meaningless.
      const settled = (await events()).length;
      await Bun.sleep(TICK * 4000);
      expect((await events()).length).toBe(settled);

      // --- 3. THE STRAY, and the rule that matters. A hub that treated every
      //     imprnt-* unit as its own would stop a live v2 on the hub box.
      const stray = await fixture.plantStray();
      const strayPid = livePid(stray.base);
      expect(pidAlive(strayPid)).toBe(true);
      await Bun.sleep(TICK * 4000);
      const listed = await fixture.listWatched();
      expect(listed.some((n) => n.startsWith(stray.base))).toBe(true);
      // THE SAME PROCESS, not merely a label that is still listed. A hub that
      // stopped the stray and let the manager start a replacement would pass a
      // census of names and fail this.
      expect(managerState(stray.base)!.pid).toBe(strayPid);
      expect(pidAlive(strayPid)).toBe(true);
      expect((await events()).filter((e) => String(e.subject).includes(stray.base))).toEqual([]);
      expect(
        (await events()).filter((e) =>
          JSON.stringify(e.detail ?? {}).includes(stray.base),
        ),
      ).toEqual([]);

      // --- 4. STOP AND REMOVE. The `stale` half of D-78: a render-prefix unit
      //     with no entry is the hub's own to remove.
      rewrite([]);
      await until(
        "the hub stopped and removed the entry that left the file",
        async () => !(await fixture.listWatched()).some((n) => n.startsWith(unit)),
        60_000,
        async () => (await fixture.listWatched()).join(", "),
      );
      expect(readdirSync(fixture.unitDir()).some((f) => f.startsWith(unit))).toBe(false);
      await until(
        "the hub said it stopped and removed it",
        async () =>
          (await events("unit.stopped")).some((e) => e.subject === entryId) &&
          (await events("unit.removed")).some((e) => e.subject === entryId),
        60_000,
        async () => JSON.stringify(await events()),
      );

      // And the stray is STILL RUNNING through all of it, as the SAME process,
      // with its file where it was.
      const finalList = await fixture.listWatched();
      expect(finalList.some((n) => n.startsWith(stray.base))).toBe(true);
      expect(existsSync(stray.file)).toBe(true);
      const strayNow = managerState(stray.base);
      expect(strayNow).not.toBeNull();
      expect(strayNow!.running).toBe(true);
      expect(strayNow!.pid).toBe(strayPid);
      expect(pidAlive(strayPid)).toBe(true);
      // The entry the hub removed was a different process from the stray, so
      // "it removed the right one" is a fact about two pids and not about one.
      expect(pidAlive(addedPid)).toBe(false);

      // --- and the hub's own process never restarted to do any of it.
      expect(hub.pid).toBe(hubPid);
      expect(alive(hubPid)).toBe(true);
    } finally {
      if (hub) await hub.stop();
      await it.stop();
    }
  },
  SLOW,
);
