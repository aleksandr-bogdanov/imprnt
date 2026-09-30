// A hub that starts against a manager that lost some of what the registry
// declares loads it, and asks for no explicit start or restart of scheduled
// work. (SPEC §6, D7, L13)
//
// THE TIMELINE IS THE CUTOVER'S. A first hub installs and starts everything, and
// stops. While no hub runs, maintenance happens: on a Mac some jobs are booted
// out and their plists stay on disk, and on a Pi the timers are stopped while
// every file stays byte for byte the same. A second hub starts against that. It
// must bring back what is missing and touch nothing that is not: not a healthy
// resident, not a run in progress, not an entry the household stopped, not an
// entry another machine's hub owns.
//
// THE MANAGER IS A STATEFUL FAKE, in process, and it keeps the two facts the
// bugs were about. On launchd `start` of a job that is not in the domain FAILS,
// as `kickstart` does, so a hub that only started would leave it missing and say
// so in the ledger. On systemd `show` reports the timer beside the service, so a
// scheduled entry reads scheduled only while its timer is active. What the real
// seams print and parse is asserted in `unit-schedule-arming.test.ts`.
//
// WHAT THE FAKE CANNOT SAY. Its timers never elapse and its jobs never catch up,
// so a scheduled service that stays idle here is a fixture result. A real
// manager restoring an overdue interval or a persistent calendar timer may run
// the service promptly, and that is the declared cadence and not a defect. What
// is asserted is the hub's own behaviour: which verbs it asked for.
//
// Red reason: `load` is absent from the hub's reconcile and from both seams, so
// nothing is loaded and a stopped timer reads scheduled.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub } from "./helpers/hub-fixture.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { observe } from "./helpers/rollout-runner.ts";
import { runHub } from "../src/hub/run.ts";
import { readStatus } from "../src/hub/status.ts";
import { launchd } from "../src/os/launchd.ts";
import { unitName } from "../src/os/names.ts";
import { systemd } from "../src/os/systemd.ts";
import type { OsSeam, UnitState } from "../src/os/types.ts";

const SLOW = 120_000;
const MACHINE = process.platform === "darwin" ? "mac" : "pi";
const MACHINE_OS = process.platform === "darwin" ? "macos" : "linux";
const OTHER = MACHINE === "mac" ? "pi" : "mac";
const OTHER_OS = MACHINE === "mac" ? "linux" : "macos";

let cluster: Cluster;
const scratch: string[] = [];
beforeAll(async () => {
  cluster = await startCluster();
});
afterAll(async () => {
  try {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  } finally {
    await cluster?.stop();
  }
});

const resident = (id: string): RunSpec => ({
  id, kind: "runner", machine: MACHINE, schedule: "always", memory_limit_mb: 256, child_memory_limit_mb: 256,
});
const job = (id: string, schedule: string, extra: Partial<RunSpec> = {}): RunSpec => ({
  id, kind: "runner", machine: MACHINE, schedule, memory_limit_mb: 128, child_memory_limit_mb: 128, ...extra,
});

const LOST = resident("runner-lost");
const HEALTHY = resident("runner-healthy");
const INTERVAL = job("sync-interval", "every 15m");
const CALENDAR = job("sync-calendar", "daily at 07:05");
const MANUAL = job("tool-manual", "on demand");
const HELD = job("sync-held", "every 15m", { enabled: false });
const AWAY = job("sync-away", "every 15m", { machine: OTHER });
const RUN = [LOST, HEALTHY, INTERVAL, CALENDAR, MANUAL, HELD, AWAY];

async function stage() {
  return await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [
      { id: MACHINE, os: MACHINE_OS },
      { id: OTHER, os: OTHER_OS },
    ],
    run: RUN,
  });
}

type Flavour = "launchd" | "systemd";

/**
 * The manager, with a memory. Every ask lands in `calls`, so what the hub did is
 * read off what it asked, and `maintenance` is what happens between two hubs.
 */
