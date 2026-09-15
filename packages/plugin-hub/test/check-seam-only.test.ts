// 03b item 7. `check` cannot reach a service manager by ANY path. (SPEC §6,
// §7, L13)
//
// RED-RUN-2's stated residue: "`check` calling a manager by ABSOLUTE path is not
// caught. Check 22 runs `runCheck` in a subprocess whose PATH is fronted by
// shims that log every `launchctl` and `systemctl` invocation and refuse every
// mutating verb ... A build that spawned `/bin/launchctl` by its full path never
// meets the shim." PATH fronting can only ever catch a bare name, so the fence
// moves into the seam: the manager binary becomes a PARAMETER of `systemd()`
// and `launchd()` whose default is the bare name PATH resolves, `check` gets its
// seam from `thisOs(...)` and calls nothing else, and a check points that
// parameter at a recording shim BY ABSOLUTE PATH. A `check` that reached the
// real manager by any route then leaves the shim's log empty while its findings
// still come back, which is a difference no PATH trick can hide.
//
// The second half is a source-level assertion, allowed under "no test that
// cannot fail" because it CAN fail and does today: no file under `src/check/`
// carries the string `launchctl` or `systemctl`. It is not a style rule. Every
// manager name in `check` is a name `check` could invoke, and the one place the
// difference cannot be observed from outside is a string that was built in the
// right place for the wrong reason. Today `src/check/run.ts` builds both the
// start command for a missing unit and the journal command for a crash loop
// itself, so both names are in it.
//
// Red reasons. Test 1: behaviour absent, `src/os/index.ts`, `src/os/launchd.ts`
// and `src/os/systemd.ts` take no `bin`, so a seam built with one still spawns
// the real manager by bare name and the shim's log comes back EMPTY. Test 2:
// behaviour absent, `src/check/run.ts` contains `launchctl kickstart` and
// `systemctl --user start` in its own fix text.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hubPath, startCluster, seam, type Cluster } from "./helpers/cluster.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { managerShim } from "./helpers/manager-shim.ts";
import { managerState, livePid, pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { Finding } from "./helpers/finding.ts";

const SLOW = 150_000;

let cluster: Cluster;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];

beforeAll(async () => {
  announceGate(gate, "03b item 7, check reaches no manager but the seam it was handed");
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
  `RUN-04 check speaks to the manager the seam names and to no other: with the seam's binary pointed at a recording shim by ABSOLUTE path, the run's findings still name the planted stray, every question the shim was asked is a reading one, nothing mutating was asked at all, and the stray is still running under the same pid (SPEC §6, §7, L13, D-90)${gateSuffix(gate)}`,
  async () => {
    const { thisOs } = await seam("src/os/index.ts");
    expect(typeof thisOs).toBe("function");
    const { runCheck } = await seam("src/check/run.ts");
    const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;

    const machine = thisMachine();
    const shim = managerShim();
    const stray = await fixture.plantStray();
    const strayPid = livePid(stray.base);
    expect(strayPid).not.toBeNull();
    expect(pidAlive(strayPid)).toBe(true);

    const it = await stageHub(cluster, {
      machines: [machine],
      run: [
        {
          id: "runner-here",
          kind: "runner",
          machine: machine.id,
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
    });
    const store = await superStore(cluster, it.db);
    try {
      // The seam, built with the manager named BY ABSOLUTE PATH. A build that
      // ignores the parameter spawns the real binary and this log stays empty.
      const os = (thisOs as Function)({
        unitDir: fixture.unitDir(),
        bin: shim.here(),
      });

      const findings = await check({
        machine: machine.id,
        registryFile: it.registryFile,
        store,
        os,
        kernel: null,
      });

      // --- IT REALLY DID THE WORK. The stray is in the findings, so what is
      //     asserted below is a run that read the manager and not one that fell
      //     over before it got there.
      const extras = findings.filter((one) => one.kind === "unit-extra");
      expect(extras.map((one) => one.subject).join(" ")).toContain(stray.base);

      // --- AND IT WENT THROUGH THE SEAM. Not one line means the seam's binary
      //     parameter was ignored and the real manager answered instead, which
      //     is exactly the hole PATH fronting cannot see.
      const asked = shim.lines();
      expect(asked.length).toBeGreaterThan(0);
      // Every question was a reading one. The shim refuses anything else, so a
      // `check` that tried to act would be here in `mutating()` AND would have
      // thrown out of the run above.
      expect(shim.mutating()).toEqual([]);
      for (const line of asked) {
        expect(line.startsWith(process.platform === "darwin" ? "launchctl" : "systemctl")).toBe(
          true,
        );
      }

      // --- and the stray is still the same process. This is the assertion that
      //     stands behind the log whatever route a build took (checks 4 and 7's
      //     rule, applied to the file that names the residue).
      expect(livePid(stray.base)).toBe(strayPid);
      expect(pidAlive(strayPid)).toBe(true);
      expect(managerState(stray.base)!.running).toBe(true);
    } finally {
      shim.remove();
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

test(
  "RUN-04 no file under src/check names a service manager: the string launchctl and the string systemctl appear nowhere in it, because a name check can spell is a name check could invoke and the fix text a finding carries belongs to the OS seam that owns the flavour (SPEC §6, L13)",
  () => {
    const dir = hubPath("src/check");
    const files = readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile() && path.endsWith(".ts"));
    // The control: there IS a src/check to read, so an empty directory can
    // never pass this by accident.
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const name of ["launchctl", "systemctl"]) {
        if (!text.includes(name)) continue;
        const line = text.split("\n").findIndex((one) => one.includes(name)) + 1;
        offenders.push(`${file.slice(dir.length + 1)}:${line} names ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  },
  30_000,
);
