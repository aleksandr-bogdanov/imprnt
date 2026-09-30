// A declared unit the manager does not carry is LOADED, and a schedule counts as
// scheduled only while the manager has it armed. (SPEC §6, D7, L13)
//
// TWO PRODUCTION FAILURES, one per manager. On a Mac a plist the hub had rendered
// was on disk and had been booted out, and `start` is `kickstart`, which cannot
// load a job. On a Pi the seven timers had been stopped while every file stayed
// byte for byte the same, and the diff called them scheduled because the SERVICE
// beside each was loaded, which it always is.
//
// THE PARSERS ARE THE REAL ONES. Both seams are driven through the `bin`
// parameter they already take, pointed at a script that answers in the shape the
// real manager prints: `systemctl show` blocks and `list-units` rows, and
// `launchctl print` with its exit 113 for a job that is not in the domain. Nothing
// here reaches a real `systemctl` or `launchctl`.
//
// Red reason: `load` is absent from both seams and `armed` from src/os/diff.ts.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armed, diffUnits, seenUnits, wantedUnits } from "../src/os/diff.ts";
import { launchd } from "../src/os/launchd.ts";
import { unitName } from "../src/os/names.ts";
import { systemd } from "../src/os/systemd.ts";
import type { RenderContext, UnitState } from "../src/os/types.ts";
import type { RunEntry } from "../src/registry/load.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(what: string): string {
  const dir = mkdtempSync(join(tmpdir(), what));
  scratch.push(dir);
  return dir;
}

const RESIDENT: RunEntry = { id: "runner-mac", kind: "runner", schedule: "always", memory_limit_mb: 512, machine: "here" };
const SCHEDULED: RunEntry = { id: "vault-sync-mac", kind: "sync", schedule: "every 15m", memory_limit_mb: 128, machine: "here" };
const ONDEMAND: RunEntry = { id: "transcriber", kind: "runner", schedule: "on demand", memory_limit_mb: 128, machine: "here" };

function contextFor(dir: string): RenderContext {
  return {
    machine: "here",
    stateDir: dir,
    execPath: process.execPath,
    entryScript: join(dir, "never-run.ts"),
    registryFile: join(dir, "registry.toml"),
    restartDelaySeconds: 1,
    giveUpAfter: 5,
    giveUpWindowSeconds: 300,
  };
}

function unit(over: Partial<UnitState> & { name: string }): UnitState {
  return {
    loaded: true, running: false, pid: null, runs: null, ran: true, restarts: 0, lastExit: null,
    since: null, state: null, result: null, ...over,
  };
}

// --- systemd: a `systemctl` that answers the way `systemctl --user` prints ---

type SystemctlUnits = Record<string, { active: string; sub: string }>;

/**
 * State lives in a JSON file the script reads and rewrites, so what a call did is
 * visible to the next one. `show` prints one `key=value` block per name, joined by
 * a blank line, and a timer has no `MainPID` or `ExecMain*` at all, which is how
 * the real one prints it. `enable --now` on a timer arms it unless `stuck` says
 * the manager accepts the verb and leaves the timer down.
 */
function systemctlShim(units: SystemctlUnits, stuck = false) {
  const dir = scratchDir("unit-arming-systemctl-");
  const state = join(dir, "state.json");
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "systemctl");
  writeFileSync(state, JSON.stringify(units));
  writeFileSync(log, "");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const units = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const words = [];