function manager(flavour: Flavour, dir: string) {
  mkdirSync(dir, { recursive: true });
  const renderer = flavour === "systemd" ? systemd({ unitDir: dir }) : launchd({ unitDir: dir });
  const calls: { operation: string; target: string }[] = [];
  const carried = new Set<string>();               // launchd: in the domain. systemd: never removed
  const running = new Map<string, number>();       // entry id -> pid of the program
  const timers = new Map<string, "active" | "inactive">();
  const failLoad = new Set<string>();
  const failInstall = new Set<string>();           // each id fails its NEXT install once, then installs
  let nextPid = 30_000;
  const idOf = (path: string) => /imprnt-hub-(.+)\.(?:service|timer|plist)$/.exec(path)?.[1] ?? "";

  const serviceOf = (id: string): UnitState => {
    const up = running.has(id);
    const base = {
      loaded: true, running: up, pid: running.get(id) ?? null, runs: flavour === "launchd" ? (up ? 1 : 0) : null,
      ran: up, restarts: 0, lastExit: null, since: null, result: null,
    };
    return flavour === "launchd"
      ? { ...base, name: unitName(id), state: up ? "running" : "not running" }
      : { ...base, name: `${unitName(id)}.service`, state: up ? "active" : "inactive" };
  };
  const timerOf = (id: string): UnitState => ({
    name: `${unitName(id)}.timer`, loaded: true, running: false, pid: null, runs: null, ran: true, restarts: null,
    lastExit: null, since: null, state: timers.get(id) ?? "inactive", result: null,
  });
  const unreadOf = (id: string): UnitState => ({ ...serviceOf(id), loaded: false, running: false, pid: null, state: null, ran: false, runs: null });

  const os: OsSeam = {
    flavour,
    render: renderer.render,
    async install(files) {
      const target = idOf(files[0]?.path ?? "");
      if (failInstall.delete(target)) {
        calls.push({ operation: "install-failed", target });
        throw new Error(`install: ${target}: Bootstrap failed: 5: Input/output error`);
      }
      for (const file of files) {
        writeFileSync(file.path, file.text, "utf8");
        const id = idOf(file.path);
        if (file.path.endsWith(".timer")) {
          if (file.text.includes("[Install]")) timers.set(id, "active");
          continue;
        }
        carried.add(id);
        if (flavour === "launchd" && /<key>RunAtLoad<\/key>\s*<true\/>/.test(file.text)) running.set(id, nextPid++);
      }
      calls.push({ operation: "install", target: idOf(files[0]?.path ?? "") });
      return files.map((file) => file.path);
    },
    async load(id, wanted) {
      calls.push({ operation: "load", target: id });
      if (failLoad.has(id)) throw new Error(`load: ${id}: Bootstrap failed: 5: Input/output error`);
      if (flavour === "systemd") {
        if (wanted !== "scheduled" || timers.get(id) === "active") return false;
        timers.set(id, "active");
        return true;
      }
      if (carried.has(id)) return false;
      const text = readFileSync(join(dir, `${unitName(id)}.plist`), "utf8");
      carried.add(id);
      if (/<key>RunAtLoad<\/key>\s*<true\/>/.test(text)) running.set(id, nextPid++);
      return true;
    },
    async start(id) {
      calls.push({ operation: "start", target: id });
      if (flavour === "launchd" && !carried.has(id)) throw new Error(`start: ${id}: Could not find service`);
      running.set(id, nextPid++);
    },
    async stop(id) {
      calls.push({ operation: "stop", target: id });
      running.delete(id);
      if (flavour === "launchd") carried.delete(id);
      else if (timers.has(id)) timers.set(id, "inactive");
    },
    async restart(id) {
      calls.push({ operation: "restart", target: id });
    },
    async remove(id) {
      calls.push({ operation: "remove", target: id });
      carried.delete(id);
      running.delete(id);
      timers.delete(id);
    },
    async list() {
      return [...carried].flatMap((id) => (flavour === "systemd" && timers.has(id) ? [serviceOf(id), timerOf(id)] : [serviceOf(id)]));
    },
    async show(id) {
      // A plist on disk that is not in the domain is a unit that exists.
      if (!carried.has(id)) return flavour === "launchd" && existsSync(join(dir, `${unitName(id)}.plist`)) ? unreadOf(id) : null;
      return flavour === "systemd" && timers.has(id) ? { ...serviceOf(id), timer: timerOf(id) } : serviceOf(id);
    },
    async memory() {
      return { current_bytes: 4096, peak_bytes: 8192, source: "ps-rss" };
    },
    async available() {
      return { ok: true, reason: "a manager this test keeps in memory" };
    },
  };
  return {
    os,
    calls,
    failLoad,
    failInstall,
    /** What the hub asked since the last mark, reads excluded because it makes none through here. */
    since: (from: number) => calls.slice(from),
    pidOf: (id: string) => running.get(id) ?? null,
    timerOf: (id: string) => timers.get(id) ?? null,
    /** The maintenance between two hubs. */
    bootout: (id: string) => { carried.delete(id); running.delete(id); },
    /** The plist itself is gone too, so the hub must render and install it again. */
    lose: (id: string) => { carried.delete(id); running.delete(id); rmSync(join(dir, `${unitName(id)}.plist`), { force: true }); },
    stopTimer: (id: string) => { timers.set(id, "inactive"); },
    midRun: (id: string) => { running.set(id, nextPid++); },
  };
}

const ticks = (seconds: number) => Bun.sleep(seconds * 1000);

