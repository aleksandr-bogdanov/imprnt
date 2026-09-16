// RUN-02 and D7. A crash loop is a finding, because launchd never gives up.
// (SPEC §6, L13)
//
// D7: "launchd never stops restarting a dying process, so on a Mac the crash
// loop is a `check` finding rather than an OS state." D-96 follows it through:
// `hub.give_up_after` and `hub.give_up_window_seconds` render to systemd's
// `StartLimitBurst` and `StartLimitIntervalSec`, launchd has no equivalent and
// the launchd renderer emits neither, and `check` carries `crash-loop` instead.
// ONE finding, TWO paths to it, and this check says which one it took.
//
// REAL MANAGER, GATED, NO HUB PROCESS RUNNING, so nothing removes a unit behind
// the check's back. The unit that keeps dying is removed in an `afterAll` that
// runs from a `finally` like every other, which is the case the unit fixture was
// proved on before this check was written.
//
// Red reason: import missing, src/check/run.ts and src/os/index.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { managerState } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { stageHub, superStore } from "./helpers/hub-fixture.ts";
import { writeRegistry } from "./helpers/registry.ts";
import type { Finding } from "./helpers/finding.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";

const SLOW = 180_000;
// D-103. `give_up_after` is 3 because systemd's own rate limiter allows at most
// `StartLimitBurst - 1` restarts before it refuses to start the unit again, so
// a finding threshold equal to this setting could never be reached on Linux and
// the crash loop would be a finding on the Mac and nowhere else. TWO restarts
// is the threshold, reachable on both, and a healthy unit is at zero.
const GIVE_UP_AFTER = 3;
const CRASH_LOOP_RESTARTS = 2;

const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];
let cluster: Cluster;

