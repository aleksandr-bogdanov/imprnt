import { existsSync, mkdirSync, chmodSync, closeSync, openSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RunEntry } from "../registry/load.ts";
import { scheduleSeconds, wantedState } from "./diff.ts";
import { SCAN_PREFIX, isOurs, unitName } from "./names.ts";
import type { MemoryReading, OsSeam, RenderContext, UnitFile, UnitState } from "./types.ts";
import { STARTED_WITH } from "../store/connect.ts";

/**
 * launchd, as the hub talks to it: `launchctl` in the per-user gui domain, which
 * needs no sudo.
 *
 * MEASURED on this Mac, and the build leans on all of it:
 *   - `bootstrap gui/<uid> <plist>` loads a job from ANY path, so `unitDir` is a
 *     scratch directory in a check and `~/Library/LaunchAgents` in production.
 *   - `kickstart` on a running job does nothing and `kickstart -k` kills and
 *     starts it again, which is exactly `start` and `restart`.
 *   - `print` reports `runs`, which counts EXECUTIONS, and `last exit code`,
 *     which reads `(never exited)` until the program has exited once. The
 *     four reported fields come from those two: a healthy KeepAlive job that has never
 *     died is `runs = 1`, so `restarts` is `max(runs - 1, 0)` and is zero.
 *   - a `KeepAlive` job is back 0.03 s after a `kill -9` with `ThrottleInterval`
 *     1 and waits out launchd's own 10 s default without the key, so the key is
 *     always rendered.
 *   - launchd never gives up restarting, so there is no equivalent of systemd's
 * `StartLimitBurst` and the renderer emits none. `check` carries the
 *     `crash-loop` finding instead.
 */