async function firstHub(it: Awaited<ReturnType<typeof stage>>, m: ReturnType<typeof manager>) {
  const hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: m.os });
  const settled = await observe(
    () => [LOST, HEALTHY].every((entry) => m.pidOf(entry.id) !== null),
    20_000,
  );
  await hub.stop();
  expect(settled, "the first hub installed and started both residents").toBe(true);
}

for (const flavour of ["launchd", "systemd"] as const) {
  test(
    `${flavour}: a hub that starts against lost units loads exactly what is missing, asks for no start of scheduled work, and a second pass is quiet`,
    async () => {
      const it = await stage();
      const dir = mkdtempSync(join(tmpdir(), "hub-startup-units-"));
      scratch.push(dir);
      const m = manager(flavour, dir);
      let hub: Awaited<ReturnType<typeof runHub>> | undefined;
      try {
        await firstHub(it, m);
        const healthyPid = m.pidOf(HEALTHY.id);

        // MAINTENANCE, with no hub running and every file untouched.
        let lost: string[];
        if (flavour === "launchd") {
          for (const entry of [LOST, INTERVAL, MANUAL]) m.bootout(entry.id);
          m.midRun(CALENDAR.id);                 // a run in progress, in the domain
          lost = [LOST.id, INTERVAL.id, MANUAL.id];
        } else {
          for (const entry of [INTERVAL, CALENDAR]) m.stopTimer(entry.id);
          m.midRun(CALENDAR.id);                 // and its service is running right now
          lost = [INTERVAL.id, CALENDAR.id];
        }
        const midRunPid = m.pidOf(CALENDAR.id);

        // The status the cutover read was a lie about the Pi: scheduled, seen
        // scheduled, timers dead. Read against the manager as it now stands.
        if (flavour === "systemd") {
          const rows = await readStatus({ registryFile: it.registryFile, machine: MACHINE, os: m.os });
          expect(rows.find((row) => row.id === INTERVAL.id)).toMatchObject({ wanted: "scheduled", seen: "stopped" });
          expect(rows.find((row) => row.id === HEALTHY.id)).toMatchObject({ wanted: "running", seen: "running" });
        }

        const mark = m.calls.length;
        hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: m.os });
        const loaded = () => m.since(mark).filter((call) => call.operation === "load" && lost.includes(call.target)).map((call) => call.target);
        expect(await observe(() => [...new Set(loaded())].length === lost.length, 20_000), "every lost unit was loaded").toBe(true);
        // Then long enough for several more passes: a hub that reconciled
        // without remembering would load again, or start something.
        await ticks(3.5);

        const after = m.since(mark);
        const asked = (operation: string) => after.filter((call) => call.operation === operation).map((call) => call.target).sort();
        // Loaded once each, and only what was lost.
        expect(asked("load").filter((id) => lost.includes(id))).toEqual([...lost].sort());
        expect(asked("load").every((id) => lost.includes(id))).toBe(true);
        // Started: the resident launchd no longer had, because `kickstart` on it
        // is what would have failed, and NO EXPLICIT START of anything scheduled
        // or on demand.
        expect(asked("start")).toEqual(flavour === "launchd" ? [LOST.id] : []);
        expect(after.filter((call) => ["stop", "restart", "remove"].includes(call.operation))).toEqual([]);

        // The state, from this fake's own record: scheduled work was armed and
        // this fake started nothing for it (a real manager may catch up on its
        // own), and what was healthy or mid-run is the same process.
        if (flavour === "launchd") {
          expect(m.pidOf(LOST.id)).not.toBeNull();
          for (const entry of [INTERVAL, MANUAL]) expect(m.pidOf(entry.id)).toBeNull();
        } else {
          for (const entry of [INTERVAL, CALENDAR]) expect(m.timerOf(entry.id)).toBe("active");
          expect(m.pidOf(INTERVAL.id)).toBeNull();
        }
        expect(m.pidOf(HEALTHY.id)).toBe(healthyPid);
        expect(m.pidOf(CALENDAR.id)).toBe(midRunPid);

        // Untouched: the entry the file stopped and the entry another machine
        // owns get no verb of any kind, and neither does the healthy resident.
        for (const id of [HELD.id, AWAY.id, HEALTHY.id]) {
          expect(after.filter((call) => call.target === id), `${id} was left alone`).toEqual([]);
        }
        if (flavour === "systemd") expect(m.timerOf(HELD.id)).toBeNull();

        // The ledger says what was done, once each, and blames nobody.
        const events = await it.read.ledger({ stream: "machine", kind: "unit.loaded" });
        expect(events.map((event) => event.subject).sort()).toEqual([...lost].sort());
        const refused = (await it.read.ledger({ stream: "machine", kind: "failed" }))
          .filter((row) => ["install", "load", "start", "stop"].includes(String((row.detail as { operation?: string }).operation)));
        expect(refused).toEqual([]);

        // And the status now agrees with the manager.
        const rows = await readStatus({ registryFile: it.registryFile, machine: MACHINE, os: m.os });
        expect(rows.find((row) => row.id === INTERVAL.id)).toMatchObject({ wanted: "scheduled", seen: "scheduled" });
        expect(rows.find((row) => row.id === HELD.id)).toMatchObject({ wanted: "stopped", seen: "stopped" });
      } finally {
        await hub?.stop();
        await it.stop();
      }
    },
    SLOW,
  );
}

