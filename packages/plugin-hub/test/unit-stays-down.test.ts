// A piece the household stopped stays down across a reboot, on both managers.
//
// WHAT A REBOOT PULLS IN. On systemd it is the symlinks in the manager's own
// wants directories: `enable` puts one there and it survives a stop, an
// overwrite of the unit file and a restart of the hub, so a unit that was ever
// enabled comes back at the next boot until something disables it. On launchd
// there is no such register: login loads the plists in the agents directory and
// each one's own `RunAtLoad` decides, so the file the installer wrote is the
// whole answer and the two managers need different work for one promise.
//
// THE SYSTEMD SHIM HERE TAKES THE NARROW READING of what `disable` removes:
// only the links the unit file ON DISK names in its own [Install] section, and
// nothing found by scanning the directory. So a disable issued after the file
// has been overwritten removes nothing here, and an install that never disables
// removes nothing either. This check is green only for an install that disables
// while the section naming the link is still on disk, which is what the real
// manager needs under either reading of what it scans.
//
// NO REBOOT AND NO LOGIN HAPPENS HERE, and neither could. What is asserted is
// the state a boot reads: the wants directories on one, the plist's own
// RunAtLoad on the other.
//
// Red reason: behaviour absent. `install` skips a file that carries no
// [Install] and disables nothing, so the link an earlier enable left stands and
// the next boot starts a piece the registry says is stopped. The launchd arm is
// this file's control and is green throughout: its promise is carried by the
// render, which drops RunAtLoad and KeepAlive for a stopped entry.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import type { OsSeam, RenderContext, UnitFile } from "../src/os/types.ts";
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

/**
 * A `systemctl --user` that keeps the one register a boot reads.
 *
 * `enable` links the unit into every `WantedBy` its file names, `disable`
 * unlinks the unit from every `WantedBy` its file names RIGHT NOW, and nothing
 * else moves. Every other verb is recorded and answers success, because this
 * file is about what a boot would start and not about what a manager reports.
 */
function systemctlShim(unitDir: string, log: string): string {
  const dir = scratchDir("hub-boot-shim-");
  const path = join(dir, "systemctl");
  const q = (text: string) => JSON.stringify(text);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf 'systemctl %s\\n' "$*" >> ${q(log)}`,
      'verb=""; name=""',
      'for arg in "$@"; do',
      '  case "$arg" in -*) continue ;; esac',
      '  if [ -z "$verb" ]; then verb=$arg; else name=$arg; fi',
      "done",
      `unitdir=${q(unitDir)}`,
      'file="$unitdir/$name"',
      "wanted() {",
      '  grep -qx "\\[Install\\]" "$file" 2>/dev/null || return 0',
      `  sed -n '/^\\[Install\\]/,$p' "$file" | grep '^WantedBy=' | cut -d= -f2`,
      "}",
      'case "$verb" in',
      "  enable)",
      '    for target in $(wanted); do',
      '      mkdir -p "$unitdir/$target.wants"',
      '      ln -sf "$file" "$unitdir/$target.wants/$name"',
      "    done ;;",
      "  disable)",
      '    for target in $(wanted); do',
      '      rm -f "$unitdir/$target.wants/$name"',
      "    done ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A `launchctl` that keeps the one thing install branches on: a job already in
 * the domain refuses a second bootstrap, which is what makes the installer boot
 * it out and load the changed plist.
 */
function launchctlShim(log: string): string {
  const dir = scratchDir("hub-boot-shim-");
  const path = join(dir, "launchctl");
  const state = join(dir, "loaded");
  mkdirSync(state, { recursive: true });
  const q = (text: string) => JSON.stringify(text);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf 'launchctl %s\\n' "$*" >> ${q(log)}`,
      `state=${q(state)}`,
      'last=""',
      'for arg in "$@"; do last=$arg; done',
      'case "$1" in',
      "  bootstrap)",
      '    label=$(basename "$last" .plist)',
      '    [ -e "$state/$label" ] && exit 1',
      '    : > "$state/$label" ; exit 0 ;;',
      "  bootout)",
      '    label=${last##*/}',
      '    rm -f "$state/$label" ; exit 0 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

/** Every unit a boot would pull in: what the manager's wants directories hold. */
function bootWants(unitDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(unitDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".wants")) continue;
    for (const link of readdirSync(join(unitDir, entry.name))) out.push(`${entry.name}/${link}`);
  }
  return out.sort();
}

function contextFor(stateDir: string, registryFile: string): RenderContext {
  return {
    machine: "pi",
    stateDir,
    execPath: process.execPath,
    entryScript: join(stateDir, "never-run.ts"),
    registryFile,
    restartDelaySeconds: 1,
    giveUpAfter: 5,
    giveUpWindowSeconds: 300,
  };
}

const RESIDENT: RunEntry = {
  id: "runner-pi",
  kind: "runner",
  schedule: "always",
  memory_limit_mb: 512,
  machine: "pi",
};

const SCHEDULED: RunEntry = {
  id: "vault-sync",
  kind: "sync",
  schedule: "every 15m",
  memory_limit_mb: 128,
  machine: "pi",
};

/** Render and install one entry the way the hub's own tick does. */
async function put(os: OsSeam, entry: RunEntry, ctx: RenderContext): Promise<UnitFile[]> {
  const files = os.render(entry, ctx);
  await os.install(files);
  return files;
}

