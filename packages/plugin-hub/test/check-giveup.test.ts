// 03b item 3. systemd's OWN give-up state, reached and reported. (SPEC §6, L13,
// D7, D-96, D-103)
//
// RED-RUN-2's last open residue, in Codex's words: "`check` is never run against
// the real systemd's give-up state. Check 23's Linux branch is written and
// unexecuted." It is written and unexecuted because on the box the whole check
// failed at the missing OS import before it reached that branch, and because
// check 23's Linux arm waits only for `running === false`, which a unit reaches
// the moment it is between restarts.
//
// What this binds instead is the state systemd actually parks a unit in when it
// has had enough: `ActiveState=failed` with `Result=start-limit-hit`, read from
// the manager DIRECTLY and never through the seam under test, and the finding
// `check` reports about it, carrying the command a human pastes to clear it.
//
// `give_up_after` IS THREE, and the choice is recorded because the two readings
// of it disagree. BUILD-NOTES A.1, measured on the hub box with
// `StartLimitBurst=3`: `NRestarts` reads 1, 2, then 3, and at 3 the unit is
// `failed`, which reads as "the limiter allows `StartLimitBurst` restarts".
// D-103's reasoning says the ceiling is `StartLimitBurst - 1`. Under the first
// reading a burst of 2 reaches 2 restarts and under the second it reaches 1, so
// a burst of 2 would make D-103's own threshold of two restarts unreachable on
// half the readings. Three is reachable under both, so that is what this sets,
// and the assertion below is `restarts >= 2` rather than an exact count. The
// build round measures the ceiling on the box and says which reading is true.
//
// Red reasons, one per platform, and the Linux one comes FIRST in the body so
// that is what a Linux run reports:
//   linux:  behaviour absent. `src/check/run.ts`'s crash-loop fix today reads
//           "read why with journalctl --user -u <unit>.service, then fix it or
//           take it off the list", so the assertion that it carries the
//           `reset-failed` command a parked unit needs is red.
//   darwin: export missing. `resetCommand` is not in `src/os/diff.ts`, and the
//           give-up state itself is not a question a Mac can answer, because
//           launchd never gives up (D7).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { stageHub, superStore } from "./helpers/hub-fixture.ts";
import { writeRegistry } from "./helpers/registry.ts";
import type { Finding } from "./helpers/finding.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";

const SLOW = 180_000;
const GIVE_UP_AFTER = 3;
const GIVE_UP_WINDOW = 60;

const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];
let cluster: Cluster;

