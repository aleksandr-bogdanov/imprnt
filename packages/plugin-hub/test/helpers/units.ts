// Test infrastructure: the phase's safety rail.
//
// The hub box runs a LIVE v2 out of the same `~/.config/systemd/user/` the
// Linux checks write into, and this Mac carries the owner's own launchd jobs.
// Three rules follow and this module is where they live (03-CONTEXT "The hub box
// runs a live v2 under the same user manager"):
//
//   1. every name this fixture hands out carries a run-time random suffix under
//      the hub's own render prefix, and a planted stray takes the SCAN prefix
//      only, so nothing it creates can be a name v2 owns;
//   2. `removeAll()` removes exactly the names it handed out. It keeps a list
//      and never globs, and `afterAll` calls it from a `finally` so a thrown
//      assertion still cleans up. It VERIFIES: a name the manager still lists
//      after two attempts is a thrown error naming it, its file is left where
//      it is, and the name stays on the list so a later call tries again;
//   3. nothing here stops, disables, edits or removes a unit it did not create.
//      `foreignWatched()` exists so a check can prove that by census rather than
//      by promise.
//
// THE PREFIXES ARE THIS FIXTURE'S OWN COPY, deliberately. They are the same two
// strings `src/os/names.ts` will export, written out here rather than imported,
// because an oracle that borrowed the code under test would agree with every
// build, including one that renamed the fence away.
//
// WHERE THE FILES GO. On linux a user unit is loadable from the manager's search
// path and from nowhere else (D-95), so this writes into the real
// `~/.config/systemd/user/` and calls `daemon-reload` after writing and after
// removing (permitted: a reload re-reads every user unit including v2's and
// starts, stops and restarts nothing). On macOS `launchctl bootstrap gui/<uid>
// <plist>` loads a job from ANY path (03-BRIEF, measured), so the plists go into
// a scratch directory this fixture owns and the owner's own
// `~/Library/LaunchAgents` is never written to by a check.

import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export const RENDER_PREFIX = "imprnt-hub-";
export const WATCH_PREFIX = "imprnt-";

export interface PlantedStray {
  /** `imprnt-stray-<8 hex>`: the scan prefix only, never the render prefix. */
  base: string;
  /** What the manager reports it as on this platform. */
  name: string;
  /** The file on disk. */
  file: string;
}

export interface UnitFixture {
  /** `<base>-<8 hex>`, recorded, so its unit is `imprnt-hub-<base>-<8 hex>`. */
  entryId(base: string): string;
  /** A unit under the WATCH prefix only, loaded and running. The hub's to report and never to touch. */
  plantStray(options?: { program?: string[] }): Promise<PlantedStray>;
  /** Record a unit base name created another way, so removeAll takes it too. */
  track(unitBase: string): void;
  /** Every unit base name this fixture handed out. */
  mine(): string[];
  /** Where this fixture's unit files live. On linux the manager's search path. */
  unitDir(): string;
  /** Every unit the manager has under the WATCH prefix, as it reports them. */
  listWatched(): Promise<string[]>;
  /** Those of them this fixture did not create. Its count must not move. */
  foreignWatched(): Promise<string[]>;
  /** Boot out or disable-and-remove exactly what was handed out. Never anything else. */
  removeAll(): Promise<void>;
}

async function sh(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function hex(n = 8): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, n);
}