for (let n = 0; n < args.length; n++) {
  if (args[n] === "-p") { n++; continue; }
  if (args[n].startsWith("-")) continue;
  words.push(args[n]);
}
const [verb, ...names] = words;
if (verb === "show") {
  process.stdout.write(names.map((name) => {
    const one = units[name];
    if (!one) return ["Id=" + name, "LoadState=not-found", "ActiveState=inactive", "SubState=dead"].join("\\n");
    const lines = ["Id=" + name, "LoadState=loaded", "ActiveState=" + one.active, "SubState=" + one.sub];
    if (name.endsWith(".service")) lines.push("MainPID=0", "ExecMainPID=0", "NRestarts=0", "ExecMainStatus=0", "ExecMainStartTimestamp=Tue 2026-09-29 09:00:00 UTC");
    lines.push("ActiveEnterTimestamp=Tue 2026-09-29 09:00:00 UTC", "Result=success");
    return lines.join("\\n");
  }).join("\\n\\n") + "\\n");
} else if (verb === "list-units") {
  process.stdout.write(Object.entries(units).map(([name, one]) => name + " loaded " + one.active + " " + one.sub + " imprnt hub unit").join("\\n") + "\\n");
} else if ((verb === "enable" && args.includes("--now")) || verb === "start") {
  const name = names[0];
  if (units[name] && !${stuck}) {
    units[name] = name.endsWith(".timer") ? { active: "active", sub: "waiting" } : { active: "active", sub: "running" };
    writeFileSync(${JSON.stringify(state)}, JSON.stringify(units));
  }
}
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    units: () => JSON.parse(readFileSync(state, "utf8")) as SystemctlUnits,
  };
}

/** Every verb the manager was asked, reads included. */
const verbsOf = (calls: string[][]) => calls.map((args) => args.filter((arg) => !arg.startsWith("-"))[0]);

function pi(entry: RunEntry, units: SystemctlUnits, options: { render?: RunEntry; stuck?: boolean } = {}) {
  const dir = scratchDir("unit-arming-units-");
  const shim = systemctlShim(units, options.stuck);
  const os = systemd({ unitDir: dir, bin: shim.bin });
  for (const file of os.render(options.render ?? entry, contextFor(dir))) writeFileSync(file.path, file.text, "utf8");
  return { os, dir, shim };
}

test("a timer stopped while its files stayed the same is not scheduled, and loading arms the timer and never starts or restarts the service", async () => {
  const service = `${unitName(SCHEDULED.id)}.service`;
  const timer = `${unitName(SCHEDULED.id)}.timer`;
  const it = pi(SCHEDULED, {
    [service]: { active: "inactive", sub: "dead" },
    [timer]: { active: "inactive", sub: "dead" },
  });

  const diffNow = async () =>
    diffUnits({ wanted: wantedUnits([SCHEDULED]), found: await seenUnits(it.os, [SCHEDULED]) }).missing.map((one) => one.id);

  // The report was true of the service and false of the timer: the service is
  // loaded, so the old test said scheduled, and the timer is inactive and dead.
  expect((await it.os.show(SCHEDULED.id))?.loaded).toBe(true);
  expect((await it.os.show(SCHEDULED.id))?.timer?.state).toBe("inactive");
  expect(await diffNow()).toEqual([SCHEDULED.id]);

  expect(await it.os.load!(SCHEDULED.id, "scheduled")).toBe(true);
  expect(it.shim.calls()).toContainEqual(["--user", "enable", "--now", timer]);
  expect(await diffNow()).toEqual([]);
  expect((await it.os.show(SCHEDULED.id))?.timer?.state).toBe("active");

  // ARMED IS NOT DISPATCHED. Nobody asked the manager to start or restart the
  // service, and this script's service is exactly as it was. The script has no
  // clock, so it cannot show what a real manager does when an overdue interval
  // or a persistent calendar timer is armed: that may run the service promptly.
  expect(verbsOf(it.shim.calls())).not.toContain("start");
  expect(verbsOf(it.shim.calls())).not.toContain("restart");
  expect(it.shim.units()[service]).toEqual({ active: "inactive", sub: "dead" });

  // A second pass finds it armed and asks the manager for nothing that acts.
  const acting = () => it.shim.calls().filter((args) => args.some((arg) => arg === "enable" || arg === "start" || arg === "disable"));
  const before = acting().length;
  expect(await it.os.load!(SCHEDULED.id, "scheduled")).toBe(false);
  expect(acting().length).toBe(before);
});