test("a resident entry the registry stopped is not pulled in at the next boot", async () => {
  const { systemd } = await seam("src/os/systemd.ts");
  expect(typeof systemd).toBe("function");
  const unitDir = scratchDir("hub-boot-units-");
  const stateDir = scratchDir("hub-boot-state-");
  const log = join(stateDir, "manager.log");
  writeFileSync(log, "", "utf8");
  const os = (systemd as (o: { unitDir: string; bin: string }) => OsSeam)({
    unitDir,
    bin: systemctlShim(unitDir, log),
  });
  const ctx = contextFor(stateDir, join(stateDir, "registry.toml"));

  // The control first: an enabled resident really is pinned, so the assertion
  // below is about the field and not about a shim that links nothing.
  await put(os, RESIDENT, ctx);
  expect(bootWants(unitDir)).toEqual(["default.target.wants/imprnt-hub-runner-pi.service"]);

  // The file says stop. A reboot must leave it down, so nothing may be left
  // naming it in the manager's own wants directory.
  await put(os, { ...RESIDENT, enabled: false }, ctx);
  expect(bootWants(unitDir)).toEqual([]);
  expect(readFileSync(log, "utf8")).toContain("disable imprnt-hub-runner-pi.service");

  // And the field going takes it back, so the stop is reversible from the file.
  await put(os, RESIDENT, ctx);
  expect(bootWants(unitDir)).toEqual(["default.target.wants/imprnt-hub-runner-pi.service"]);
});

test("a scheduled entry the registry stopped leaves no timer to start it at the next boot", async () => {
  const { systemd } = await seam("src/os/systemd.ts");
  const unitDir = scratchDir("hub-boot-units-");
  const stateDir = scratchDir("hub-boot-state-");
  const log = join(stateDir, "manager.log");
  writeFileSync(log, "", "utf8");
  const os = (systemd as (o: { unitDir: string; bin: string }) => OsSeam)({
    unitDir,
    bin: systemctlShim(unitDir, log),
  });
  const ctx = contextFor(stateDir, join(stateDir, "registry.toml"));

  // A cadence is carried by a unit of its own, and that unit is what the boot
  // pulls in, so the control names the timer rather than the service.
  await put(os, SCHEDULED, ctx);
  expect(bootWants(unitDir)).toEqual(["timers.target.wants/imprnt-hub-vault-sync.timer"]);

  await put(os, { ...SCHEDULED, enabled: false }, ctx);
  expect(bootWants(unitDir)).toEqual([]);
  // The timer file is still there and is what a person reads to see the cadence
  // the entry would run at. What is gone is anything that starts it.
  expect(existsSync(join(unitDir, "imprnt-hub-vault-sync.timer"))).toBe(true);
  expect(readFileSync(join(unitDir, "imprnt-hub-vault-sync.timer"), "utf8")).not.toContain("[Install]");

  await put(os, SCHEDULED, ctx);
  expect(bootWants(unitDir)).toEqual(["timers.target.wants/imprnt-hub-vault-sync.timer"]);
});

test("what login starts on a Mac is the plist on disk, and a stopped entry's says not to", async () => {
  // THIS ARM IS THE CONTROL and it is green before the systemd fix as well as
  // after: launchd keeps no enablement of its own for a job in the agents
  // directory, so the promise is carried entirely by the render, which drops
  // RunAtLoad, KeepAlive and StartInterval for an entry the file stopped. What
  // this asserts is that the installer leaves that file where login reads it
  // and hands the changed one to the manager rather than the old one.
  const { launchd } = await seam("src/os/launchd.ts");
  expect(typeof launchd).toBe("function");
  const unitDir = scratchDir("hub-boot-agents-");
  const stateDir = scratchDir("hub-boot-state-");
  const log = join(stateDir, "manager.log");
  writeFileSync(log, "", "utf8");
  const os = (launchd as (o: { unitDir: string; bin: string }) => OsSeam)({
    unitDir,
    bin: launchctlShim(log),
  });
  const ctx = contextFor(stateDir, join(stateDir, "registry.toml"));
  const plistOf = (id: string) => readFileSync(join(unitDir, `imprnt-hub-${id}.plist`), "utf8");
  const runAtLoad = (text: string) => text.split("<key>RunAtLoad</key>")[1].trimStart().slice(0, 8);

  for (const entry of [RESIDENT, SCHEDULED]) {
    await put(os, entry, ctx);
    expect(runAtLoad(plistOf(entry.id))).toStartWith(entry === RESIDENT ? "<true/>" : "<false/>");

    await put(os, { ...entry, enabled: false }, ctx);
    const stopped = plistOf(entry.id);
    expect(runAtLoad(stopped)).toStartWith("<false/>");
    expect(stopped).not.toContain("<key>KeepAlive</key>");
    expect(stopped).not.toContain("<key>StartInterval</key>");
  }

  // The manager was handed the changed file: a job already in the domain
  // carries the plist it was loaded with, so an installer that only tried to
  // bootstrap would have left the old one loaded.
  const said = readFileSync(log, "utf8");
  expect(said).toContain("bootout gui/");
  expect(said.split("\n").filter((line) => line.includes("bootstrap")).length).toBeGreaterThanOrEqual(4);
});
