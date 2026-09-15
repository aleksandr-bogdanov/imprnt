// Test infrastructure: the service manager's OWN truth, read without the seam.
//
// Several checks assert "this unit is really running", "this pid never changed"
// or "the operating system started it again". Reading those through
// `src/os/index.ts` would be asking the code under test whether it worked, so
// this module asks the manager directly and parses what it printed. It imports
// nothing from `src/`, deliberately, the same reason `test/helpers/units.ts`
// keeps its own copy of the two prefixes.
//
// The four counters follow D-101, which exists because launchd's single counter
// counts EXECUTIONS and systemd's counts RESTARTS. Measured on this Mac with
// `launchctl print gui/<uid>/<label>`, 2026-09-15:
//
//   a healthy KeepAlive job     state = running       runs = 1  last exit code = (never exited)
//   a job that ran once, exit 0 state = not running   runs = 1  last exit code = 0
//   a job whose command exits 3 state = spawn scheduled runs = 4 then 7  last exit code = 3
//
// so `runs` is the number of executions, `ran` is `runs >= 1`, and `restarts`
// is `runs - 1`. On systemd `NRestarts` is already the restart count, there is
// no execution count at all, and "it ran" is a non-empty
// `ExecMainStartTimestamp`.

export interface ManagerView {
  /** What was asked about: the render-prefix base, with no suffix. */
  base: string;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  /** Executions, where the manager counts them. Null on systemd (D-101). */
  runs: number | null;
  /** The manager's own record says the program has executed at least once. */
  ran: boolean;
  /** Starts AFTER the first one. systemd NRestarts, launchd max(runs - 1, 0). */
  restarts: number | null;
  /** launchd's last exit code, null while it reads "(never exited)". */
  lastExit: number | null;
  /** What the manager printed, for a failure message. */
  raw: string;
}

function sh(bin: string, args: string[]): { code: number; out: string } {
  try {
    const done = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    return {
      code: done.exitCode ?? 1,
      out: (done.stdout?.toString() ?? "") + (done.stderr?.toString() ?? ""),
    };
  } catch (error) {
    return { code: 127, out: String((error as Error).message) };
  }
}

/** Whether a pid names a live process. */
export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function darwin(base: string): ManagerView | null {
  const uid = process.getuid?.() ?? -1;
  const printed = sh("launchctl", ["print", `gui/${uid}/${base}`]);
  if (printed.code !== 0) return null;
  const text = printed.out;
  const state = /^\s*state = (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const pid = Number(/^\s*pid = (\d+)$/m.exec(text)?.[1] ?? 0) || null;
  const runsFound = /^\s*runs = (\d+)$/m.exec(text)?.[1];
  const runs = runsFound === undefined ? null : Number(runsFound);
  const exitText = /^\s*last exit code = (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const lastExit = /^-?\d+$/.test(exitText) ? Number(exitText) : null;
  return {
    base,
    // `launchctl print` answered at all, so the job is bootstrapped.
    loaded: true,
    running: state === "running",
    pid,
    runs,
    ran: (runs ?? 0) >= 1,
    restarts: runs === null ? null : Math.max(runs - 1, 0),
    lastExit,
    raw: text,
  };
}

function linux(base: string): ManagerView | null {
  const unit = base.endsWith(".service") || base.endsWith(".timer") ? base : `${base}.service`;
  const shown = sh("systemctl", [
    "--user",
    "show",
    unit,
    "-p",
    "LoadState",
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "MainPID",
    "-p",
    "ExecMainPID",
    "-p",
    "NRestarts",
    "-p",
    "ExecMainStatus",
    "-p",
    "ExecMainStartTimestamp",
    "--no-pager",
  ]);
  if (shown.code !== 0) return null;
  const fields = new Map<string, string>();
  for (const line of shown.out.split("\n")) {
    const cut = line.indexOf("=");
    if (cut > 0) fields.set(line.slice(0, cut), line.slice(cut + 1).trim());
  }
  if ((fields.get("LoadState") ?? "not-found") === "not-found") return null;
  const pid = Number(fields.get("ExecMainPID") || fields.get("MainPID") || 0) || null;
  const restartsText = fields.get("NRestarts") ?? "";
  const statusText = fields.get("ExecMainStatus") ?? "";
  return {
    base,
    loaded: fields.get("LoadState") === "loaded",
    running: fields.get("SubState") === "running",
    pid,
    // systemd counts no executions at all (D-101).
    runs: null,
    ran: (fields.get("ExecMainStartTimestamp") ?? "") !== "",
    restarts: /^\d+$/.test(restartsText) ? Number(restartsText) : null,
    lastExit: /^-?\d+$/.test(statusText) ? Number(statusText) : null,
    raw: shown.out,
  };
}

/**
 * What the manager says about one unit, or null when it has never heard of it.
 *
 * `base` is the render-prefix name with no suffix (`imprnt-hub-<entry id>`),
 * which is a launchd Label as it stands and a systemd unit once `.service` is
 * appended.
 */
export function managerState(base: string): ManagerView | null {
  return process.platform === "darwin" ? darwin(base) : linux(base);
}

export function managerPid(base: string): number | null {
  return managerState(base)?.pid ?? null;
}

/**
 * A live pid from the manager's own record, asserted to be a real process.
 *
 * "The label is listed" and "a process is running" are different claims, and
 * the first is what a hub that loaded a unit without starting it satisfies.
 */
export function livePid(base: string): number | null {
  const found = managerState(base);
  if (!found || !found.running) return null;
  return pidAlive(found.pid) ? found.pid : null;
}
