// 03b item 8. ONE hub process per machine, and the second one refuses itself.
// (SPEC §6, D7, L11)
//
// 03-CONTEXT's deferred list carried this in its own words: "'One hub process
// per machine' (SPEC §6, D7) as an enforced invariant. Phase 3 ships one process
// and never starts two, and nothing yet refuses a second one on the same
// machine." Two hubs on one machine is not a theoretical shape: it is what a
// hand-started hub beside a unit-started one is, and BUILD-NOTES B.2 already
// records what a stray hub does to a box ("a hub process left running by an
// interrupted check removes every `imprnt-hub-` unit on the box"). Two of them
// reconciling the same machine would fight over every unit on it.
//
// THE MECHANISM IS THE ONE THE RUNNER ALREADY HAS. The hub names itself
// `hub-<machine>` in `application_name` at connect, which `src/hub/run.ts`
// already does, and the store's own client list is therefore the register of
// who is running. So the second hub asks, before its first tick, whether
// another live backend on this store already carries its name, writes
// `refused.second_hub` and leaves. No lock file, no pid file, nothing to clean
// up after a crash: a dead hub's backend is gone from `pg_stat_activity` by the
// time anybody asks.
//
// Red reason: behaviour absent. `src/hub/run.ts` reads `pg_stat_activity` for
// nothing at connect, so a second hub starts, prints its ready line and begins
// reconciling the same machine as the first.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { hubPath, startCluster, until, type Cluster, type ReadyProcess } from "./helpers/cluster.ts";
import { stageHub, startHub } from "./helpers/hub-fixture.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";

const SLOW = 150_000;
const TICK = 1;

let cluster: Cluster;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];

beforeAll(async () => {
  announceGate(gate, "03b item 8, one hub per machine");
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

/** The hub started RAW, because what is under test is a start that fails. */
async function startSecondHub(
  registryFile: string,
  machine: string,
  unitDir: string,
): Promise<{ code: number; said: Record<string, unknown> | null; out: string }> {
  const proc = Bun.spawn(
    ["bun", "run", hubPath("test/helpers/hub-subprocess.ts"), registryFile, machine, unitDir],
    { cwd: hubPath("."), stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const finished = await Promise.race([
    proc.exited,
    Bun.sleep(10_000).then(() => "still running" as const),
  ]);
  if (finished === "still running") {
    // A hub that did NOT refuse is a hub reconciling this machine behind the
    // first one's back, so it is taken off the box BEFORE its output is read:
    // a pipe of a living process has no end, and reading one first is a wait
    // that only the test's own timeout can break.
    proc.kill(9);
    await proc.exited.catch(() => {});
    return { code: -1, said: null, out: "the second hub was still running after ten seconds" };
  }
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const line = `${out}`.split("\n").find((one) => one.trim().startsWith("{"));
  return {
    code: finished as number,
    said: line ? (JSON.parse(line) as Record<string, unknown>) : null,
    out: `${out}${err}`,
  };
}

test.skipIf(!gate.ok)(
  `RUN-09 a second hub for the same machine refuses itself: it exits non-zero saying so, writes one refused.second_hub line naming the machine, installs nothing, and the hub that was already there keeps the same pid throughout (SPEC §6, D7, L11)${gateSuffix(gate)}`,
  async () => {
    const machine = thisMachine();
    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK, restart_delay_seconds: 1 },
      machines: [machine],
      // No entries at all: what is under test is the second process, and a hub
      // with nothing to install cannot be accused of having installed it.
      run: [],
    });
    let first: ReadyProcess | null = null;
    try {
      const unitsBefore = (await fixture.listWatched()).sort();

      first = await startHub(it.registryFile, machine.id, fixture.unitDir());
      expect(pidAlive(first.pid)).toBe(true);
      // Past its first tick, so the one that is running is really running.
      await Bun.sleep(TICK * 2000);
      expect(pidAlive(first.pid)).toBe(true);

      const before = await it.read.ledger({ stream: "refusal" });

      const second = await startSecondHub(it.registryFile, machine.id, fixture.unitDir());
      // --- IT LEFT, and it left loudly. `code` is -1 here only when it was
      //     still running after ten seconds, which is a hub that never
      //     refused at all.
      expect(second.code).toBeGreaterThan(0);
      expect(second.said).not.toBeNull();
      expect(second.said!.ready).toBe(false);
      expect(String(second.said!.error).toLowerCase()).toContain("hub");
      expect(String(second.said!.error)).toContain(machine.id);

      // --- AND IT SAID SO IN THE STORE, which is where a household looks.
      await until(
        "the second hub wrote its refusal",
        async () =>
          (await it.read.ledger({ stream: "refusal", kind: "refused.second_hub" })).length >= 1,
        15_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "refusal" })),
      );
      const refusals = await it.read.ledger({ stream: "refusal", kind: "refused.second_hub" });
      expect(refusals.length).toBe(1);
      expect(refusals[0].actor).toBe("hub");
      expect(refusals[0].subject).toBe(machine.id);
      expect(JSON.stringify(refusals[0].detail)).toContain(machine.id);
      // It is a NEW line, not one the first hub had already written.
      expect(before.map((row) => row.seq)).not.toContain(refusals[0].seq);

      // --- NOTHING OF THE OS MOVED. The refusal happens before the first tick,
      //     so the second hub touched no unit on its way out.
      expect((await fixture.listWatched()).sort()).toEqual(unitsBefore);

      // --- and the hub that was already there is untouched: the same process,
      //     still alive. A refusal that took the first one down with it would
      //     be worse than two hubs.
      expect(pidAlive(first.pid)).toBe(true);
      const stillFirst = first.pid;
      await Bun.sleep(TICK * 2000);
      expect(pidAlive(stillFirst)).toBe(true);

      // --- THE CONTROL: once the first one has gone, a hub for that machine
      //     starts normally. Without it a `runHub` that refused every start
      //     would pass everything above.
      await first.stop();
      first = null;
      await until(
        "the first hub's backend left the store",
        async () =>
          ((await it.read.sql(
            "select count(*)::int as n from pg_stat_activity where application_name = $1",
            [`hub-${machine.id}`],
          )) as { n: number }[])[0].n === 0,
        20_000,
      );
      const replacement = await startHub(it.registryFile, machine.id, fixture.unitDir());
      try {
        expect(pidAlive(replacement.pid)).toBe(true);
      } finally {
        await replacement.stop();
      }
    } finally {
      if (first) await first.stop();
      await it.stop();
    }
  },
  SLOW,
);
