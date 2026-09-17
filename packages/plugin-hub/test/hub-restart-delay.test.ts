// Check: a killed listed process is back within the OS restart delay.
// (SPEC §6, L13) and Forbidden: "a supervisor of ours".
//
// NO CODE OF OURS RUNS DURING THIS CHECK, AND THAT ABSENCE IS THE LOAD. If the
// process comes back with nothing of ours alive, the restart can only have been
// the operating system's, which is what "a supervisor of ours is forbidden"
// means as a behaviour rather than as a grep.
//
// HOW THAT IS MADE LITERAL (the second seat's lead). The first shape of this
// check installed and started through `thisOs()` inside the test process, which
// then stayed alive for the whole check: an OS implementation carrying its own
// timer could have kickstarted the dead job and passed every assertion. So the
// install and the start happen in `test/helpers/os-once.ts`, a bun process that
// EXITS, and this file imports nothing from `src/` at all. It kills the pid and
// reads the manager itself through `test/helpers/manager.ts`. A supervisor of
// ours would have to have survived the death of the only process that ever
// built one.
//
// THE BOUND COMES FROM THE RENDERED UNIT, not from a number the test wrote
// twice. Measured on this Mac (03-BRIEF): a `KeepAlive` job is back 0.33 s after
// a `kill -9` with `ThrottleInterval` 1, and 9.14 s with the key absent, because
// launchd's own default throttle is 10 s. So the delay is read back out of the
// text the renderer produced, and a renderer that dropped the key fails on the
// clock rather than passing on a default nobody asked for.
//
// THE CONTROL IS IN THE SAME REGISTRY. A second entry with `schedule = "on
// demand"` renders without `Restart=always` and without `KeepAlive`, is started,
// is killed, and stays dead. One file, two entries, two opposite outcomes, so
// the check cannot pass on a box where everything restarts.
//
// Red reason: import missing, src/os/index.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath, until } from "./helpers/cluster.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { managerState, pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { writeRegistry } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";

const SLOW = 120_000;
const RESTART_DELAY = 1;

const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];
let dir: string;

beforeAll(async () => {
  announceGate(gate, "check 6, a killed listed process is back");
  dir = mkdtempSync(join(tmpdir(), "hub-delay-"));
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
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The delay the RENDERER put in the file, read back out of it. */
function renderedDelaySeconds(text: string): number {
  const systemd = /^RestartSec=(\d+)s?$/m.exec(text);
  if (systemd) return Number(systemd[1]);
  const launchd = /<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text);
  if (launchd) return Number(launchd[1]);
  throw new Error(
    "the rendered unit carries no restart delay at all, so a kill would wait out the manager's own default",
  );
}

/**
 * Render, install and start, in a process that EXITS before the kill.
 *
 * The second seat's lead: doing it through `thisOs()` inside the test process
 * left that process alive for the whole check, so an OS implementation carrying
 * its own timer could have kickstarted the dead job itself and satisfied every
 * assertion. The only process that ever built a seam object is gone before the
 * kill happens, and this file imports nothing from `src/` at all.
 */
async function installAndStartElsewhere(args: {
  unitDir: string;
  registryFile: string;
  machine: string;
  entryScript: string;
  entryIds: string[];
}): Promise<{ rendered: Record<string, string>; installed: string[]; flavour: string }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      hubPath("test/helpers/os-once.ts"),
      args.unitDir,
      args.registryFile,
      args.machine,
      args.entryScript,
      ...args.entryIds,
    ],
    { cwd: hubPath("."), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) {
    throw new Error(`test/helpers/os-once.ts printed no line. stdout: ${out.trim()} stderr: ${err.trim()}`);
  }
  const said = JSON.parse(line) as {
    ok: boolean;
    error?: string;
    rendered?: Record<string, string>;
    installed?: string[];
    flavour?: string;
  };
  if (!said.ok) throw new Error(String(said.error));
  return {
    rendered: said.rendered ?? {},
    installed: said.installed ?? [],
    flavour: String(said.flavour ?? ""),
  };
}

