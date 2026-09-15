// 03b item 2. Postgres is DECLARED, and the hub reads its pid from the file the
// standard install writes. (SPEC §1 and §6, L4, D-84)
//
// BUILD-NOTES 9 recorded the derivation phase 3 picked and called it a residue:
// the hub asks the store for `pg_backend_pid()`, reads that process's parent and
// believes it when the parent's command name contains `postgres`. It works, and
// it is a guess about process trees rather than a fact the household declared.
// The standard derivation, measured on both boxes this evening, is that every
// standard install writes a pid file: `/var/run/postgresql/<n>-main.pid` on
// Debian, `postmaster.pid` inside the data directory under Homebrew. So the
// registry gains a `[store]` section naming it, the install script writes that
// section once per box, and the hub reads the first line. No `sudo`, no
// `pgrep`, and nothing derived from a process tree that is only true when the
// store happens to be on this machine.
//
// THE PID IS THE ASSERTION, and it is why this check can fail. `postmasterPid`
// already ships and already answers on this Mac, so a check that only asked for
// a `postgres` row would pass on arrival. The pid file below names a process
// this test spawned, which is NOT the postmaster, so a hub still deriving from
// the backend's parent writes the wrong number here and fails.
//
// Red reasons. Test 1: export missing, `readStorePid` in `src/hub/peak.ts`, and
// behaviour absent, `SETTING_FIELDS` declares neither `store.pid_file` nor
// `store.unit`. Test 2: behaviour absent, the hub derives Postgres's pid from
// `pg_backend_pid()`'s parent (`src/hub/run.ts`'s `postmasterPid`), so the row
// it writes carries the cluster's postmaster and never the pid the registry
// pointed at.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, seam, until, type Cluster, type ReadyProcess } from "./helpers/cluster.ts";
import {
  hubReader,
  scratchDir,
  stageHub,
  startHub,
  superStore,
} from "./helpers/hub-fixture.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import {
  residentBytes,
  spawnHolder,
  survivingHolders,
  type HeldChild,
} from "./helpers/scripted-adapter.ts";
import type { Finding } from "./helpers/finding.ts";
import { loadRegistry, SETTING_FIELDS } from "../src/registry/load.ts";

const SLOW = 150_000;
const TICK = 1;

let cluster: Cluster;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];
const spares: HeldChild[] = [];

beforeAll(async () => {
  announceGate(gate, "03b item 2, the hub reads Postgres's pid from the declared file");
  cluster = await startCluster();
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
});