beforeAll(async () => {
  announceGate(gate, "03b item 3, systemd's own give-up state");
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

/** The manager's own properties, read directly. Never through `src/os/`. */
function systemdShow(unit: string, properties: string[]): Map<string, string> {
  const out = Bun.spawnSync(
    ["systemctl", "--user", "show", unit, ...properties.flatMap((p) => ["-p", p]), "--no-pager"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const fields = new Map<string, string>();
  for (const line of (out.stdout?.toString() ?? "").split("\n")) {
    const cut = line.indexOf("=");
    if (cut > 0) fields.set(line.slice(0, cut), line.slice(cut + 1).trim());
  }
  return fields;
}

test.skipIf(!gate.ok)(
  `RUN-02 systemd gives up and check says so: a unit whose program exits at once is parked by the manager's own rate limiter in ActiveState=failed with Result=start-limit-hit, check reports exactly one crash-loop finding for it naming the restart count, and the fix it carries is the reset-failed command that unit really needs (SPEC §6, L13, D7, D-96, D-103)${gateSuffix(gate)}`,
  async () => {
    const machine = thisMachine();

    if (process.platform !== "linux") {
      // launchd never gives up (D7), so the state below does not exist here and
      // a Mac cannot answer the question. What a Mac CAN hold the build to is
      // that the command lives in the OS seam and not in `check`: item 7
      // forbids `src/check/` to name a manager at all, so the fix a crash-loop
      // finding carries has to be built here.
      process.stderr.write(
        "[give-up] the give-up state is systemd's: launchd never stops restarting a dying job (D7), " +
          "so on darwin this check binds the seam that supplies the finding's fix text and nothing else\n",
      );
      const { resetCommand } = await seam("src/os/diff.ts");
      expect(typeof resetCommand).toBe("function");
      const reset = resetCommand as (flavour: string, unit: string) => string;
      const uid = process.getuid?.() ?? -1;
      // D-105's rule: the WHOLE string, twice, with two different unit names, so
      // a hard-coded answer fails. It is a command a human pastes.
      expect(reset("systemd", "imprnt-hub-one.service")).toBe(
        "systemctl --user reset-failed imprnt-hub-one.service",
      );
      expect(reset("systemd", "imprnt-hub-two.service")).toBe(
        "systemctl --user reset-failed imprnt-hub-two.service",
      );
      expect(reset("launchd", "imprnt-hub-one")).toBe(
        `launchctl bootout gui/${uid}/imprnt-hub-one`,
      );
      expect(reset("launchd", "imprnt-hub-two")).toBe(
        `launchctl bootout gui/${uid}/imprnt-hub-two`,
      );
      return;
    }

    const { thisOs } = await seam("src/os/index.ts");
    const { runCheck } = await seam("src/check/run.ts");
    const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;

    const dyingId = fixture.entryId("giveup");
    const unit = `imprnt-hub-${dyingId}.service`;

    const it = await stageHub(cluster, {
      hub: {
        restart_delay_seconds: 0,
        give_up_after: GIVE_UP_AFTER,
        give_up_window_seconds: GIVE_UP_WINDOW,
      },
      machines: [machine],
      run: [],
    });
    writeRegistry(it.stateDir, {
      hub: {
        store_url: it.storeUrl,
        state_dir: it.stateDir,
        restart_delay_seconds: 0,
        give_up_after: GIVE_UP_AFTER,
        give_up_window_seconds: GIVE_UP_WINDOW,
      },
      machines: [machine],
      run: [
        {
          id: dyingId,
          kind: "runner",
          machine: machine.id,
          schedule: "always",
          memory_limit_mb: 64,
          child_memory_limit_mb: 64,
        },
      ],
    });

    const store = await superStore(cluster, it.db);
    try {
      const jobs = join(it.stateDir, "jobs");
      mkdirSync(jobs, { recursive: true });
      const script = join(jobs, "dies-at-once.ts");
      writeFileSync(script, "process.exit(1);\n", "utf8");

      const os = (thisOs as Function)({ unitDir: fixture.unitDir() }) as {
        render(entry: unknown, ctx: unknown): { path: string; text: string }[];
        install(files: unknown[]): Promise<string[]>;
        start(id: string): Promise<void>;
      };
      const entry = listRunEntries(loadRegistry(it.registryFile)).find((e) => e.id === dyingId)!;
      await os.install(
        os.render(entry, {
          machine: machine.id,
          execPath: process.execPath,
          entryScript: script,
          registryFile: it.registryFile,
          restartDelaySeconds: 0,
          giveUpAfter: GIVE_UP_AFTER,
          giveUpWindowSeconds: GIVE_UP_WINDOW,
        }),
      );
      await os.start(dyingId);

      // --- THE GIVE-UP STATE ITSELF, read from the manager directly. This is
      //     the branch phase 3 wrote and never executed.
      await until(
        "systemd parked the unit at its own start limit",
        () => {
          const shown = systemdShow(unit, ["ActiveState", "Result"]);
          return shown.get("ActiveState") === "failed" && shown.get("Result") === "start-limit-hit";
        },
        90_000,
        () => JSON.stringify([...systemdShow(unit, ["ActiveState", "SubState", "Result", "NRestarts"])]),
      );
      const parked = systemdShow(unit, ["ActiveState", "Result", "NRestarts", "ExecMainStatus"]);
      expect(parked.get("ActiveState")).toBe("failed");
      expect(parked.get("Result")).toBe("start-limit-hit");
      const restarts = Number(parked.get("NRestarts") ?? 0);
      // D-103's threshold, reachable under either reading of the ceiling.
      expect(restarts).toBeGreaterThanOrEqual(2);
      expect(Number(parked.get("ExecMainStatus") ?? -1)).toBe(1);

      // --- and `check` reports it, from the counter and not from the running
      //     flag, with the command that clears the state it is really in.
      const findings = await check({
        machine: machine.id,
        registryFile: it.registryFile,
        store,
        os,
        kernel: null,
      });
      const loops = findings.filter((one) => one.kind === "crash-loop");
      expect(loops.length).toBe(1);
      expect(loops[0].subject).toContain(dyingId);
      expect(loops[0].says).toContain(dyingId);
      expect(loops[0].says).toContain(String(restarts));
      // THE FIX A PARKED UNIT NEEDS. A unit systemd has given up on does not
      // come back from `start` alone: the failure has to be reset first, and a
      // fix that does not run is worse than no fix (D-105).
      expect(loops[0].fix).toContain("reset-failed");
      expect(loops[0].fix).toContain(unit);
      expect(loops[0].fix).toBe(`systemctl --user reset-failed ${unit}`);

      // The same text, from the seam that owns it, so `check` carries no
      // manager's name of its own (03b item 7).
      const { resetCommand } = await seam("src/os/diff.ts");
      expect(typeof resetCommand).toBe("function");
      expect((resetCommand as Function)("systemd", unit)).toBe(loops[0].fix);
    } finally {
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
