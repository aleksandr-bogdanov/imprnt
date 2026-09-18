// Check: running units minus the registry's set is empty and the reverse is
// empty (SPEC §6, L13), against the REAL launchd or the REAL systemd. And:
// Forbidden, phrased as a check: "an installer that edits a boot file" is absent
// (SPEC §6 Forbidden, RUN-14, L4).
//
// One shared assertion body, `thisOs()` on whichever platform runs it, gated by
// `osGate()` with the reason in the test name and one line on stderr.
//
// NO HUB PROCESS RUNS IN THIS FILE, and that absence is deliberate: a live hub
// removes any unit under the render prefix that has no registry entry for its
// machine, so a check that planted or stopped one behind its back would be
// racing it.
//
// THE HUB BOX RUNS A LIVE V2 OUT OF THE SAME DIRECTORY. Every unit here comes
// from `unitFixture()`, carries a run-time random suffix inside its entry id,
// and is removed in an `afterAll` that runs from a `finally`. The census of
// watch-prefix units this file did not create is read before and after and must
// be identical, so "it disturbed nothing" is proved rather than promised. And
// the extras set is asserted by CONTAINMENT, never by equality: on the hub box
// it also holds v2, which is L13's truth and not a bug.
//
// Red reason: import missing, src/os/index.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { seam, until } from "./helpers/cluster.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { managerState, pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";

const SLOW = 120_000;

const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];
let dir: string;