test("arming a stopped timer never restarts a run that is in progress", async () => {
  const service = `${unitName(SCHEDULED.id)}.service`;
  const timer = `${unitName(SCHEDULED.id)}.timer`;
  const it = pi(SCHEDULED, {
    [service]: { active: "active", sub: "running" },
    [timer]: { active: "inactive", sub: "dead" },
  });
  // The service running says nothing about whether anything will start it again.
  expect(diffUnits({ wanted: wantedUnits([SCHEDULED]), found: await seenUnits(it.os, [SCHEDULED]) }).missing).toHaveLength(1);
  expect(await it.os.load!(SCHEDULED.id, "scheduled")).toBe(true);
  expect(it.shim.units()[service]).toEqual({ active: "active", sub: "running" });
  expect(verbsOf(it.shim.calls())).not.toContain("restart");
  expect(verbsOf(it.shim.calls())).not.toContain("stop");
});

test("systemd loads only a cadence, and never one the file stopped, lost, or the manager would not arm", async () => {
  const service = `${unitName(SCHEDULED.id)}.service`;
  const timer = `${unitName(SCHEDULED.id)}.timer`;
  const down = { [service]: { active: "inactive", sub: "dead" }, [timer]: { active: "inactive", sub: "dead" } };

  // A resident and an on-demand unit are not loaded here: `start` is the resident's
  // verb and reading an on-demand one is what loads it, so the answer is no change
  // and the manager is not asked anything at all.
  const quiet = pi(SCHEDULED, down);
  expect(await quiet.os.load!(SCHEDULED.id, "running")).toBe(false);
  expect(await quiet.os.load!(SCHEDULED.id, "loaded")).toBe(false);
  expect(quiet.shim.calls()).toEqual([]);

  // The household stopped it: the timer is rendered without [Install], and arming
  // it would run a piece the file says is down.
  const held = pi(SCHEDULED, down, { render: { ...SCHEDULED, enabled: false } });
  await expect(held.os.load!(SCHEDULED.id, "scheduled")).rejects.toThrow("[Install]");
  expect(verbsOf(held.shim.calls())).not.toContain("enable");

  // No file is an error and not a success at nothing.
  const lost = pi(SCHEDULED, down);
  rmSync(join(lost.dir, `${unitName(SCHEDULED.id)}.timer`));
  await expect(lost.os.load!(SCHEDULED.id, "scheduled")).rejects.toThrow("cannot read");

  // A manager that took the verb and left the timer down did not arm it.
  const stuck = pi(SCHEDULED, down, { stuck: true });
  await expect(stuck.os.load!(SCHEDULED.id, "scheduled")).rejects.toThrow("still not active");
});

// --- launchd: a `launchctl` with a real domain, and exit 113 for a job not in it ---

/**
 * The domain is a directory with one file per loaded label, holding `running` or
 * `idle`. `bootstrap` reads the plist the way launchd does, refusing one that is
 * not a plist (exit 5) and a label that is already loaded (exit 37), and starts a
 * job whose plist says `RunAtLoad` and only that one. `kickstart` of a label the
 * domain does not hold is the failure the Mac showed.
 */
function launchctlShim() {
  const dir = scratchDir("unit-arming-launchctl-");
  const domain = join(dir, "domain");
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "launchctl");
  mkdirSync(domain);
  writeFileSync(log, "");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const held = (name) => ${JSON.stringify(domain)} + "/" + name;
