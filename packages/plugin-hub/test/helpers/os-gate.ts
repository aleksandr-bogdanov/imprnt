// Test infrastructure: the one gate every OS-bound check asks, and the machine
// identity every gated fixture declares.
//
// 03-CONTEXT "How a check is gated, and how a skip is made visible". An OS-bound
// check calls ONE gate. It answers three questions in order and each failure
// carries its own reason: is there a manager for this platform at all, does it
// answer, and on linux is XDG_RUNTIME_DIR set. A closed gate is never a silent
// pass: the reason goes into the TEST NAME through `gateSuffix`, so bun's
// reporter prints it beside the skip, and into one stderr line through
// `announceGate`. A static name plus a bare `test.skipIf` prints a skip with no
// reason, which is the silent pass this rule exists to prevent.
//
// The gate is evaluated ONCE, at module load, with synchronous spawns, so a
// test name can carry its reason (a name is built before any test body runs).
//
// WHAT THE GATE IS NOT. It asks about the MANAGER, never about `src/os/`.
// `seam` is therefore null until that module exists, and every gated check
// still imports the module through `seam()` inside its own body (D-25) and goes
// red there for "import missing". A gate that closed on a missing module would
// turn every one of those checks into a skip, which is the opposite of a red
// round.

import { existsSync } from "node:fs";

export interface OsGate {
  ok: boolean;
  reason: string;
  /** The seam, once `src/os/index.ts` exists. Null until then, and the check's
   *  own `seam()` import is what reports that. */
  seam: unknown | null;
}

function sh(
  bin: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  try {
    const out = Bun.spawnSync([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: out.exitCode ?? 1,
      stdout: out.stdout?.toString() ?? "",
      stderr: out.stderr?.toString() ?? "",
    };
  } catch (error) {
    return { code: 127, stdout: "", stderr: String((error as Error).message) };
  }
}

function onPath(bin: string): string | null {
  const found = sh("/usr/bin/which", [bin]);
  if (found.code !== 0) return null;
  const path = found.stdout.trim().split("\n")[0];
  return path && existsSync(path) ? path : null;
}

function probe(): OsGate {
  const open = (): OsGate => ({ ok: true, reason: "", seam: null });
  const shut = (reason: string): OsGate => ({ ok: false, reason, seam: null });

  if (process.platform === "darwin") {
    const launchctl = onPath("launchctl");
    if (!launchctl) return shut("no manager for darwin: launchctl is not on PATH");
    const uid = process.getuid?.() ?? -1;
    if (uid < 0) return shut("no manager for darwin: this process has no uid");
    const answer = sh(launchctl, ["print", `gui/${uid}`]);
    if (answer.code !== 0) {
      return shut(
        `the user manager does not answer: launchctl print gui/${uid} exited ${answer.code}`,
      );
    }
    return open();
  }

  if (process.platform === "linux") {
    const systemctl = onPath("systemctl");
    if (!systemctl) return shut("no manager for linux: systemctl is not on PATH");
    const answer = sh(systemctl, ["--user", "is-system-running"]);
    const said = (answer.stdout + answer.stderr).trim().split("\n")[0] || "nothing";
    // `degraded` is a manager that answers with a failed unit somewhere, which
    // is the hub box's own normal state and not a reason to skip.
    if (!/^(running|degraded|starting)$/.test(said)) {
      return shut(`no user manager answers: systemctl --user is-system-running said ${said}`);
    }
    if (!process.env.XDG_RUNTIME_DIR) {
      return shut("no user manager answers: XDG_RUNTIME_DIR is not set");
    }
    return open();
  }

  return shut(`no manager for ${process.platform}: this phase has launchd and systemd`);
}

const GATE: OsGate = probe();

export function osGate(): OsGate {
  return { ...GATE };
}

/** The reason, in the TEST NAME, so a skip is never silent. */
export function gateSuffix(gate: OsGate = GATE): string {
  return gate.ok ? "" : ` [skipped: ${gate.reason}]`;
}

/** One line on stderr, from beforeAll, naming the gate and the platform. */
export function announceGate(gate: OsGate = GATE, what = "an OS-bound check"): void {
  process.stderr.write(
    `[os-gate] ${what} on ${process.platform}: ${gate.ok ? "open" : `SKIPPED, ${gate.reason}`}\n`,
  );
}

/**
 * D-100's machine ids, picked from the platform this check is running on.
 *
 * Every gated check declares its `[[machines]]` entry through this, because
 * D-77 has the hub refuse a machine whose declared `os` is not the platform it
 * is running on. A fixture that hard-coded `pi`/`linux` would be refused before
 * the check started, on a Mac, and would read exactly like a hub bug.
 */
export function thisMachine(): { id: "pi" | "mac"; os: "linux" | "macos" } {
  return process.platform === "darwin"
    ? { id: "mac", os: "macos" }
    : { id: "pi", os: "linux" };
}
