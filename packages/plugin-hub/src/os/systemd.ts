import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RunEntry } from "../registry/load.ts";
import { scheduleSeconds, wantedState } from "./diff.ts";
import { SCAN_PREFIX, timerName, unitName } from "./names.ts";
import type { MemoryReading, OsSeam, RenderContext, UnitFile, UnitState } from "./types.ts";

/**
 * systemd, as the hub talks to it: `systemctl --user` and nothing else.
 *
 * D-95. A user unit is loadable from the manager's search path and from nowhere
 * else, so `unitDir` defaults to it and a check points the seam at the same
 * directory rather than at a scratch one. `daemon-reload` is permitted and is
 * not a violation of "never edit a unit you did not create": it re-reads every
 * user unit including the live v2's, and it starts, stops and restarts nothing.
 *
 * MEASURED on the hub box (systemd 252), and the build leans on all five:
 *   - a unit that is neither enabled nor referenced is garbage collected the
 *     moment it goes inactive, and `ExecMainStartTimestamp`, `ExecMainStatus`
 *     and `ActiveEnterTimestamp` all come back EMPTY afterwards. So `install`
 *     enables anything carrying an `[Install]` section, which pins it, and an
 *     enabled unit that ran and exited still reports that it ran.
 *   - `enable` plus `daemon-reload` puts the unit in `list-units --all` as
 *     `loaded inactive dead` without starting it.
 *   - a timer's `Unit=` reference pins its service the same way.
 *   - with `StartLimitBurst=3` a unit that keeps exiting reaches
 *     `NRestarts=3` and then sits in `failed`, so a crash-loop threshold of two
 *     restarts is reachable here as well as on a Mac.
 *   - a unit killed by a signal goes to `failed`, and the DEFAULT collect mode
 *     never lets go of a failed one however unreferenced it is, so the unit
 *     that wants to be loaded says otherwise in its own file.
 */

const FIELDS = [
  "Id",
  "LoadState",
  "ActiveState",
  "SubState",
  "MainPID",
  "ExecMainPID",
  "NRestarts",
  "ExecMainStatus",
  "ExecMainStartTimestamp",
  "ActiveEnterTimestamp",
];