beforeAll(async () => {
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
  announceGate(gate, "checks 4 and 5, the real service manager");
  dir = mkdtempSync(join(tmpdir(), "hub-osreal-"));
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

/** A script the CHECK owns, so no file under src/entry/ is created this round. */
function scratchScript(name: string, body: string): string {
  const jobs = join(dir, "jobs");
  mkdirSync(jobs, { recursive: true });
  const file = join(jobs, name);
  writeFileSync(file, body, "utf8");
  return file;
}

const ALIVE = "await new Promise(() => {});\n";

function stage(run: RegistrySpec["run"]): string {
  const machine = thisMachine();
  return writeRegistry(dir, {
    hub: {
      state_dir: dir,
      restart_delay_seconds: 1,
      give_up_after: 5,
      give_up_window_seconds: 300,
    },
    machines: [machine],
    run,
  });
}

function context(script: string, registryFile: string): Record<string, unknown> {
  return {
    machine: thisMachine().id,
    execPath: process.execPath,
    entryScript: script,
    registryFile,
    restartDelaySeconds: 1,
    giveUpAfter: 5,
    giveUpWindowSeconds: 300,
  };
}

/**
 * A file by its CONTENTS, not by its size and its timestamp.
 *
 * The second seat's lead: an installer that edited a boot file with content of
 * the same length and then restored the mtime passed a size-and-mtime snapshot.
 * Both are one `utimes` call away from being forged and a sha256 is not, so the
 * fingerprint is the hash, with the size beside it for a readable failure.
 */
function fingerprint(file: string): string {
  try {
    const bytes = readFileSync(file);
    return `${file}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch (error) {
    // A file that cannot be read still has to be the SAME unreadable file
    // before and after, so the reason is part of the fingerprint.
    return `${file}:unreadable:${(error as Error).message}`;
  }
}

/** Every file in a directory, by name and by contents. */
function contentCensus(dir: string, keep: (name: string) => boolean = () => true): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(keep)
    .sort()
    .map((name) => {
      const path = join(dir, name);
      try {
        if (statSync(path).isDirectory()) return `${name}:dir`;
      } catch {
        return `${name}:gone`;
      }
      return `${name}:${fingerprint(path).split(":").slice(1).join(":")}`;
    });
}

test.skipIf(!gate.ok)(
  `RUN-04 running units minus the registry's set is empty and the reverse is empty, against the real service manager: a listed entry is present with a pid that really exists, a stopped one moves into missing while its file is still on disk, and a planted stray under the watch prefix is reported with its stop command as TEXT, is never the hub's to remove, and is STILL RUNNING after the diff was read (SPEC §6, L13, D-78)${gateSuffix(gate)}`,
  async () => {
    const { thisOs } = await seam("src/os/index.ts");
    expect(typeof thisOs).toBe("function");
    const { diffUnits, wantedState, stopCommand } = await seam("src/os/diff.ts");
    expect(typeof diffUnits).toBe("function");
    const { unitName } = await seam("src/os/names.ts");
    expect(typeof unitName).toBe("function");

    const name = unitName as (id: string) => string;
    const state = wantedState as (entry: unknown) => string;
    const stop = stopCommand as (flavour: string, unit: string) => string;
    const diff = diffUnits as (args: {
      wanted: Record<string, unknown>[];
      found: Record<string, unknown>[];
    }) => {
      missing: Record<string, unknown>[];
      stale: Record<string, unknown>[];
      extra: Record<string, unknown>[];
    };

    const entryId = fixture.entryId("runner");
    const registryFile = stage([
      {
        id: entryId,
        kind: "runner",
        machine: thisMachine().id,
        schedule: "always",
        memory_limit_mb: 64,
        child_memory_limit_mb: 64,
      },
    ]);
    const script = scratchScript("alive.ts", ALIVE);
    const os = (thisOs as Function)({ unitDir: fixture.unitDir() }) as {
      flavour: string;
      render(entry: unknown, ctx: unknown): { path: string; text: string }[];
      install(files: unknown[]): Promise<string[]>;
      start(id: string): Promise<void>;
      stop(id: string): Promise<void>;
      list(): Promise<Record<string, unknown>[]>;
      show(id: string): Promise<Record<string, unknown> | null>;
    };

    const entry = listRunEntries(loadRegistry(registryFile)).find((e) => e.id === entryId)!;
    const wanted = [{ ...entry, entry, name: name(entryId), unit: name(entryId), state: state(entry) }];

    await os.install(os.render(entry, context(script, registryFile)));
    await os.start(entryId);

    // --- PRESENT. The pid the seam reports is confirmed to be a live process,
    //     so a seam that invented one fails here rather than later.
    await until(
      "the installed unit is loaded and running with a real pid",
      async () => {
        const found = await os.show(entryId);
        return !!found && found.loaded === true && found.running === true && Number(found.pid) > 0;
      },
      60_000,
      async () => JSON.stringify(await os.show(entryId)),
    );
    const running = (await os.show(entryId))!;
    expect(pidAlive(Number(running.pid))).toBe(true);

    const listed = await os.list();
    expect(listed.some((u) => String(u.name).startsWith(name(entryId)))).toBe(true);
    const present = diff({ wanted, found: listed });
    expect(present.missing).toEqual([]);
    expect(present.stale).toEqual([]);
    expect(present.extra.map((e) => e.name)).not.toContain(name(entryId));

    // --- MISSING. Stopped, and its FILE IS STILL ON DISK. That is the direction
    //     a check that only compared file names cannot see.
    await os.stop(entryId);
    await until(
      "the unit stopped",
      async () => {
        const found = await os.show(entryId);
        return !!found && found.running === false;
      },
      60_000,
      async () => JSON.stringify(await os.show(entryId)),
    );
    const files = readdirSync(fixture.unitDir()).filter((f) => f.startsWith(name(entryId)));
    expect(files.length).toBeGreaterThan(0);
    const stopped = diff({ wanted, found: await os.list() });
    expect(stopped.missing.length).toBe(1);
    expect(stopped.stale).toEqual([]);

    // --- EXTRA, and never touched. A unit under the WATCH prefix only.
    const stray = await fixture.plantStray();
    // Its pid, from the MANAGER, before the diff is computed. "Still running"
    // is a weaker claim than "the same process is still running".
    const strayPidBefore = managerState(stray.base)?.pid ?? null;
    expect(pidAlive(strayPidBefore)).toBe(true);
    const withStray = await os.list();
    expect(withStray.some((u) => String(u.name).startsWith(stray.base))).toBe(true);

    const reported = diff({ wanted, found: withStray });
    // CONTAINMENT, never equality: on the hub box `extra` also holds v2.
    expect(reported.extra.map((e) => String(e.name))).toContain(
      String(withStray.find((u) => String(u.name).startsWith(stray.base))!.name),
    );
    // It is NOT the hub's to remove (D-78), which is the separation that keeps a
    // live v2 unit safe from a hub that treated every imprnt-* as its own.
    expect(reported.stale.map((e) => String(e.name)).join(" ")).not.toContain(stray.base);

    const command = stop(os.flavour, String(reported.extra.find((e) => String(e.name).startsWith(stray.base))!.name));
    expect(typeof command).toBe("string");
    expect(command).toContain(stray.base);

    // AND THE THING L13 ACTUALLY RULES. The diff has been computed and read.
    // The stray is still running, with the SAME pid it had before, and that is
    // read from the manager's own record rather than through the seam under
    // test: a seam that stopped the stray and reported it running would
    // otherwise be believed.
    const afterDiff = await os.list();
    const strayNow = afterDiff.find((u) => String(u.name).startsWith(stray.base));
    expect(strayNow).toBeDefined();
    expect(strayNow!.running).toBe(true);
    expect(pidAlive(Number(strayNow!.pid))).toBe(true);
    const strayByManager = managerState(stray.base);
    expect(strayByManager).not.toBeNull();
    expect(strayByManager!.running).toBe(true);
    expect(strayByManager!.pid).toBe(strayPidBefore);
    expect(pidAlive(strayByManager!.pid)).toBe(true);
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `RUN-14 the installer writes unit files and nothing else: install reports exactly the paths the renderer produced, every one of them is under the manager's own unit directory, every other file there and every boot file is unchanged BY CONTENT HASH, and the units it wrote are really loadable (SPEC §6 Forbidden, RUN-14, L4)${gateSuffix(gate)}`,
  async () => {
    // BEHAVIOURAL, NEVER A GREP. L4's rule is about what the installer DOES, and
    // an installer that shells out to something that edits a boot file passes a
    // grep. The set of paths it reported writing is what the rule is about, and
    // the directory census is what catches a write the return value did not
    // admit to.
    const { thisOs } = await seam("src/os/index.ts");
    expect(typeof thisOs).toBe("function");

    const residentId = fixture.entryId("resident");
    const scheduledId = fixture.entryId("cadence");
    const machine = thisMachine();
    const registryFile = stage([
      { id: residentId, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 64, child_memory_limit_mb: 64 },
      { id: scheduledId, kind: "runner", child_memory_limit_mb: 2048, machine: machine.id, schedule: "every 30m", memory_limit_mb: 64 },
    ]);
    const script = scratchScript("alive2.ts", ALIVE);
    const os = (thisOs as Function)({ unitDir: fixture.unitDir() }) as {
      flavour: string;
      render(entry: unknown, ctx: unknown): { path: string; text: string }[];
      install(files: unknown[]): Promise<string[]>;
      list(): Promise<Record<string, unknown>[]>;
    };

    const entries = listRunEntries(loadRegistry(registryFile));
    const ctx = context(script, registryFile);
    const rendered = [
      ...os.render(entries.find((e) => e.id === residentId)!, ctx),
      ...os.render(entries.find((e) => e.id === scheduledId)!, ctx),
    ];

    const unitDir = fixture.unitDir();
    // BY CONTENTS, so an edit to a file this check did not write is caught even
    // when the name list is identical.
    const before = contentCensus(unitDir);
    // THE BOOT FILES THEMSELVES, which is what the Forbidden line names. On the
    // hub box `/boot/firmware/cmdline.txt` is real and carries the two words L4
    // wants there; on a Mac neither path exists and this is a no-op. An
    // installer that edited one is caught by the sha256 of its contents,
    // whether it wrote the file itself or shelled out to something that did,
    // and whether or not it put the size and the timestamp back afterwards.
    const bootFiles = ["/boot/firmware/cmdline.txt", "/boot/cmdline.txt", "/etc/default/grub"];
    const bootBefore = bootFiles.filter((f) => existsSync(f)).map(fingerprint);
    // The manager's OWN default directory, which this check deliberately does
    // NOT install into: a leak there would survive the fixture's cleanup.
    const defaultDir =
      process.platform === "darwin"
        ? join(homedir(), "Library", "LaunchAgents")
        : join(homedir(), ".config", "systemd", "user");
    // Two censuses, on purpose. Anything under the SCAN prefix is this project's
    // business and is compared by contents. Everything else in the owner's own
    // agent directory is compared by name only, because an unrelated app that
    // rewrites its own plist while the suite runs is not this check's failure.
    const defaultBefore = existsSync(defaultDir) ? readdirSync(defaultDir).sort() : [];
    const defaultOursBefore = contentCensus(defaultDir, (n) => n.startsWith("imprnt-"));

    const written = await os.install(rendered);

    // EXACTLY the rendered set, so an undeclared write fails.
    expect([...written].sort()).toEqual(rendered.map((f) => f.path).sort());
    for (const path of written) {
      expect(path.startsWith(unitDir)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }

    // The census. Every file in the directory that is not one this check wrote
    // was there before with the SAME CONTENTS, so a write the return value hid
    // fails, and so does an edit that kept the name, the size and the mtime.
    const mine = new Set(written.map((p) => p.slice(unitDir.length + 1)));
    // A `<target>.wants` directory is the manager's own bookkeeping: on systemd
    // `enable` creates it on the first unit ever enabled and fills it with a
    // symlink named after the unit. On the hub box it already existed before
    // this phase, on a fresh box (CI) it appears here, and either way it is the
    // manager writing its index, not the installer writing a file. Its symlink
    // is `mine` by name; the directory entry itself is what is set aside.
    const managerIndex = (entry: string) => /\.wants:dir$/.test(entry);
    const notMine = (entry: string) =>
      !mine.has(entry.slice(0, entry.indexOf(":"))) && !managerIndex(entry);
    expect(contentCensus(unitDir).filter(notMine)).toEqual(before.filter(notMine));

    // No boot file moved, by content hash, and nothing landed in the manager's
    // default directory that this check did not put there.
    expect(bootFiles.filter((f) => existsSync(f)).map(fingerprint)).toEqual(bootBefore);
    if (defaultDir !== unitDir) {
      expect(existsSync(defaultDir) ? readdirSync(defaultDir).sort() : []).toEqual(defaultBefore);
      expect(contentCensus(defaultDir, (n) => n.startsWith("imprnt-"))).toEqual(defaultOursBefore);
    }

    // The control, which is what stops this passing on an installer that writes
    // nothing: the units it wrote are really loadable, and the scheduled entry
    // produced what the renderer said it would.
    const loaded = await os.list();
    expect(loaded.some((u) => String(u.name).startsWith(`imprnt-hub-${residentId}`))).toBe(true);
    const scheduledFiles = os.render(entries.find((e) => e.id === scheduledId)!, ctx);
    expect(scheduledFiles.length).toBe(os.flavour === "systemd" ? 2 : 1);
    expect(written.filter((p) => p.includes(scheduledId)).length).toBe(scheduledFiles.length);
  },
  SLOW,
);