beforeAll(async () => {
  announceGate(gate, "check 23, a crash loop is a finding");
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

test.skipIf(!gate.ok)(
  `RUN-02 a crash loop is a finding: a unit whose command exits non-zero has the manager's OWN restart counter climbing past two, check reports exactly one crash-loop finding naming it and the count, a healthy always entry installed in the same run has RAN with ZERO restarts and produces none, and the platform's path to the finding is asserted rather than assumed (SPEC §6, L13, D7, D-96, D-101, D-103)${gateSuffix(gate)}`,
  async () => {
    const { thisOs } = await seam("src/os/index.ts");
    expect(typeof thisOs).toBe("function");
    const { runCheck } = await seam("src/check/run.ts");
    expect(typeof runCheck).toBe("function");

    const machine = thisMachine();
    const dyingId = fixture.entryId("dying");
    const healthyId = fixture.entryId("healthy");

    const it = await stageHub(cluster, {
      hub: { restart_delay_seconds: 1, give_up_after: GIVE_UP_AFTER, give_up_window_seconds: 300 },
      machines: [machine],
      run: [],
    });
    writeRegistry(it.stateDir, {
      hub: {
        store_url: it.storeUrl,
        state_dir: it.stateDir,
        restart_delay_seconds: 1,
        give_up_after: GIVE_UP_AFTER,
        give_up_window_seconds: 300,
      },
      machines: [machine],
      run: [
        { id: dyingId, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 64, child_memory_limit_mb: 64 },
        { id: healthyId, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 64, child_memory_limit_mb: 64 },
      ],
    });

    const store = await superStore(cluster, it.db);
    try {
      // Two scripts the CHECK owns. No file under src/entry/ is created this
      // round: the render context is handed its entry script.
      const jobs = join(it.stateDir, "jobs");
      mkdirSync(jobs, { recursive: true });
      const dyingScript = join(jobs, "dies.ts");
      const healthyScript = join(jobs, "alive.ts");
      writeFileSync(dyingScript, "process.exit(3);\n", "utf8");
      writeFileSync(healthyScript, "await new Promise(() => {});\n", "utf8");

      const os = (thisOs as Function)({ unitDir: fixture.unitDir() }) as {
        flavour: string;
        render(entry: unknown, ctx: unknown): { path: string; text: string }[];
        install(files: unknown[]): Promise<string[]>;
        start(id: string): Promise<void>;
        show(id: string): Promise<Record<string, unknown> | null>;
        list(): Promise<Record<string, unknown>[]>;
      };
      const entries = listRunEntries(loadRegistry(it.registryFile));
      const ctx = (script: string) => ({
        machine: machine.id,
        execPath: process.execPath,
        entryScript: script,
        registryFile: it.registryFile,
        restartDelaySeconds: 1,
        giveUpAfter: GIVE_UP_AFTER,
        giveUpWindowSeconds: 300,
      });

      await os.install(os.render(entries.find((e) => e.id === healthyId)!, ctx(healthyScript)));
      await os.install(os.render(entries.find((e) => e.id === dyingId)!, ctx(dyingScript)));
      await os.start(healthyId);
      await os.start(dyingId);

      // FIRST, the manager's OWN counter. Without it this check could report a
      // crash loop for a unit that never started.
      //
      // `restarts` MEANS RESTARTS on both flavours (D-101), which is the
      // reconciliation the second seat asked for: the seam used to map launchd
      // `runs` straight onto this field, and `runs` counts executions, so a
      // healthy job that has never died read as one restart and the control
      // below was false on a Mac. It is now `max(runs - 1, 0)` there and
      // `NRestarts` on systemd, and check 21 asks its own question through
      // `ran` instead of borrowing this one.
      await until(
        "the dying unit's own restart counter climbed",
        async () => {
          const found = await os.show(dyingId);
          return !!found && Number(found.restarts ?? 0) >= CRASH_LOOP_RESTARTS;
        },
        90_000,
        async () => JSON.stringify(await os.show(dyingId)),
      );
      const dying = (await os.show(dyingId))!;
      const count = Number(dying.restarts);
      expect(count).toBeGreaterThanOrEqual(CRASH_LOOP_RESTARTS);
      // The same reading from the manager directly, so a seam that invented the
      // counter is caught rather than believed.
      expect(Number(managerState(`imprnt-hub-${dyingId}`)!.restarts ?? 0)).toBeGreaterThanOrEqual(
        CRASH_LOOP_RESTARTS,
      );

      // And the healthy one is alive throughout, with a counter that has not
      // moved. It is the control that stops this passing on a `check` that
      // reports every unit.
      const healthy = (await os.show(healthyId))!;
      expect(healthy.running).toBe(true);
      expect(Number(healthy.restarts ?? 0)).toBe(0);
      // It RAN, and it never restarted: the two facts D-101 keeps apart, in the
      // one place where reading either for the other gives the wrong answer.
      expect(healthy.ran).toBe(true);
      const healthyByManager = managerState(`imprnt-hub-${healthyId}`)!;
      expect(healthyByManager.restarts).toBe(0);
      expect(healthyByManager.ran).toBe(true);
      expect(healthyByManager.running).toBe(true);

      const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;
      const findings = await check({
        machine: machine.id,
        registryFile: it.registryFile,
        store,
        os,
        kernel: null,
      });
      const loops = findings.filter((f) => f.kind === "crash-loop");
      expect(loops.length).toBe(1);
      expect(loops[0].subject).toContain(dyingId);
      expect(loops[0].machine).toBe(machine.id);
      expect(loops[0].id).toContain(`${machine.id}/`);
      // It names the unit AND the count, or a household cannot tell a unit that
      // is dying in a loop from one sitting quietly failed.
      expect(loops[0].says).toContain(dyingId);
      expect(/\d/.test(loops[0].says)).toBe(true);
      // AND WHAT THE MANAGER SAYS IT IS (03b row 3), on both platforms: a
      // household given only a count cannot tell a unit still being restarted
      // from one the limiter has parked, or know which of `start` and
      // `reset-failed` will do anything.
      //
      // THE WORD IS NOT COMPARED TO ONE READING. A unit in a restart loop is
      // MOVING: `check` reads its state a moment after this file does, and on
      // the hub box the two came back `activating` and `active`, which is the
      // same mistake BUILD-NOTES 18 recorded for the memory drift, made by this
      // assertion's first draft. So what is bound here is that the sentence
      // names the manager and carries a word out of THAT manager's own state
      // vocabulary, widened by whatever this file actually saw. The exact word
      // against a live reading is bound in `test/check-giveup.test.ts`, where
      // the unit is parked and has stopped moving.
      const vocabulary = new Set(
        os.flavour === "launchd"
          ? ["running", "not running", "waiting", "spawn scheduled"]
          : ["active", "activating", "deactivating", "inactive", "failed", "reloading", "refreshing", "maintenance"],
      );
      vocabulary.add(String(dying.state));
      vocabulary.add(String((await os.show(dyingId))?.state ?? ""));
      expect(typeof dying.state).toBe("string");
      expect(loops[0].says).toContain(os.flavour);
      const word = /has it ([a-z][a-z ]*?)(?:,|$)/.exec(loops[0].says)?.[1] ?? "";
      expect(
        vocabulary.has(word) ? "one of the manager's own words" : `${word} is no state ${os.flavour} has`,
      ).toBe("one of the manager's own words");
      expect(typeof loops[0].fix).toBe("string");
      expect(loops[0].fix.length).toBeGreaterThan(0);
      // The healthy one produces no finding of this kind at all.
      expect(loops.map((f) => f.subject).join(" ")).not.toContain(healthyId);

      // --- THE PLATFORM ASYMMETRY, asserted rather than assumed. One finding,
      //     two paths, and the check says which one it took.
      if (process.platform === "darwin") {
        // launchd never gives up, so the job is STILL being restarted while the
        // finding stands. The counter keeps climbing after `check` read it.
        await until(
          "launchd is still restarting it after the finding fired",
          async () => Number((await os.show(dyingId))!.restarts ?? 0) > count,
          30_000,
          async () => JSON.stringify(await os.show(dyingId)),
        );
      } else {
        // systemd's own give-up state is reached, because the renderer emitted
        // StartLimitBurst and StartLimitIntervalSec (D-96), and `check` reports
        // the same finding from the same reading.
        await until(
          "systemd reached its own give-up state",
          async () => {
            const found = await os.show(dyingId);
            return !!found && found.running === false;
          },
          60_000,
          async () => JSON.stringify(await os.show(dyingId)),
        );
        const after = await check({
          machine: machine.id,
          registryFile: it.registryFile,
          store,
          os,
          kernel: null,
        });
        expect(after.filter((f) => f.kind === "crash-loop").length).toBe(1);
      }
    } finally {
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
