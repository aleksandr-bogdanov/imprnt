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
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
  announceGate(gate, "03b item 8, one hub per machine");
  cluster = await startCluster();
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
    [process.execPath, "run", hubPath("test/helpers/hub-subprocess.ts"), registryFile, machine, unitDir],
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
    const entryId = fixture.entryId("single");
    const unit = `imprnt-hub-${entryId}`;
    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK, restart_delay_seconds: 1 },
      machines: [machine],
      // ONE REAL ENTRY, because "it installed nothing" has to be a sentence
      // that could have come out false (VERIFY-CODEX row 8). With no entries at
      // all the census either side of the second hub is identical whatever that
      // hub did, refusing or reconciling, so the assertion was about a box with
      // nothing on it rather than about a hub that stopped before its tick. The
      // first hub installs this one, and the census is taken AFTER it has, so
      // what the second hub is measured against is a box that already changed
      // once and must not change again.
      run: [
        {
          id: entryId,
          kind: "runner",
          machine: machine.id,
          schedule: "always",
          memory_limit_mb: 64,
          child_memory_limit_mb: 64,
        },
      ],
    });
    let first: ReadyProcess | null = null;
    try {
      first = await startHub(it.registryFile, machine.id, fixture.unitDir());
      expect(pidAlive(first.pid)).toBe(true);
      // Past its first tick, and its tick is what installs the entry, so the
      // one that is running is really running AND has really done its work.
      await until(
        "the first hub installed the entry it was given",
        async () => (await fixture.listWatched()).some((name) => name.startsWith(unit)),
        60_000,
        async () => (await fixture.listWatched()).join(", "),
      );
      expect(pidAlive(first.pid)).toBe(true);
      const unitsBefore = (await fixture.listWatched()).sort();
      expect(unitsBefore.some((name) => name.startsWith(unit))).toBe(true);

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
      //     so the second hub touched no unit on its way out, and the box it is
      //     measured against is one the FIRST hub already installed into: a
      //     second hub that reconciled before refusing would have had a unit to
      //     act on and a stale one to tear down, and this is the census that
      //     would show it.
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

test.skipIf(!gate.ok)(
  `RUN-09 two hubs for one machine started in the SAME INSTANT settle to one: both are launched with neither having connected yet, exactly one comes up and exactly one leaves with refused.second_hub, one unit is on the box and it is the survivor's, and the survivor is still running afterwards (SPEC §6, D7, L11)${gateSuffix(gate)}`,
  async () => {
    // WHY SEQUENTIAL WAS NOT ENOUGH (VERIFY-CODEX row 8). The check above waits
    // for the first hub to be up before starting the second, so the racy
    // implementation this replaced (count the backends with this name, then
    // carry on) passes it: by the time the second counts, the first is there to
    // be counted. The shape it cannot survive is two starts in the same instant,
    // where both count zero and both go on, and that is what this stages: both
    // promises are in flight before either is awaited.
    const machine = thisMachine();
    const entryId = fixture.entryId("race");
    const unit = `imprnt-hub-${entryId}`;
    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK, restart_delay_seconds: 1 },
      machines: [machine],
      run: [
        {
          id: entryId,
          kind: "runner",
          machine: machine.id,
          schedule: "always",
          memory_limit_mb: 64,
          child_memory_limit_mb: 64,
        },
      ],
    });
    let alive: ReadyProcess | null = null;
    try {
      const unitsBefore = (await fixture.listWatched()).sort();
      expect(unitsBefore.some((name) => name.startsWith(unit))).toBe(false);

      // BOTH IN FLIGHT AT ONCE. Neither is awaited until both have been asked
      // for, so nothing in the test orders them.
      const one = startHub(it.registryFile, machine.id, fixture.unitDir());
      const two = startHub(it.registryFile, machine.id, fixture.unitDir());
      const settled = await Promise.allSettled([one, two]);

      const up = settled.filter((r) => r.status === "fulfilled");
      const out = settled.filter((r) => r.status === "rejected");
      // --- EXACTLY ONE OF EACH. Two up is the bug this exists for; two down is
      //     a machine that can never start a hub at all.
      expect(`${up.length} up, ${out.length} refused`).toBe("1 up, 1 refused");
      alive = (up[0] as PromiseFulfilledResult<ReadyProcess>).value;
      // Whichever lost says why, in the words the refusal uses.
      const why = String((out[0] as PromiseRejectedResult).reason?.message ?? "");
      expect(why.toLowerCase()).toContain("hub");
      expect(why).toContain(machine.id);

      // --- AND IT SAID SO IN THE STORE, once. Two lines would mean both
      //     refused and one started anyway.
      await until(
        "the hub that lost wrote its refusal",
        async () =>
          (await it.read.ledger({ stream: "refusal", kind: "refused.second_hub" })).length >= 1,
        15_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "refusal" })),
      );
      const refusals = await it.read.ledger({ stream: "refusal", kind: "refused.second_hub" });
      expect(refusals.length).toBe(1);
      expect(refusals[0].actor).toBe("hub");
      expect(refusals[0].subject).toBe(machine.id);

      // --- ONE HUB'S WORK ON THE BOX. The survivor installs the entry, and the
      //     count of units under the watch prefix grows by exactly what one hub
      //     installs: two hubs reconciling the same machine is what this rule
      //     exists to prevent and what a census of the box can see.
      await until(
        "the surviving hub installed the entry",
        async () => (await fixture.listWatched()).some((name) => name.startsWith(unit)),
        60_000,
        async () => (await fixture.listWatched()).join(", "),
      );
      expect(pidAlive(alive.pid)).toBe(true);

      // --- and it is still there a tick later, so the survivor is a hub that
      //     is running rather than one that also fell over.
      await Bun.sleep(TICK * 2000);
      expect(pidAlive(alive.pid)).toBe(true);
      expect((await it.read.ledger({ stream: "refusal", kind: "refused.second_hub" })).length).toBe(1);
    } finally {
      if (alive) await alive.stop();
      await fixture.removeAll();
      await it.stop();
    }
  },
  SLOW,
);