function uid(): number {
  return process.getuid?.() ?? -1;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plist(entries: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function readPrint(label: string, text: string): UnitState {
  const state = /^\s*state = (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const pid = Number(/^\s*pid = (\d+)$/m.exec(text)?.[1] ?? 0) || null;
  const runsFound = /^\s*runs = (\d+)$/m.exec(text)?.[1];
  const runs = runsFound === undefined ? null : Number(runsFound);
  const exitText = /^\s*last exit code = (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  return {
    name: label,
    // `print` answered at all, so the job is bootstrapped.
    loaded: true,
    running: state === "running",
    pid,
    runs,
    ran: (runs ?? 0) >= 1,
    restarts: runs === null ? null : Math.max(runs - 1, 0),
    lastExit: /^-?\d+$/.test(exitText) ? Number(exitText) : null,
    since: null,
    state: state === "" ? null : state,
    // launchd keeps no equivalent of systemd's `Result`: it never gives up, so
    // there is no verdict to record.
    result: null,
  };
}

/**
 * A unit that exists and about which `print` said nothing: the name, whether
 * the manager is carrying it, and no reading at all. Every other field is null
 * rather than a zero, because a job nobody could read has not run zero times.
 */
function unreadUnit(name: string, loaded: boolean): UnitState {
  return {
    name,
    loaded,
    running: false,
    pid: null,
    runs: null,
    ran: false,
    restarts: null,
    lastExit: null,
    since: null,
    state: null,
    result: null,
  };
}

export function launchd(options: { unitDir?: string; bin?: string } = {}): OsSeam {
  const bin = options.bin ?? "launchctl";
  const unitDir = options.unitDir ?? join(homedir(), "Library", "LaunchAgents");
  /**
   * The manager binary is a PARAMETER, defaulting to the bare
   * name PATH resolves. `check` reaches a manager only through the seam it
   * was handed, and a check that points this at a recording shim BY
   * ABSOLUTE PATH catches the one route PATH fronting never could.
   *
   * It lives INSIDE the factory so there is exactly one way to invoke the
   * manager from this file. A module-level helper beside it left a second
   * spelling that one call site kept using, and that call spawned an array
   * as if it were a binary.
   */
  const ask = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out, err };
  };
  const fileOf = (label: string) => join(unitDir, `${label}.plist`);

  const print = async (label: string): Promise<UnitState | null> => {
    const printed = await ask(["print", `gui/${uid()}/${label}`]);
    if (printed.code !== 0) return null;
    return readPrint(label, printed.out + printed.err);
  };

  return {
    flavour: "launchd",

    render(entry: RunEntry, ctx: RenderContext): UnitFile[] {
      const wanted = wantedState(entry);
      const label = unitName(entry.id);
      // The entry's own command line when it has one, and the bun default
      // otherwise. The fallback is what every other kind renders, so a render
      // with no argv supplied is byte for byte what it always was.
      const argv = ctx.argv ?? [ctx.execPath, "run", ctx.entryScript, ctx.registryFile, entry.id];
      const every = wanted === "scheduled" ? scheduleSeconds(entry.schedule) : null;
      const body = [
        ...(ctx.stateDir ? [
          "  <key>StandardOutPath</key>", `  <string>${xml(join(ctx.stateDir, "service-log", `${entry.id}.out.log`))}</string>`,
          "  <key>StandardErrorPath</key>", `  <string>${xml(join(ctx.stateDir, "service-log", `${entry.id}.err.log`))}</string>`,
        ] : []),
        "  <key>Label</key>",
        `  <string>${xml(label)}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        ...argv.map((one) => `    <string>${xml(one)}</string>`),
        "  </array>",
        // Every program the hub renders opens a store, and the store refuses a
        // process started without these, which only the start can supply.
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...Object.entries(STARTED_WITH).flatMap(([name, value]) => [`    <key>${xml(name)}</key>`, `    <string>${xml(value)}</string>`]),
        "  </dict>",
        // A resident comes back at login and is kept alive. Nothing else is.
        "  <key>RunAtLoad</key>",
        wanted === "running" ? "  <true/>" : "  <false/>",
        ...(wanted === "running" ? ["  <key>KeepAlive</key>", "  <true/>"] : []),
        // Measured: without this launchd waits out its own ten second default.
        "  <key>ThrottleInterval</key>",
        `  <integer>${ctx.restartDelaySeconds}</integer>`,
        ...(every === null
          ? []
          : ["  <key>StartInterval</key>", `  <integer>${every}</integer>`]),
      ];
      return [{ path: fileOf(label), text: plist(body) }];
    },

    async install(files: UnitFile[]): Promise<string[]> {
      const written: string[] = [];
      for (const file of files) {
        for (const match of file.text.matchAll(/<key>Standard(?:Out|Error)Path<\/key>\s*<string>([^<]+)<\/string>/g)) {
          const path = match[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          chmodSync(dirname(path), 0o700);
          closeSync(openSync(path, "a", 0o600));
          chmodSync(path, 0o600);
        }
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.text, "utf8");
        written.push(file.path);
      }
      for (const file of files) {
        const label = file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.plist$/, "");
        const first = await ask(["bootstrap", `gui/${uid()}`, file.path]);
        if (first.code === 0) continue;
        // A job already in the domain carries the plist it was loaded with, so a
        // changed one only takes effect once it has been unloaded.
        await ask(["bootout", `gui/${uid()}/${label}`]);
        const retried = await ask(["bootstrap", `gui/${uid()}`, file.path]);
        if (retried.code !== 0) throw new Error(`install: ${label}: ${retried.err}`);
      }
      return written;
    },

    async remove(entryId: string): Promise<void> {
      const label = unitName(entryId);
      // The file goes before the job: bootout works by label and needs no file,
      // and the other order leaves a moment where `list` no longer shows the
      // job while its plist is still on disk. Same ordering as systemd's.
      if (existsSync(fileOf(label))) rmSync(fileOf(label), { force: true });
      await ask(["bootout", `gui/${uid()}/${label}`]);
    },

    async start(entryId: string): Promise<void> {
      // The program runs NOW, and on a job that is already running this
      // does nothing at all (measured).
      const result = await ask(["kickstart", `gui/${uid()}/${unitName(entryId)}`]);
      if (result.code !== 0) throw new Error(`start: ${entryId}: ${result.err}`);
    },

    async stop(entryId: string): Promise<void> {
      // A KeepAlive job cannot be stopped by killing it: launchd starts it
      // again. Unloading is the only stop launchd has, so the plist stays on
      // disk and `show` reports it as a unit that exists and is not loaded.
      await ask(["bootout", `gui/${uid()}/${unitName(entryId)}`]);
    },

    async restart(entryId: string): Promise<void> {
      const result = await ask(["kickstart", "-k", `gui/${uid()}/${unitName(entryId)}`]);
      if (result.code !== 0) throw new Error(`restart: ${entryId}: ${result.err}`);
    },

    async list(): Promise<UnitState[]> {
      const listed = await ask(["list"]);
      const labels = listed.out
        .split("\n")
        .slice(1)
        .map((line) => line.split("\t")[2]?.trim() ?? "")
        .filter((label) => label.startsWith(SCAN_PREFIX));
      const out: UnitState[] = [];
      for (const label of labels) {
        out.push((await print(label)) ?? unreadUnit(label, true));
      }
      return out;
    },

    async unitFiles(): Promise<string[]> {
      // The directory and nothing else, as on systemd: a plist the
      // hub wrote and never bootstrapped, or one whose removal never finished,
      // is in no domain, so `launchctl` has nothing to say about it. Only the
      // RENDER prefix, because the owner's own jobs share this directory.
      let found: Dirent[];
      try {
        found = readdirSync(unitDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return found
        .filter((one) => !one.isDirectory())
        .map((one) => one.name)
        .filter((name) => name.endsWith(".plist") && isOurs(name))
        .sort()
        .map((name) => join(unitDir, name));
    },

    async show(entryId: string): Promise<UnitState | null> {
      const label = unitName(entryId);
      const found = await print(label);
      if (found) return found;
      if (existsSync(fileOf(label))) return unreadUnit(label, false);
      return null;
    },

    async memory(pid: number): Promise<MemoryReading> {
      // macOS keeps no peak for a running process at all, so the peak is null
      // here and the running maximum is the hub's, in the sheet. `ps`
      // reports KILOBYTES and the seam is bytes, so it converts at this edge.
      const proc = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const kb = Number((proc.stdout?.toString() ?? "").trim().split("\n")[0] ?? "0");
      return {
        current_bytes: Number.isFinite(kb) ? kb * 1024 : 0,
        peak_bytes: null,
        source: "ps-rss",
      };
    },

    async available(): Promise<{ ok: boolean; reason: string }> {
      if (uid() < 0) return { ok: false, reason: "no manager for darwin: this process has no uid" };
      const answer = await ask(["print", `gui/${uid()}`]);
      if (answer.code !== 0) {
        return {
          ok: false,
          reason: `the user manager does not answer: launchctl print gui/${uid()} exited ${answer.code}`,
        };
      }
      return { ok: true, reason: "" };
    },
  };
}