/** A bounded wait with no fixed sleep before an assertion. */
async function waitUntil(
  what: string,
  ready: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline) throw new Error(`${what} did not happen in ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

// ---------------------------------------------------------------------------

export function unitFixture(): UnitFixture {
  const created: string[] = [];
  const isDarwin = process.platform === "darwin";
  const uid = process.getuid?.() ?? -1;

  const dir = isDarwin
    ? mkdtempSync(join(tmpdir(), "hub-units-"))
    : join(homedir(), ".config", "systemd", "user");
  if (!isDarwin) mkdirSync(dir, { recursive: true });

  const isMine = (name: string): boolean =>
    created.some((base) => name === base || name.startsWith(`${base}.`));

  const listWatched = async (): Promise<string[]> => {
    if (isDarwin) {
      const out = await sh("launchctl", ["list"]);
      return out.stdout
        .split("\n")
        .slice(1)
        .map((line) => line.split("\t")[2]?.trim() ?? "")
        .filter((label) => label.startsWith(WATCH_PREFIX));
    }
    const out = await sh("systemctl", [
      "--user",
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      "--no-pager",
      `${WATCH_PREFIX}*`,
    ]);
    return out.stdout
      .split("\n")
      .map((line) => line.trim().replace(/^●\s*/, "").split(/\s+/)[0] ?? "")
      .filter((name) => name.startsWith(WATCH_PREFIX));
  };

  const plistText = (label: string, program: string[]): string =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      `  <string>${label}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...program.map((a) => `    <string>${a}</string>`),
      "  </array>",
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>KeepAlive</key>",
      "  <true/>",
      "  <key>ThrottleInterval</key>",
      "  <integer>1</integer>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n");

  const serviceText = (program: string[]): string =>
    [
      "[Unit]",
      "Description=a unit a check created and removes",
      "",
      "[Service]",
      `ExecStart=${program.map((a) => (/[ \t"]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
      "Restart=always",
      "RestartSec=1",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");

  const plant = async (base: string, program: string[]): Promise<string> => {
    if (isDarwin) {
      const file = join(dir, `${base}.plist`);
      writeFileSync(file, plistText(base, program), "utf8");
      const out = await sh("launchctl", ["bootstrap", `gui/${uid}`, file]);
      if (out.code !== 0) {
        throw new Error(
          `launchctl bootstrap refused ${base}: ${out.stderr || out.stdout}`,
        );
      }
      await waitUntil(`${base} was loaded`, async () =>
        (await listWatched()).includes(base),
      );
      return file;
    }
    const file = join(dir, `${base}.service`);
    writeFileSync(file, serviceText(program), "utf8");
    await sh("systemctl", ["--user", "daemon-reload"]);
    const out = await sh("systemctl", ["--user", "start", `${base}.service`]);
    if (out.code !== 0) {
      throw new Error(`systemctl --user start refused ${base}: ${out.stderr || out.stdout}`);
    }
    await waitUntil(`${base} was loaded`, async () =>
      (await listWatched()).some((n) => n.startsWith(base)),
    );
    return file;
  };

  /** Whether the manager still lists this name, under any suffix. */
  const stillThere = async (base: string): Promise<boolean> =>
    (await listWatched()).some((n) => n === base || n.startsWith(`${base}.`));

  /**
   * Remove one, VERIFY it is gone, and throw naming it when it is not.
   *
   * The second seat's finding: the first shape of this swallowed a failed
   * `bootout`, swallowed the timeout waiting for the job to disappear, deleted
   * the plist anyway and then forgot the name. A job that refused to leave was
   * therefore left LOADED WITH NO FILE, invisible to the next run's cleanup and
   * impossible to remove by the same route. Now the attempt is made twice, the
   * file is deleted only once the manager has really let go, and a name that
   * survives both attempts is a thrown error that says which one.
   */
  const removeOne = async (base: string): Promise<void> => {
    const attempt = async (): Promise<void> => {
      if (isDarwin) {
        await sh("launchctl", ["bootout", `gui/${uid}/${base}`]);
        // A bootout is asynchronous. A check that asserted the census straight
        // after it would be reading a job that is on its way out.
        await waitUntil(`${base} left launchd`, async () => !(await stillThere(base)), 15_000).catch(
          () => {},
        );
        return;
      }
      for (const unit of [`${base}.timer`, `${base}.service`]) {
        await sh("systemctl", ["--user", "stop", unit]);
        await sh("systemctl", ["--user", "disable", unit]);
      }
      await waitUntil(`${base} stopped`, async () => !(await stillThere(base)), 15_000).catch(
        () => {},
      );
    };

    await attempt();
    if (await stillThere(base)) await attempt();
    if (await stillThere(base)) {
      // The file stays where it is: a loaded job whose file has been deleted is
      // worse than a loaded job, because the next run cannot even see how it
      // was made.
      throw new Error(
        `${base} is STILL LOADED after two removal attempts, so this run left a job on the box`,
      );
    }

    for (const suffix of isDarwin ? [".plist"] : [".service", ".timer"]) {
      const file = join(dir, `${base}${suffix}`);
      if (existsSync(file)) rmSync(file, { force: true });
    }
    if (!isDarwin) {
      await sh("systemctl", ["--user", "daemon-reload"]);
      for (const unit of [`${base}.timer`, `${base}.service`]) {
        // Ours, and only ours: a crash-looping unit otherwise stays listed as
        // failed after its file is gone.
        await sh("systemctl", ["--user", "reset-failed", unit]);
      }
    }
  };

  return {
    entryId(base) {
      const id = `${base}-${hex()}`;
      created.push(`${RENDER_PREFIX}${id}`);
      return id;
    },
    async plantStray(options = {}) {
      const base = `${WATCH_PREFIX}stray-${hex()}`;
      created.push(base);
      const program = options.program ?? [
        "/bin/sh",
        "-c",
        "while true; do sleep 60; done",
      ];
      const file = await plant(base, program);
      const name = (await listWatched()).find(
        (n) => n === base || n.startsWith(`${base}.`),
      );
      if (!name) throw new Error(`the planted stray ${base} is not loaded`);
      return { base, name, file };
    },
    track(unitBase) {
      created.push(unitBase);
    },
    mine: () => [...created],
    unitDir: () => dir,
    listWatched,
    async foreignWatched() {
      return (await listWatched()).filter((name) => !isMine(name));
    },
    async removeAll() {
      const failures: string[] = [];
      // A name that could not be removed STAYS REGISTERED, so a later
      // `removeAll` tries it again rather than forgetting it. Forgetting is
      // what turns a failed bootout into a job nobody is looking for.
      const left: string[] = [];
      for (const base of [...created].reverse()) {
        try {
          await removeOne(base);
        } catch (error) {
          failures.push(`${base}: ${(error as Error).message}`);
          left.push(base);
        }
      }
      created.length = 0;
      created.push(...left);
      if (isDarwin && dir.startsWith(tmpdir()) && failures.length === 0) {
        rmSync(dir, { recursive: true, force: true });
      }
      if (failures.length) {
        throw new Error(`the unit fixture could not remove: ${failures.join("; ")}`);
      }
    },
  };
}
