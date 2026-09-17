// Check: every resident piece has a peak on record. (SPEC §6, L4, RUN-11)
//
// L4: "every long-running program we ship has a known memory peak, measured
// once, written down." D-84 makes that a state sheet `memory_peak`, one row per
// id, with Postgres under the fixed id `postgres` because the household installs
// it from its own package manager and it is not a registry entry.
//
// "EVERY RESIDENT PIECE" IS DERIVED AND IS NOT A LIST: every `[[run]]` entry for
// this machine whose schedule is `always`, plus Postgres. A scheduled or
// on-demand piece is not resident and is never asked for a peak, or the finding
// is permanent, and a permanent finding is noise.
//
// THE UNIT IS THE LOAD. `/proc/<pid>/status` `VmRSS` and `ps -o rss=` are both
// KILOBYTES and `child_memory_limit_mb` is MEGABYTES, so a kB-read-as-bytes slip
// makes the memory watch fire 1024 times off in one direction and every "is it a
// positive number" assertion still passes. So the reading is asserted against a
// KNOWN CHANGE in size rather than against zero.
//
// THE PEAK THAT NEVER FALLS IS ASSERTED WHERE IT LIVES. `OsSeam.memory` is
// stateless on both platforms and returns `peak_bytes: null` on darwin, because
// the macOS kernel keeps no peak for a running process at all. The running
// maximum is the HUB's, accumulated in the sheet by `recordPeak` (D-84), so
// that is what this asserts. Putting the accumulator inside the reader would
// hide state in a function every caller reads as a probe, and would make "the
// peak never falls" unassertable on a Mac.
//
// TWO TESTS SINCE THE CLOSURE ROUND. 13a is everything that can be proved
// without a service manager: the resident set, the finding, the sheet's one row
// per id, the peak that never falls and a reading measured against a known
// change in size. 13b is the half the second seat found missing, at the bottom
// of this file: a LIVE HUB writing a resident's peak on its own tick, which no
// exercise of `recordPeak` from a test can stand in for.
//
// Red reason: import missing, src/hub/peak.ts and src/check/run.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster, type ReadyProcess } from "./helpers/cluster.ts";
import {
  growChild,
  residentBytes,
  spawnHolder,
  survivingHolders,
} from "./helpers/scripted-adapter.ts";
import { hubReader, stageHub, startHub, superStore } from "./helpers/hub-fixture.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { livePid, managerState, pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { writeRegistry } from "./helpers/registry.ts";
import type { Finding } from "./helpers/finding.ts";
import { loadRegistry } from "../src/registry/load.ts";

const SLOW = 120_000;
const TICK = 1;

let cluster: Cluster;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];

beforeAll(async () => {
  announceGate(gate, "check 13b, the hub records a resident's peak on its own tick");
  cluster = await startCluster();
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
});