async function sh(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["systemctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

/** A value systemd would read back as one word, quoted only when it must be. */
function argument(value: string): string {
  return /[\s"'\\]/.test(value) ? JSON.stringify(value) : value;
}

function properties(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.split("\n")) {
    const cut = line.indexOf("=");
    if (cut > 0) out.set(line.slice(0, cut), line.slice(cut + 1).trim());
  }
  return out;
}

function when(text: string): string | null {
  if (!text) return null;
  const at = new Date(text.replace(/\s+[A-Z]{2,5}$/, ""));
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

function stateOf(name: string, fields: Map<string, string>): UnitState {
  const pid = Number(fields.get("ExecMainPID") || fields.get("MainPID") || 0) || null;
  const restarts = fields.get("NRestarts") ?? "";
  const status = fields.get("ExecMainStatus") ?? "";
  return {
    name,
    loaded: fields.get("LoadState") === "loaded",
    running: fields.get("SubState") === "running",
    pid,
    // systemd counts no executions at all (D-101).
    runs: null,
    ran: (fields.get("ExecMainStartTimestamp") ?? "") !== "",
    restarts: /^\d+$/.test(restarts) ? Number(restarts) : null,
    lastExit: /^-?\d+$/.test(status) ? Number(status) : null,
    since: when(fields.get("ActiveEnterTimestamp") ?? ""),
  };
}

export function systemd(options: { unitDir?: string } = {}): OsSeam {
  const unitDir = options.unitDir ?? join(homedir(), ".config", "systemd", "user");
  const service = (entryId: string) => `${unitName(entryId)}.service`;
  const timer = (entryId: string) => timerName(entryId);

  const show = async (names: string[]): Promise<Map<string, UnitState>> => {
    const out = new Map<string, UnitState>();
    if (names.length === 0) return out;
    const printed = await sh([
      "--user",
      "show",
      ...names,
      ...FIELDS.flatMap((field) => ["-p", field]),
      "--no-pager",
    ]);
    if (printed.code !== 0) return out;
    const blocks = printed.out.split(/\n\s*\n/).filter((block) => block.trim() !== "");
    blocks.forEach((block, nth) => {
      const fields = properties(block);
      const name = fields.get("Id") || names[nth] || "";
      if (name === "") return;
      out.set(name, stateOf(name, fields));
    });
    return out;
  };

  return {
    flavour: "systemd",

    render(entry: RunEntry, ctx: RenderContext): UnitFile[] {
      const wanted = wantedState(entry);
      const name = unitName(entry.id);
      const argv = [ctx.execPath, "run", ctx.entryScript, ctx.registryFile, entry.id];
      const unit = [
        "[Unit]",
        `Description=imprnt hub ${entry.kind} ${entry.id} on ${ctx.machine}`,
        // D-96. The give-up pair, which launchd has no equivalent of at all.
        `StartLimitIntervalSec=${ctx.giveUpWindowSeconds}`,
        `StartLimitBurst=${ctx.giveUpAfter}`,
        // A unit that wants to be LOADED is the one kind of ours systemd will
        // not let go of by itself. It carries no `[Install]`, nothing enables
        // it and no timer names it, so it is already collected the moment it
        // goes inactive. Killed rather than stopped it goes to `failed`
        // instead, and the default collect mode keeps a failed unit loaded
        // forever: a dead on-demand piece would sit in `list-units --all` with
        // nobody to clear it, since the hub reads the manager rather than
        // sweeping it. MEASURED: `Result=signal`, `ExecMainStatus=9`, listed
        // indefinitely. This says collect it in that state too, which is the
        // same rule the manager already applies to the inactive one.
        ...(wanted === "loaded" ? ["CollectMode=inactive-or-failed"] : []),
        "",
        "[Service]",
        `ExecStart=${argv.map(argument).join(" ")}`,
        // Only a resident asks to be kept alive. A scheduled service is started
        // by its timer and an on-demand one by a person, so neither carries
        // Restart=always, or the transcriber is restarted forever.
        ...(wanted === "running" ? ["Restart=always"] : []),
        `RestartSec=${ctx.restartDelaySeconds}`,
        `MemoryMax=${entry.memory_limit_mb}M`,
        "",
        ...(wanted === "running" ? ["[Install]", "WantedBy=default.target", ""] : []),
      ].join("\n");
      const files: UnitFile[] = [{ path: join(unitDir, `${name}.service`), text: unit }];

      const every = wanted === "scheduled" ? scheduleSeconds(entry.schedule) : null;
      if (every !== null) {
        files.push({
          path: join(unitDir, timer(entry.id)),
          text: [
            "[Unit]",
            `Description=imprnt hub ${entry.id} cadence on ${ctx.machine}`,
            "",
            "[Timer]",
            `OnUnitActiveSec=${every}`,
            `Unit=${name}.service`,
            "",
            "[Install]",
            "WantedBy=timers.target",
            "",
          ].join("\n"),
        });
      }
      return files;
    },

    async install(files: UnitFile[]): Promise<string[]> {
      const written: string[] = [];
      for (const file of files) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.text, "utf8");
        written.push(file.path);
      }
      await sh(["--user", "daemon-reload"]);
      // Enabling is what PINS the unit: without it systemd forgets a unit that
      // ran and went inactive, and "the manager's own record says it ran" stops
      // being answerable. The symlink is the manager's own, in its own wants
      // directory, and is not a file this installer wrote.
      for (const file of files) {
        const name = file.path.slice(file.path.lastIndexOf("/") + 1);
        if (!file.text.split("\n").some((line) => line.trim() === "[Install]")) continue;
        await sh(
          name.endsWith(".timer")
            ? ["--user", "enable", "--now", name]
            : ["--user", "enable", name],
        );
      }
      await sh(["--user", "daemon-reload"]);
      return written;
    },

    async remove(entryId: string): Promise<void> {
      for (const name of [timer(entryId), service(entryId)]) {
        await sh(["--user", "stop", name]);
        await sh(["--user", "disable", name]);
      }
      for (const name of [timer(entryId), service(entryId)]) {
        const path = join(unitDir, name);
        if (existsSync(path)) rmSync(path, { force: true });
      }
      await sh(["--user", "daemon-reload"]);
      // Ours, and only ours: a unit that crash-looped stays listed as failed
      // after its file is gone unless its state is reset.
      await sh(["--user", "reset-failed", timer(entryId), service(entryId)]);
    },

    async start(entryId: string): Promise<void> {
      // D-102. The program runs NOW. Enabling a cadence is install's job.
      await sh(["--user", "start", service(entryId)]);
    },

    async stop(entryId: string): Promise<void> {
      await sh(["--user", "stop", timer(entryId)]);
      await sh(["--user", "stop", service(entryId)]);
    },

    async restart(entryId: string): Promise<void> {
      await sh(["--user", "restart", service(entryId)]);
    },

    async list(): Promise<UnitState[]> {
      const listed = await sh([
        "--user",
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "--no-pager",
        `${SCAN_PREFIX}*`,
      ]);
      const names = listed.out
        .split("\n")
        .map((line) => line.trim().replace(/^●\s*/, "").split(/\s+/)[0] ?? "")
        .filter((name) => name.startsWith(SCAN_PREFIX));
      const found = await show(names);
      return names.map(
        (name) =>
          found.get(name) ?? {
            name,
            loaded: false,
            running: false,
            pid: null,
            runs: null,
            ran: false,
            restarts: null,
            lastExit: null,
            since: null,
          },
      );
    },

    async show(entryId: string): Promise<UnitState | null> {
      const name = service(entryId);
      const found = (await show([name])).get(name);
      if (found && found.loaded) return found;
      // A file this hub wrote that the manager has not loaded is still a unit
      // that exists, and saying so is what tells a stopped one from a removed
      // one. A file that is gone as well is nothing at all.
      if (existsSync(join(unitDir, name))) {
        return (
          found ?? {
            name,
            loaded: false,
            running: false,
            pid: null,
            runs: null,
            ran: false,
            restarts: null,
            lastExit: null,
            since: null,
          }
        );
      }
      return null;
    },

    async memory(pid: number): Promise<MemoryReading> {
      // `MemoryPeak` is empty on systemd 252 (it arrived in 256), so the peak is
      // the kernel's own high-water mark. Both readings are KILOBYTES and the
      // seam is bytes, so the conversion happens here, at the edge.
      const text = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = (field: string): number | null => {
        const found = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, "m").exec(text);
        return found ? Number(found[1]) : null;
      };
      return {
        current_bytes: (kb("VmRSS") ?? 0) * 1024,
        peak_bytes: kb("VmHWM") === null ? null : (kb("VmHWM") as number) * 1024,
        source: "proc-status",
      };
    },

    async available(): Promise<{ ok: boolean; reason: string }> {
      const answer = await sh(["--user", "is-system-running"]);
      const said = (answer.out + answer.err).trim().split("\n")[0] || "nothing";
      if (!/^(running|degraded|starting|maintenance)$/.test(said)) {
        return { ok: false, reason: `no user manager answers: systemctl --user is-system-running said ${said}` };
      }
      return { ok: true, reason: "" };
    },
  };
}