afterAll(async () => {
  try {
    for (const spare of spares) spare.kill();
    await fixture.removeAll();
    await until(
      "every memory holder left the box",
      () => survivingHolders().length === 0,
      15_000,
      () => `still holding: ${survivingHolders().join(", ")}`,
    );
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

test(
  "SPEC §1 the store declares where its own pid file is: readStorePid returns the first line of the declared file, returns null and says why for a file that is absent, for one whose first line is not a pid and for a registry with no [store] section at all, and both store settings are declared the way every other setting is (SPEC §1 and §6, RUN-06, L4, D-84)",
  async () => {
    const { readStorePid } = await seam("src/hub/peak.ts");
    expect(typeof readStorePid).toBe("function");
    const read = readStorePid as (
      registry: unknown,
    ) => { pid: number | null; reason: string | null };

    // RUN-06: every setting the code reads has a field in the file, declared
    // here, so `readSetting` answers for it instead of refusing the key.
    const declared = new Map(SETTING_FIELDS.map((field) => [field.key, field]));
    for (const key of ["store.pid_file", "store.unit"]) {
      expect(declared.has(key)).toBe(true);
      expect(declared.get(key)!.type).toBe("string");
      expect(declared.get(key)!.required ?? false).toBe(false);
    }

    const dir = await scratchDir("hub-pidfile-");
    const holder = spawnHolder();
    spares.push(holder);
    try {
      // A pid file the way Postgres writes one: the pid FIRST, then the data
      // directory and the rest of the postmaster's own lines. A reader that
      // parsed the whole file rather than its first line fails here.
      const good = join(dir, "postmaster.pid");
      writeFileSync(
        good,
        `${holder.pid}\n/var/lib/postgresql/17/main\n1757961600\n5432\n/tmp\n*\n  5432001         0\nready   \n`,
        "utf8",
      );

      const found = read(stagedRegistry(dir, { pid_file: good, unit: "postgresql@17" }));
      expect(found.pid).toBe(holder.pid);
      expect(found.reason).toBeNull();

      // --- absent. Null and a reason NAMING THE FILE, because a household that
      //     moved its cluster has to be told which path was tried.
      const missing = join(dir, "not-here.pid");
      const absent = read(stagedRegistry(dir, { pid_file: missing }));
      expect(absent.pid).toBeNull();
      expect(String(absent.reason)).toContain(missing);

      // --- malformed. The same answer, and never a NaN passed on as a pid.
      const junk = join(dir, "junk.pid");
      writeFileSync(junk, "no pid here\n/var/lib/postgresql\n", "utf8");
      const broken = read(stagedRegistry(dir, { pid_file: junk }));
      expect(broken.pid).toBeNull();
      expect(String(broken.reason)).toContain(junk);

      // --- no [store] section at all. Not an error: it is a file that has not
      //     been through the install script, and the honest answer is that
      //     nothing was declared.
      const undeclared = read(stagedRegistry(dir, null));
      expect(undeclared.pid).toBeNull();
      expect(typeof undeclared.reason).toBe("string");
      expect(undeclared.reason!.length).toBeGreaterThan(0);

      // --- and a pid file naming a process that is GONE is not a pid either.
      const dead = join(dir, "dead.pid");
      holder.kill();
      await until("the holder really went away", () => !alive(holder.pid), 10_000);
      writeFileSync(dead, `${holder.pid}\n`, "utf8");
      const stale = read(stagedRegistry(dir, { pid_file: dead }));
      expect(stale.pid).toBeNull();
      expect(String(stale.reason)).toContain(String(holder.pid));
    } finally {
      holder.kill();
    }
  },
  SLOW,
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A registry file on disk with, or without, a `[store]` section. */
function stagedRegistry(
  dir: string,
  store: { pid_file?: string; unit?: string } | null,
): unknown {
  const machine = thisMachine();
  const lines = [
    "[hub]",
    "tick_seconds = 5",
    "",
    ...(store
      ? [
          "[store]",
          ...(store.pid_file ? [`pid_file = ${JSON.stringify(store.pid_file)}`] : []),
          ...(store.unit ? [`unit = ${JSON.stringify(store.unit)}`] : []),
          "",
        ]
      : []),
    "[[machines]]",
    `id = ${JSON.stringify(machine.id)}`,
    `os = ${JSON.stringify(machine.os)}`,
    "",
    "[[run]]",
    'id = "runner-here"',
    'kind = "runner"',
    `machine = ${JSON.stringify(machine.id)}`,
    'schedule = "always"',
    "memory_limit_mb = 512",
    "child_memory_limit_mb = 512",
    "",
  ];
  const file = join(dir, `registry-${crypto.randomUUID().slice(0, 8)}.toml`);
  writeFileSync(file, lines.join("\n"), "utf8");
  return loadRegistry(file);
}

test.skipIf(!gate.ok)(
  `RUN-11 the hub measures the process the registry pointed at: with a [store] naming a pid file whose pid is a process this test owns, a memory_peak row for postgres appears carrying THAT pid and clears the finding, and with no [store] at all the hub records nothing for postgres and check keeps peak-missing:postgres (SPEC §6, L4, D-84)${gateSuffix(gate)}`,
  async () => {
    const { MEMORY_PEAK_SHEET, POSTGRES_PEAK_ID } = await seam("src/hub/peak.ts");
    expect(POSTGRES_PEAK_ID).toBe("postgres");
    const { runCheck } = await seam("src/check/run.ts");
    const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;

    const machine = thisMachine();
    const holder = spawnHolder();
    spares.push(holder);
    const dir = await scratchDir("hub-pidfile-live-");
    const pidFile = join(dir, "postmaster.pid");
    writeFileSync(pidFile, `${holder.pid}\n${dir}\n`, "utf8");

    // No `[[run]]` entries at all, so the hub installs nothing and the only
    // resident it has to measure is the store.
    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK, restart_delay_seconds: 1 },
      store: { pid_file: pidFile, unit: "postgresql@17" },
      machines: [machine],
      run: [],
    });
    const sheet = hubReader(cluster, it.db, String(MEMORY_PEAK_SHEET));
    const store = await superStore(cluster, it.db);
    let hub: ReadyProcess | null = null;
    try {
      await until("the holder is up", () => residentBytes(holder.pid) > 0, 15_000);
      const mine = residentBytes(holder.pid);
      expect(mine).toBeGreaterThan(0);

      hub = await startHub(it.registryFile, machine.id, fixture.unitDir());
      await until(
        "the hub wrote a postgres peak for the pid the registry pointed at",
        async () => {
          const row = await sheet.row("postgres");
          return !!row && Number(row.data.pid) === holder.pid;
        },
        25_000,
        async () => JSON.stringify(await sheet.rows()),
      );

      const row = (await sheet.row("postgres"))!;
      expect(Number(row.data.pid)).toBe(holder.pid);
      // A reading, inside a band, so a build that filed a constant fails.
      expect(Number(row.data.bytes)).toBeGreaterThanOrEqual(mine);
      expect(Number(row.data.bytes)).toBeLessThan(10 * mine);
      expect(row.data.machine).toBe(machine.id);
      expect(["vmhwm", "sampled", "time-l"]).toContain(String(row.data.how));

      // The finding clears, which is the other half of the rule.
      const after = await check({
        machine: machine.id,
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
      });
      expect(after.filter((one) => one.subject === "postgres")).toEqual([]);

      await hub.stop();
      hub = null;
    } finally {
      if (hub) await hub.stop();
      await sheet.close().catch(() => {});
      await store.close().catch(() => {});
      await it.stop();
    }

    // --- AND THE HONEST STATE. A registry with no `[store]` section declares
    //     nothing about the store's process, so the hub measures nothing for it
    //     and the finding stands. This is the half that fails against a hub
    //     that guesses at a process tree instead of reading the file.
    const quiet = await stageHub(cluster, {
      hub: { tick_seconds: TICK, restart_delay_seconds: 1 },
      machines: [machine],
      run: [],
    });
    const quietSheet = hubReader(cluster, quiet.db, String(MEMORY_PEAK_SHEET));
    const quietStore = await superStore(cluster, quiet.db);
    let second: ReadyProcess | null = null;
    try {
      second = await startHub(quiet.registryFile, machine.id, fixture.unitDir());
      // Several ticks, so "nothing was written" is a claim about a hub that had
      // every chance to write.
      await Bun.sleep(TICK * 5000);
      expect(await quietSheet.row("postgres")).toBeNull();
      const findings = await check({
        machine: machine.id,
        registryFile: quiet.registryFile,
        store: quietStore,
        os: null,
        kernel: null,
      });
      const missing = findings.filter((one) => one.kind === "peak-missing");
      expect(missing.map((one) => one.subject)).toContain("postgres");
    } finally {
      if (second) await second.stop();
      await quietSheet.close().catch(() => {});
      await quietStore.close().catch(() => {});
      await quiet.stop();
    }
  },
  SLOW,
);