test(
  "a unit that cannot be loaded is a recorded failure and is not started, and the others are still loaded",
  async () => {
    const it = await stage();
    const dir = mkdtempSync(join(tmpdir(), "hub-startup-units-"));
    scratch.push(dir);
    const m = manager("launchd", dir);
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      await firstHub(it, m);
      for (const entry of [LOST, INTERVAL]) m.bootout(entry.id);
      m.failLoad.add(LOST.id);

      const mark = m.calls.length;
      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: m.os });
      expect(await observe(() => m.pidOf(INTERVAL.id) === null && m.since(mark).some((call) => call.operation === "load" && call.target === INTERVAL.id), 20_000)).toBe(true);
      expect(
        await observe(async () => (await it.read.ledger({ stream: "machine", kind: "failed" })).some((row) => (row.detail as { operation?: string }).operation === "load"), 20_000),
        "the refusal is in the ledger",
      ).toBe(true);
      const failed = (await it.read.ledger({ stream: "machine", kind: "failed" })).filter((row) => (row.detail as { operation?: string }).operation === "load");
      expect(failed.every((row) => row.subject === LOST.id)).toBe(true);

      // Not started: a `kickstart` of what is not loaded fails, and the honest
      // state of this entry is that it is still missing, not that it was started.
      expect(m.since(mark).filter((call) => call.operation === "start")).toEqual([]);
      expect(m.pidOf(LOST.id)).toBeNull();
      // The other lost unit was loaded in the same pass.
      expect(m.since(mark).filter((call) => call.operation === "load" && call.target === INTERVAL.id).length).toBeGreaterThanOrEqual(1);

      // The cause goes away and the next tick brings it back.
      m.failLoad.delete(LOST.id);
      expect(await observe(() => m.pidOf(LOST.id) !== null, 20_000)).toBe(true);
    } finally {
      await hub?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "an entry whose install failed this tick gets no load and no start in it, and another lost entry is still repaired",
  async () => {
    const it = await stage();
    const dir = mkdtempSync(join(tmpdir(), "hub-startup-units-"));
    scratch.push(dir);
    const m = manager("launchd", dir);
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      await firstHub(it, m);
      // The resident lost its plist as well as its job, so the hub renders and
      // installs it again, and that install refuses ONCE. The other lost unit
      // has its plist and is only out of the domain.
      m.lose(LOST.id);
      m.bootout(INTERVAL.id);
      m.failInstall.add(LOST.id);

      const mark = m.calls.length;
      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: m.os });
      // The refusal was one tick's, so a later tick installs it and it comes up.
      expect(await observe(() => m.pidOf(LOST.id) !== null, 20_000), "the next tick installed and started it").toBe(true);

      const after = m.since(mark);
      const failedAt = after.findIndex((call) => call.operation === "install-failed" && call.target === LOST.id);
      expect(failedAt, "the install was refused").toBeGreaterThanOrEqual(0);
      const retriedAt = after.findIndex((call, index) => index > failedAt && call.operation === "install" && call.target === LOST.id);
      expect(retriedAt, "and installed again on a later tick").toBeGreaterThan(failedAt);

      // The tick that refused it: nothing loaded or started for that id, and the
      // other entry was loaded in that same tick.
      const tick = after.slice(failedAt, retriedAt);
      expect(tick.filter((call) => call.target === LOST.id && ["load", "start", "restart"].includes(call.operation))).toEqual([]);
      expect(tick).toContainEqual({ operation: "load", target: INTERVAL.id });
      expect(m.pidOf(INTERVAL.id)).toBeNull();

      // One install failure is on the ledger, and no load or start failure, which
      // is what a start against a job that was never installed would have said.
      const failed = (await it.read.ledger({ stream: "machine", kind: "failed" })).map((row) => ({
        subject: row.subject,
        operation: (row.detail as { operation?: string }).operation,
      }));
      expect(failed.filter((row) => row.operation === "install")).toEqual([{ subject: LOST.id, operation: "install" }]);
      expect(failed.filter((row) => row.operation === "load" || row.operation === "start")).toEqual([]);
      const loaded = await it.read.ledger({ stream: "machine", kind: "unit.loaded" });
      expect(loaded.map((event) => event.subject)).toEqual([INTERVAL.id]);
    } finally {
      await hub?.stop();
      await it.stop();
    }
  },
  SLOW,
);