const nameOf = (target) => target.slice(target.lastIndexOf("/") + 1);
const [verb, ...rest] = args;
const missing = (name) => { process.stderr.write('Could not find service "' + name + '" in domain for user gui: 501\\n'); process.exit(113); };
if (verb === "print") {
  const name = nameOf(rest[0]);
  if (!existsSync(held(name))) missing(name);
  const running = readFileSync(held(name), "utf8") === "running";
  process.stdout.write(["gui/501/" + name + " = {", "\\tstate = " + (running ? "running" : "not running"), ...(running ? ["\\tpid = 4242", "\\truns = 1", "\\tlast exit code = (never exited)"] : []), "}", ""].join("\\n"));
} else if (verb === "bootstrap") {
  const text = readFileSync(rest[1], "utf8");
  if (!text.includes("</plist>")) { process.stderr.write("Bootstrap failed: 5: Input/output error\\n"); process.exit(5); }
  const name = /<key>Label<\\/key>\\s*<string>([^<]*)<\\/string>/.exec(text)?.[1] ?? "";
  if (existsSync(held(name))) { process.stderr.write("Bootstrap failed: 37: Operation already in progress\\n"); process.exit(37); }
  writeFileSync(held(name), /<key>RunAtLoad<\\/key>\\s*<true\\/>/.test(text) ? "running" : "idle");
} else if (verb === "kickstart") {
  const name = nameOf(rest[rest.length - 1]);
  if (!existsSync(held(name))) missing(name);
  writeFileSync(held(name), "running");
} else if (verb === "bootout") {
  rmSync(held(nameOf(rest[0])), { force: true });
} else if (verb === "list") {
  process.stdout.write(["PID\\tStatus\\tLabel", ...readdirSync(${JSON.stringify(domain)}).map((name) => (readFileSync(held(name), "utf8") === "running" ? "4242" : "-") + "\\t0\\t" + name)].join("\\n") + "\\n");
}
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    hold: (label: string, running: boolean) => writeFileSync(join(domain, label), running ? "running" : "idle"),
    held: (label: string): "running" | "idle" | null =>
      existsSync(join(domain, label)) ? (readFileSync(join(domain, label), "utf8") as "running" | "idle") : null,
  };
}

function mac(entries: RunEntry[]) {
  const dir = scratchDir("unit-arming-agents-");
  const shim = launchctlShim();
  const os = launchd({ unitDir: dir, bin: shim.bin });
  for (const entry of entries) {
    for (const file of os.render(entry, contextFor(dir))) writeFileSync(file.path, file.text, "utf8");
  }
  return { os, dir, shim };
}

test("plists on disk and booted out are loaded, a scheduled job is loaded with no kickstart, and a second pass changes nothing", async () => {
  const it = mac([RESIDENT, SCHEDULED, ONDEMAND]);
  const entries = [RESIDENT, SCHEDULED, ONDEMAND];
  const missing = async () =>
    diffUnits({ wanted: wantedUnits(entries), found: await seenUnits(it.os, entries) }).missing.map((one) => one.id).sort();
  const label = (entry: RunEntry) => unitName(entry.id);

  // The Mac as the cutover found it: files present, nothing in the domain. The
  // reading is a unit that exists and is not loaded, and all three are missing.
  expect((await it.os.show(RESIDENT.id))?.loaded).toBe(false);
  expect(await missing()).toEqual([RESIDENT.id, ONDEMAND.id, SCHEDULED.id]);

  for (const entry of [RESIDENT, SCHEDULED, ONDEMAND]) {
    const wanted = entry === RESIDENT ? "running" : entry === SCHEDULED ? "scheduled" : "loaded";
    expect(await it.os.load!(entry.id, wanted)).toBe(true);
  }
  expect(await missing()).toEqual([]);

  // LOADED IS NOT KICKSTARTED. The plists' own RunAtLoad decided: the resident
  // was launched by its plist, and this script starts the scheduled and on-demand
  // jobs no further, so they sit in the domain, which counts as armed. The script
  // has no clock, so a real launchd's own interval is not shown here.
  expect(it.shim.held(label(RESIDENT))).toBe("running");
  expect(it.shim.held(label(SCHEDULED))).toBe("idle");
  expect(it.shim.held(label(ONDEMAND))).toBe("idle");
  expect((await it.os.show(SCHEDULED.id))?.running).toBe(false);
  expect(armed([(await it.os.show(SCHEDULED.id))!])).toBe(true);
  const verbs = verbsOf(it.shim.calls());
  expect(verbs.filter((verb) => verb === "bootstrap")).toHaveLength(3);
  expect(verbs).not.toContain("kickstart");
  expect(verbs).not.toContain("bootout");

  // Nothing is loaded twice: the second pass reads, finds every job in the
  // domain and asks the manager for no change.
  for (const entry of entries) expect(await it.os.load!(entry.id, "scheduled")).toBe(false);
  expect(verbsOf(it.shim.calls()).filter((verb) => verb === "bootstrap")).toHaveLength(3);
});