afterAll(async () => {
  try {
    await fixture.removeAll();
    // INDEPENDENT PROOF that nothing this file spawned outlived it, asked of
    // the platform rather than of the fixture's own list.
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
  "RUN-11 every resident piece has a peak on record: the resident set is the always entries for this machine plus Postgres under its fixed id, a missing peak is a finding that clears when one is recorded, the sheet keeps one row per id, and a reading is bytes measured against a known change in size (SPEC §6, L4, D-84)",
  async () => {
    const { MEMORY_PEAK_SHEET, POSTGRES_PEAK_ID, recordPeak, readPeaks, residentIds } =
      await seam("src/hub/peak.ts");
    expect(typeof recordPeak).toBe("function");
    expect(typeof readPeaks).toBe("function");
    expect(typeof residentIds).toBe("function");
    expect(POSTGRES_PEAK_ID).toBe("postgres");
    expect(typeof MEMORY_PEAK_SHEET).toBe("string");
    const { runCheck } = await seam("src/check/run.ts");
    expect(typeof runCheck).toBe("function");
    const { thisOs } = await seam("src/os/index.ts");
    expect(typeof thisOs).toBe("function");

    const it = await stageHub(cluster, {
      machines: [
        { id: "pi", os: "linux" },
        { id: "mac", os: "macos" },
      ],
      run: [
        { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-test", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
        { id: "watch-bikes", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "every 30m", memory_limit_mb: 128 },
        { id: "transcriber", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "on demand", memory_limit_mb: 1024 },
        { id: "runner-mac", kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    });
    const store = await superStore(cluster, it.db);
    const sheet = hubReader(cluster, it.db, String(MEMORY_PEAK_SHEET));
    const holder = spawnHolder();
    try {
      const registry = loadRegistry(it.registryFile);

      // --- the resident set, derived from the file and never a list.
      const resident = ((residentIds as Function)(registry, "pi") as string[]).slice().sort();
      expect(resident).toEqual(["door-fake", "postgres", "runner-test"]);
      expect(resident).not.toContain("watch-bikes");
      expect(resident).not.toContain("transcriber");
      // The other machine's always entry is the other machine's to measure.
      expect(resident).not.toContain("runner-mac");
      expect(((residentIds as Function)(registry, "mac") as string[]).slice().sort()).toEqual([
        "postgres",
        "runner-mac",
      ]);

      // --- an empty sheet: one peak-missing per resident id, Postgres included.
      const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;
      const before = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
      });
      const missing = before.filter((f) => f.kind === "peak-missing");
      expect(missing.map((f) => f.subject).sort()).toEqual(resident);
      for (const finding of missing) {
        expect(finding.machine).toBe("pi");
        expect(finding.id).toContain("pi/");
        expect(finding.id).toContain(finding.subject);
        expect(typeof finding.fix).toBe("string");
        expect(finding.fix.length).toBeGreaterThan(0);
      }
      // Postgres by name, because it is the one id that is not in the registry.
      expect(missing.map((f) => f.subject)).toContain("postgres");

      // --- and the other direction, without which the finding is a report and
      //     not a rule.
      const record = recordPeak as (
        store: unknown,
        row: Record<string, unknown>,
      ) => Promise<void>;
      for (const id of resident) {
        await record(store, {
          id,
          bytes: 100 * 1024 * 1024,
          at: new Date().toISOString(),
          how: "sampled",
          machine: "pi",
          pid: holder.pid,
        });
      }
      const after = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
      });
      expect(after.filter((f) => f.kind === "peak-missing")).toEqual([]);

      const peaks = (await (readPeaks as Function)(store)) as { id: string; bytes?: number }[];
      expect(peaks.map((p) => p.id).sort()).toEqual(resident);

      // --- one row per id, edited in place. SPEC §7.
      const firstRow = await sheet.row("door-fake");
      expect(firstRow).not.toBeNull();
      await Bun.sleep(30);
      await record(store, {
        id: "door-fake",
        bytes: 250 * 1024 * 1024,
        at: new Date().toISOString(),
        how: "sampled",
        machine: "pi",
        pid: holder.pid,
      });
      const rows = (await sheet.rows()).filter((r) => r.id === "door-fake");
      expect(rows.length).toBe(1);
      expect(Number(rows[0].data.bytes)).toBe(250 * 1024 * 1024);
      expect(new Date(rows[0].updated_at).getTime()).toBeGreaterThan(
        new Date(firstRow!.updated_at).getTime(),
      );

      // --- THE PEAK THAT NEVER FALLS. A lower reading leaves the row alone,
      //     and the row still says how it was arrived at.
      await record(store, {
        id: "door-fake",
        bytes: 3 * 1024 * 1024,
        at: new Date().toISOString(),
        how: "sampled",
        machine: "pi",
        pid: holder.pid,
      });
      const held = (await sheet.rows()).filter((r) => r.id === "door-fake");
      expect(held.length).toBe(1);
      expect(Number(held[0].data.bytes)).toBe(250 * 1024 * 1024);
      expect(["vmhwm", "sampled", "time-l"]).toContain(String(held[0].data.how));

      // --- THE MEASUREMENT, real, through the seam, on a process this check
      //     owns. Read, grow by a known amount, read again, and assert the
      //     DELTA. That is the assertion a kilobyte-as-bytes slip fails, and an
      //     "is it positive" assertion does not.
      const os = (thisOs as Function)() as {
        memory(pid: number): Promise<{
          current_bytes: number;
          peak_bytes: number | null;
          source: string;
        }>;
      };
      await until("the holder is up", () => residentBytes(holder.pid) > 0, 15_000);
      const first = await os.memory(holder.pid);
      expect(first.current_bytes).toBeGreaterThan(0);
      expect(first.source).toBe(process.platform === "linux" ? "proc-status" : "ps-rss");

      const GROW_MB = 400;
      growChild(holder.pid, GROW_MB);
      await until(
        `the holder really holds ${GROW_MB} MB`,
        () => residentBytes(holder.pid) - first.current_bytes > 0.85 * GROW_MB * 1024 * 1024,
        60_000,
        () => `now ${residentBytes(holder.pid)} bytes, was ${first.current_bytes}`,
      );
      const second = await os.memory(holder.pid);
      const deltaMb = (second.current_bytes - first.current_bytes) / (1024 * 1024);
      expect(deltaMb).toBeGreaterThan(0.8 * GROW_MB);
      expect(deltaMb).toBeLessThan(1.5 * GROW_MB);

      // `MemoryPeak` is empty on systemd 252, so the kernel's own high-water
      // mark `VmHWM` is the peak on linux. macOS keeps none for a running
      // process, which is why the accumulation above lives in the sheet.
      if (process.platform === "linux") {
        expect(second.peak_bytes).not.toBeNull();
        expect(second.peak_bytes!).toBeGreaterThanOrEqual(second.current_bytes * 0.9);
      } else {
        expect(second.peak_bytes).toBeNull();
      }

      // And the reader accumulates NOTHING: a second read of a process that has
      // not grown gives the same size, not a running maximum.
      const third = await os.memory(holder.pid);
      expect(Math.abs(third.current_bytes - second.current_bytes)).toBeLessThan(
        0.2 * GROW_MB * 1024 * 1024,
      );
    } finally {
      holder.kill();
      await sheet.close().catch(() => {});
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// 13b. The half the second seat found missing.
//
// Everything above exercises `recordPeak` and `readPeaks` with rows the CHECK
// wrote, so a hub that never measured a resident of its own passes it: the same
// holder pid supplies every row, including the one filed under `postgres`.
// D-84's actual rule is "the hub writes the row on its tick and only when the
// reading exceeds the one on record", so this binds that: a live hub, a real
// unit it installed and started itself, and a row nobody in this test wrote,
// carrying at least the size this test measured independently and the pid the
// MANAGER reports for that unit.
//
// GATED, because it needs a real service manager to have a resident at all.
// The half above stays ungated, so a box with no manager still proves the
// resident set, the sheet and the reading.
//
// WHAT IT DELIBERATELY DOES NOT ASSERT: a row for `postgres`. D-84 puts the
// store in the resident set under a fixed id and says nothing about how a hub
// finds that process, so requiring the row here would be this check inventing a
// derivation the contract does not have. The `peak-missing:postgres` finding
// above is where that obligation lives.
//
// Red reason: import missing, src/hub/peak.ts and src/hub/run.ts.
// ---------------------------------------------------------------------------

test.skipIf(!gate.ok)(
  `RUN-11 the hub records a resident's peak on its OWN tick: a unit the hub installed and started gets a memory_peak row this test never wrote, carrying at least the size this test measured for that process itself, the pid the manager reports for it, this machine's id and a method from the closed set (SPEC §6, L4, D-84)${gateSuffix(gate)}`,
  async () => {
    const { MEMORY_PEAK_SHEET } = await seam("src/hub/peak.ts");
    expect(typeof MEMORY_PEAK_SHEET).toBe("string");

    const machine = thisMachine();
    const entryId = fixture.entryId("resident");
    const unit = `imprnt-hub-${entryId}`;

    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK, restart_delay_seconds: 1, give_up_after: 5, give_up_window_seconds: 300 },
      machines: [machine],
      run: [],
    });
    // The entry is a `kind = "runner"`, so what the hub renders is the entry
    // point D-94 pins and this round creates no file under `src/entry/`.
    writeRegistry(it.stateDir, {
      hub: {
        store_url: it.storeUrl,
        state_dir: it.stateDir,
        tick_seconds: TICK,
        restart_delay_seconds: 1,
        give_up_after: 5,
        give_up_window_seconds: 300,
      },
      machines: [machine],
      run: [
        {
          id: entryId,
          kind: "runner",
          machine: machine.id,
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
    });

    const sheet = hubReader(cluster, it.db, String(MEMORY_PEAK_SHEET));
    let hub: ReadyProcess | null = null;
    try {
      hub = await startHub(it.registryFile, machine.id, fixture.unitDir());

      await until(
        "the hub started the resident, with a live pid in the manager's own record",
        () => livePid(unit) !== null,
        90_000,
        () => JSON.stringify(managerState(unit)),
      );
      const pid = livePid(unit)!;
      expect(pidAlive(pid)).toBe(true);

      // THE TEST'S OWN READING, through `ps`, of the process the MANAGER named.
      // Nothing of the hub's is involved in it.
      const mine = residentBytes(pid);
      expect(mine).toBeGreaterThan(0);

      await until(
        "the hub wrote a peak for the resident it is running, at least the size this test read",
        async () => {
          const row = await sheet.row(entryId);
          return !!row && Number(row.data.bytes) >= mine;
        },
        90_000,
        async () => JSON.stringify(await sheet.rows()),
      );

      const row = (await sheet.row(entryId))!;
      // A row the test never wrote, about a process the test can name.
      expect(Number(row.data.bytes)).toBeGreaterThanOrEqual(mine);
      // And inside a band, so a build that wrote a large constant instead of a
      // reading fails rather than clearing the floor by a mile.
      expect(Number(row.data.bytes)).toBeLessThan(10 * mine);
      expect(Number(row.data.pid)).toBe(pid);
      expect(row.data.machine).toBe(machine.id);
      expect(["vmhwm", "sampled", "time-l"]).toContain(String(row.data.how));
      expect(typeof row.data.at).toBe("string");
      expect(Number.isFinite(new Date(String(row.data.at)).getTime())).toBe(true);

      // ONE ROW, still, after several more ticks: the sheet is edited in place
      // and a peak that never falls never grows a second line (SPEC §7).
      await Bun.sleep(TICK * 4000);
      expect((await sheet.rows()).filter((r) => r.id === entryId).length).toBe(1);
      expect(Number((await sheet.row(entryId))!.data.bytes)).toBeGreaterThanOrEqual(
        Number(row.data.bytes),
      );
    } finally {
      if (hub) await hub.stop();
      await sheet.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
