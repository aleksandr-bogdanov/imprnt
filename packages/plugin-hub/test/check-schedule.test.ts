// Check: every scheduled job's last success is recent. (SPEC §6, L13, RUN-04)
//
// L13: "a scheduled job whose last success is older than its interval plus a
// grace is reported, read from the job's OWN 'I ran and it landed' stamp,
// because systemd knows a job ran, not whether it worked", and its Forbidden
// line: "reading 'timer enabled' as 'job ran'". D-89 makes the stamp a state
// sheet `job_success`, one row per entry id, and makes a scheduled entry with NO
// row its own finding, because a job nobody ever stamped would otherwise look
// like a job that has not run yet, forever.
//
// Two checks. The first is the arithmetic and the stamp, pure over supplied data
// on both platforms. The second is the Forbidden line itself, against the real
// manager: a job that really ran, whose own record says it ran, and which is
// STILL reported because it wrote no success stamp.
//
// Red reasons: check 20 import missing, src/check/schedule.ts. Check 21 import
// missing, src/check/run.ts and src/os/index.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { hubReader, stageHub, superStore } from "./helpers/hub-fixture.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { managerState } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import type { Finding } from "./helpers/finding.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { readSheet } from "../src/records/statesheet.ts";

const SLOW = 150_000;
const GRACE = 300;

let cluster: Cluster;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];

beforeAll(async () => {
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
  cluster = await startCluster();
  announceGate(gate, "check 21, timer enabled is not job ran");
});