test.skipIf(!gate.ok)(
  `RUN-02 a killed listed process is back within the OS restart delay, with nothing of ours running: install and start happen in a process that has EXITED, the new pid differs, it appears inside the delay the RENDERER wrote plus slack, the manager's own restart counter climbed, and an on-demand entry in the same registry killed the same way stays dead (SPEC §6, L13 Forbidden, D-96, D-101)${gateSuffix(gate)}`,
  async () => {
    const machine = thisMachine();
    const residentId = fixture.entryId("resident");
    const onDemandId = fixture.entryId("ondemand");
    const registryFile = writeRegistry(dir, {
      hub: {
        state_dir: dir,
        restart_delay_seconds: RESTART_DELAY,
        give_up_after: 5,
        give_up_window_seconds: 300,
      },
      machines: [machine],
      run: [
        { id: residentId, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 64, child_memory_limit_mb: 64 },
        { id: onDemandId, kind: "runner", child_memory_limit_mb: 2048, machine: machine.id, schedule: "on demand", memory_limit_mb: 64 },
      ],
    });

    const jobs = join(dir, "jobs");
    mkdirSync(jobs, { recursive: true });
    const script = join(jobs, "alive.ts");
    writeFileSync(script, "await new Promise(() => {});\n", "utf8");

    // The only process that ever builds a seam object. It exits here.
    const staged = await installAndStartElsewhere({
      unitDir: fixture.unitDir(),
      registryFile,
      machine: machine.id,
      entryScript: script,
      entryIds: [residentId, onDemandId],
    });
    expect(listRunEntries(loadRegistry(registryFile)).map((e) => e.id).sort()).toEqual(
      [residentId, onDemandId].sort(),
    );

    const delay = renderedDelaySeconds(staged.rendered[residentId] ?? "");
    expect(delay).toBe(RESTART_DELAY);

    const residentUnit = `imprnt-hub-${residentId}`;
    const onDemandUnit = `imprnt-hub-${onDemandId}`;

    // --- the resident one: a real pid, killed hard, back on the OS's clock.
    //     Every reading below is the MANAGER's own, through a helper that
    //     imports nothing from src/.
    await until(
      "the resident unit is running with a real pid",
      () => {
        const found = managerState(residentUnit);
        return !!found && found.running && (found.pid ?? 0) > 0;
      },
      60_000,
      () => JSON.stringify(managerState(residentUnit)),
    );
    const first = managerState(residentUnit)!;
    const firstPid = Number(first.pid);
    const firstRestarts = Number(first.restarts ?? 0);
    expect(pidAlive(firstPid)).toBe(true);
    // A resident that has been started once and never died: D-101's counters
    // say exactly that, and they say it the same way on both managers.
    expect(first.ran).toBe(true);
    expect(firstRestarts).toBe(0);

    const killedAt = Date.now();
    process.kill(firstPid, 9);

    // The bound is the delay the renderer wrote plus two seconds of slack. With
    // the key dropped, launchd waits out its own ten second default and this
    // fails on the clock, which is the whole point of reading the number back
    // out of the rendered text.
    const bound = delay * 1000 + 2000;
    await until(
      "the operating system started it again",
      () => {
        const found = managerState(residentUnit);
        return !!found && (found.pid ?? 0) > 0 && found.pid !== firstPid;
      },
      bound,
      () => JSON.stringify(managerState(residentUnit)),
    );
    const back = managerState(residentUnit)!;
    expect(back.pid).not.toBe(firstPid);
    expect(pidAlive(Number(back.pid))).toBe(true);
    expect(Date.now() - killedAt).toBeLessThan(bound);
    // The manager's OWN counter climbed, so a check cannot pass on a process
    // that never actually died.
    expect(Number(back.restarts ?? 0)).toBeGreaterThan(firstRestarts);

    // --- THE CONTROL. Same registry, same manager, same kill. An on-demand
    //     entry wants to be LOADED and not running (D-97), so it stays dead.
    //     Read through the same independent helper, or the claim that nothing
    //     of ours is running leaks back in through this half.
    await until(
      "the on-demand unit ran once",
      () => (managerState(onDemandUnit)?.pid ?? 0) > 0,
      60_000,
      () => JSON.stringify(managerState(onDemandUnit)),
    );
    const idle = managerState(onDemandUnit)!;
    const idlePid = Number(idle.pid);
    process.kill(idlePid, 9);
    await Bun.sleep(delay * 1000 + 3000);
    const stillDead = managerState(onDemandUnit);
    expect(stillDead).not.toBeNull();
    // Loaded, and not running, which is the state the file asked for.
    expect(stillDead!.loaded).toBe(true);
    expect(stillDead!.running).toBe(false);
    expect(pidAlive(idlePid)).toBe(false);
  },
  SLOW,
);