test("a job launchd already carries is left exactly as it is, running or between runs", async () => {
  const it = mac([RESIDENT, SCHEDULED]);
  it.shim.hold(unitName(RESIDENT.id), true);
  it.shim.hold(unitName(SCHEDULED.id), false);
  expect(await it.os.load!(RESIDENT.id, "running")).toBe(false);
  expect(await it.os.load!(SCHEDULED.id, "scheduled")).toBe(false);
  // A healthy child is never booted out to be loaded again, and no verb but a read is used.
  expect(verbsOf(it.shim.calls()).filter((verb) => verb !== "print")).toEqual([]);
  expect(it.shim.held(unitName(RESIDENT.id))).toBe("running");
  expect(it.shim.held(unitName(SCHEDULED.id))).toBe("idle");
});

test("a plist that is missing, is another job's, or is not a plist is an error naming the file and never a success", async () => {
  const it = mac([RESIDENT, SCHEDULED]);
  const file = (entry: RunEntry) => join(it.dir, `${unitName(entry.id)}.plist`);

  rmSync(file(RESIDENT));
  await expect(it.os.load!(RESIDENT.id, "running")).rejects.toThrow(file(RESIDENT));

  // Under our name and declaring somebody else's label: bootstrapping it would
  // load a job that is not ours and leave ours missing.
  writeFileSync(file(SCHEDULED), readFileSync(file(SCHEDULED), "utf8").replace(unitName(SCHEDULED.id), "com.example.other"), "utf8");
  await expect(it.os.load!(SCHEDULED.id, "scheduled")).rejects.toThrow("declares label com.example.other");

  // Ours by label and broken: the manager's own refusal comes back as the error.
  writeFileSync(file(SCHEDULED), `<plist><dict><key>Label</key><string>${unitName(SCHEDULED.id)}</string>`, "utf8");
  await expect(it.os.load!(SCHEDULED.id, "scheduled")).rejects.toThrow("Input/output error");

  expect(it.shim.held(unitName(RESIDENT.id))).toBeNull();
  expect(it.shim.held(unitName(SCHEDULED.id))).toBeNull();
  expect((await it.os.show(SCHEDULED.id))?.loaded).toBe(false);
});

// --- what "scheduled" means, on the units each manager reports ---

test("scheduled needs the timer armed on systemd and the job loaded on launchd, and a service never counts", () => {
  const service = unit({ name: `${unitName(SCHEDULED.id)}.service`, state: "inactive" });
  const timer = (state: string, loaded = true) => unit({ name: `${unitName(SCHEDULED.id)}.timer`, state, loaded });
  expect(armed([service])).toBe(false);
  expect(armed([service, timer("inactive")])).toBe(false);
  expect(armed([service, timer("failed")])).toBe(false);
  expect(armed([service, timer("active", false)])).toBe(false);
  expect(armed([service, timer("active")])).toBe(true);
  // As `show` reports it, with the timer riding on the service's reading.
  expect(armed([{ ...service, timer: timer("active") }])).toBe(true);
  expect(armed([{ ...service, timer: timer("inactive") }])).toBe(false);

  const job = unit({ name: unitName(SCHEDULED.id), state: "not running", running: false });
  expect(armed([job])).toBe(true);
  expect(armed([{ ...job, loaded: false }])).toBe(false);
});

test("an entry the file stopped is never missing, whatever the manager says about its timer", () => {
  const stopped = { ...SCHEDULED, enabled: false };
  const timer = (state: string) => unit({ name: `${unitName(SCHEDULED.id)}.timer`, state });
  for (const found of [[], [timer("inactive")], [timer("active")]]) {
    expect(diffUnits({ wanted: wantedUnits([stopped]), found }).missing).toEqual([]);
  }
  // And the same units with the entry enabled are the finding, for the two that
  // are not armed.
  expect(diffUnits({ wanted: wantedUnits([SCHEDULED]), found: [] }).missing).toHaveLength(1);
  expect(diffUnits({ wanted: wantedUnits([SCHEDULED]), found: [timer("inactive")] }).missing).toHaveLength(1);
  expect(diffUnits({ wanted: wantedUnits([SCHEDULED]), found: [timer("active")] }).missing).toEqual([]);
});