afterAll(async () => {
  try {
    // Exactly what this file created, and nothing else, even when a check threw.
    await fixture.removeAll();
  } finally {
    // THE CENSUS, which the second seat found missing from this file: every
    // other file that can create a unit proves it disturbed nothing, and a
    // file that only removes its own list proves only that it tried.
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

function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

test(
  "RUN-04 a scheduled job's staleness comes from its OWN success stamp: every interval parses and `always` and `on demand` have none, a stamp older than the interval plus the grace is a finding, a stamp the GRACE saves is not, a scheduled entry with no row at all is its own finding, and a second stamp edits one row (SPEC §6, L13, D-89)",
  async () => {
    const { intervalOf, JOB_SUCCESS_SHEET, recordJobSuccess, staleJobs } = await seam(
      "src/check/schedule.ts",
    );
    expect(typeof intervalOf).toBe("function");
    expect(typeof recordJobSuccess).toBe("function");
    expect(typeof staleJobs).toBe("function");
    expect(typeof JOB_SUCCESS_SHEET).toBe("string");

    const interval = intervalOf as (schedule: string) => number | null;
    const stamp = recordJobSuccess as (
      store: unknown,
      args: Record<string, unknown>,
    ) => Promise<void>;
    const stale = staleJobs as (args: Record<string, unknown>) => Finding[];

    // --- intervalOf, because everything else rests on it. A null interval
    //     means the entry is NOT a scheduled job and is never asked for a
    //     stamp, or the transcriber is reported stale forever and a permanent
    //     finding is noise.
    expect(interval("every 30m")).toBe(1800);
    expect(interval("every 15m")).toBe(900);
    expect(interval("hourly")).toBe(3600);
    expect(interval("always")).toBeNull();
    expect(interval("on demand")).toBeNull();

    const it = await stageHub(cluster, {
      hub: { job_grace_seconds: GRACE },
      machines: [{ id: "pi", os: "linux" }],
      run: [
        { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-test", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
        { id: "watch-bikes", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "every 30m", memory_limit_mb: 128 },
        { id: "backup", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "hourly", memory_limit_mb: 256 },
        { id: "transcriber", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "on demand", memory_limit_mb: 1024 },
      ],
    });
    const store = await superStore(cluster, it.db);
    try {
      const entries = listRunEntries(loadRegistry(it.registryFile));
      const now = new Date();

      // The stamps are WRITTEN by the code under test and READ BACK through
      // phase 1's shipped `readSheet`, so the shape `staleJobs` is handed is the
      // shape the build itself produced. A test that invented the row shape
      // would be guessing at a type the seam contract names but does not pin.
      const stamps = async () => await readSheet(store, String(JOB_SUCCESS_SHEET));

      // --- 1. a scheduled entry with NO row at all (L13's own words).
      const none = stale({ entries, stamps: await stamps(), graceSeconds: GRACE, now });
      expect(none.filter((f) => f.kind === "job-no-stamp").map((f) => f.subject).sort()).toEqual([
        "backup",
        "watch-bikes",
      ]);
      // job-no-stamp is a SEPARATE kind from job-stale: a job that has never
      // landed and a job that landed too long ago are different problems.
      expect(none.filter((f) => f.kind === "job-stale")).toEqual([]);
      // And the two that are not scheduled jobs are never asked.
      for (const finding of none) {
        expect(["watch-bikes", "backup"]).toContain(finding.subject);
      }

      // --- 2. a stamp inside the interval plus the grace. The control.
      await stamp(store, { entry: "watch-bikes", machine: "pi", at: ago(60) });
      await stamp(store, { entry: "backup", machine: "pi", at: ago(60) });
      const fresh = stale({ entries, stamps: await stamps(), graceSeconds: GRACE, now });
      expect(fresh).toEqual([]);

      // --- 3. a stamp older than the interval plus the grace.
      await stamp(store, { entry: "watch-bikes", machine: "pi", at: ago(1800 + GRACE + 120) });
      const old = stale({ entries, stamps: await stamps(), graceSeconds: GRACE, now });
      const late = old.filter((f) => f.kind === "job-stale");
      expect(late.length).toBe(1);
      expect(late[0].subject).toBe("watch-bikes");
      expect(late[0].machine).toBe("pi");
      expect(late[0].id).toContain("pi/");
      expect(/\d/.test(late[0].says)).toBe(true);
      expect(typeof late[0].fix).toBe("string");
      expect(late[0].fix.length).toBeGreaterThan(0);
      // The hourly one is untouched, so the arithmetic is per entry.
      expect(old.map((f) => f.subject)).not.toContain("backup");

      // --- 4. THE GRACE SAVES IT: older than the interval alone, younger than
      //     the interval plus the grace. Without this case the grace is a
      //     setting nothing in production reads, and RUN-07 forbids that.
      await stamp(store, { entry: "watch-bikes", machine: "pi", at: ago(1800 + Math.floor(GRACE / 2)) });
      expect(stale({ entries, stamps: await stamps(), graceSeconds: GRACE, now })).toEqual([]);
      // And with a grace of zero the very same stamp IS stale, so the number is
      // read rather than merely accepted.
      expect(
        stale({ entries, stamps: await stamps(), graceSeconds: 0, now })
          .filter((f) => f.kind === "job-stale")
          .map((f) => f.subject),
      ).toEqual(["watch-bikes"]);

      // --- 5. the always and on-demand entries produce NEITHER kind, ever.
      const everything = stale({ entries, stamps: [], graceSeconds: GRACE, now });
      for (const id of ["door-fake", "runner-test", "transcriber"]) {
        expect(everything.map((f) => f.subject)).not.toContain(id);
      }

      // --- 6. one row per entry, edited in place, and it clears the finding.
      const sheet = hubReader(cluster, it.db, String(JOB_SUCCESS_SHEET));
      try {
        const rows = (await sheet.rows()).filter((r) => r.id === "watch-bikes");
        expect(rows.length).toBe(1);
        expect(typeof rows[0].data.at).toBe("string");
        expect(rows[0].data.machine).toBe("pi");
        await Bun.sleep(30);
        await stamp(store, { entry: "watch-bikes", machine: "pi" });
        const after = (await sheet.rows()).filter((r) => r.id === "watch-bikes");
        expect(after.length).toBe(1);
        expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(
          new Date(rows[0].updated_at).getTime(),
        );
        expect(
          stale({ entries, stamps: await stamps(), graceSeconds: GRACE, now: new Date() }).filter(
            (f) => f.subject === "watch-bikes",
          ),
        ).toEqual([]);
      } finally {
        await sheet.close().catch(() => {});
      }
    } finally {
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `RUN-04 reading "timer enabled" as "job ran" is absent: a scheduled job really runs and the manager's OWN record says it RAN and exited zero, on both flavours and read independently of the seam as well as through it, and check still reports it because the job wrote no success stamp of its own, which the stamp then clears (SPEC §6 Forbidden, L13, D-89, D-101, D-102)${gateSuffix(gate)}`,
  async () => {
    // No hub process runs in this check, so nothing removes a unit behind its
    // back (a live hub removes any render-prefix unit with no registry entry).
    const { thisOs } = await seam("src/os/index.ts");
    expect(typeof thisOs).toBe("function");
    const { runCheck } = await seam("src/check/run.ts");
    expect(typeof runCheck).toBe("function");
    const { recordJobSuccess } = await seam("src/check/schedule.ts");
    expect(typeof recordJobSuccess).toBe("function");

    const machine = thisMachine();
    const entryId = fixture.entryId("landed-nothing");
    const it = await stageHub(cluster, {
      hub: { job_grace_seconds: 0, restart_delay_seconds: 1, give_up_after: 5, give_up_window_seconds: 300 },
      machines: [machine],
      run: [
        { id: "door-fake", kind: "door", machine: machine.id, platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-test", kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
        { id: entryId, kind: "runner", child_memory_limit_mb: 2048, machine: machine.id, schedule: "every 30m", memory_limit_mb: 64 },
      ],
    });
    const store = await superStore(cluster, it.db);
    try {
      // A job that runs and lands NOTHING. The script is the check's own, in
      // its own scratch dir: no `src/entry/` file is created this round.
      const jobDir = join(it.stateDir, "jobs");
      mkdirSync(jobDir, { recursive: true });
      const script = join(jobDir, "lands-nothing.ts");
      writeFileSync(script, "process.exit(0);\n", "utf8");

      const os = (thisOs as Function)({ unitDir: fixture.unitDir() }) as {
        render(entry: unknown, ctx: unknown): { path: string; text: string }[];
        install(files: unknown[]): Promise<string[]>;
        start(entryId: string): Promise<void>;
        show(entryId: string): Promise<Record<string, unknown> | null>;
      };
      const entry = listRunEntries(loadRegistry(it.registryFile)).find((e) => e.id === entryId)!;
      await os.install(
        os.render(entry, {
          machine: machine.id,
          execPath: process.execPath,
          entryScript: script,
          registryFile: it.registryFile,
          restartDelaySeconds: 1,
          giveUpAfter: 5,
          giveUpWindowSeconds: 300,
        }),
      );
      await os.start(entryId);

      // FIRST, the manager's OWN record says it ran. Without this the rest of
      // the check is about a job that never started and proves nothing.
      //
      // `ran`, NOT `restarts` (D-101). The second seat read a conflict between
      // this check and check 23 and it was real: the seam carried one counter
      // mapped to systemd's `NRestarts` and launchd's `runs`, and those count
      // different things. A job that ran once and exited cleanly has `runs = 1`
      // on launchd and `NRestarts = 0` on systemd, so "it ran" could not be
      // asked of that field on both flavours, while check 23's healthy control
      // needs the restart count to be zero for exactly the same job. `ran` is
      // the separate signal, and `start` executes the program now rather than
      // merely enabling a cadence (D-102), which is what makes this reachable
      // for an `every 30m` entry inside a test's lifetime.
      await until(
        "the manager's own record says the job ran and exited cleanly",
        async () => {
          const state = await os.show(entryId);
          return !!state && state.ran === true && Number(state.lastExit ?? -1) === 0;
        },
        60_000,
        async () => JSON.stringify(await os.show(entryId)),
      );
      // The same two facts read from the manager directly, so a seam that
      // reported `ran` without asking anything is caught here rather than
      // believed.
      const byManager = managerState(`imprnt-hub-${entryId}`);
      expect(byManager).not.toBeNull();
      expect(byManager!.ran).toBe(true);
      expect(byManager!.lastExit).toBe(0);

      // AND YET. The operating system knows a job ran. It does not know whether
      // it worked, and that is the sentence this check exists to hold.
      const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;
      const reported = await check({
        machine: machine.id,
        registryFile: it.registryFile,
        store,
        os,
        kernel: null,
      });
      const about = reported.filter((f) => f.subject === entryId);
      expect(about.map((f) => f.kind)).toContain("job-no-stamp");

      // The control, which makes it a rule and not a permanent complaint: the
      // stamp the real job will write clears it, and its row leaves the sheet.
      await (recordJobSuccess as Function)(store, { entry: entryId, machine: machine.id });
      const cleared = await check({
        machine: machine.id,
        registryFile: it.registryFile,
        store,
        os,
        kernel: null,
      });
      const still = cleared.filter(
        (f) => f.subject === entryId && (f.kind === "job-no-stamp" || f.kind === "job-stale"),
      );
      expect(still).toEqual([]);
    } finally {
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
