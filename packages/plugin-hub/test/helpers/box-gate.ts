// Test infrastructure: the gate for the box, which is a different question from
// the gate for the unit manager.
//
// `bwrap` needs unprivileged user namespaces and a GitHub runner's support for
// them is not verified, so criterion 9 is gated on the TOOL rather
// than on a manager, and a closed gate is a named skip and not a failure. The
// reason goes into the test name through `gateSuffix`, the same way the OS gate
// does, so nothing here is ever a silent pass.
//
// The gate asks only whether the tool exists and runs. It never judges the
// profile or the argv: those are `src/box/index.ts`'s, and check 15 binds what
// the probe PRINTED rather than what the profile said.

import { existsSync, readFileSync } from "node:fs";

export interface BoxGate {
  ok: boolean;
  reason: string;
  tool: "bwrap" | "sandbox-exec" | null;
}

function run(bin: string, args: string[]): { code: number; out: string } {
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

function probe(): BoxGate {
  if (process.platform === "darwin") {
    const tool = "/usr/bin/sandbox-exec";
    if (!existsSync(tool)) {
      return { ok: false, reason: `${tool} is not on this box`, tool: null };
    }
    // A permissive profile, because what is being asked is whether the TOOL
    // runs, not whether a particular profile is right.
    const done = run(tool, ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
    if (done.code !== 0) {
      return {
        ok: false,
        reason: `sandbox-exec did not run a trivial command: exit ${done.code} ${done.out.trim().slice(0, 120)}`,
        tool: "sandbox-exec",
      };
    }
    return { ok: true, reason: "", tool: "sandbox-exec" };
  }

  if (process.platform === "linux") {
    const tool = "/usr/bin/bwrap";
    if (!existsSync(tool)) {
      return { ok: false, reason: `${tool} is not on this box`, tool: null };
    }
    // A box that cannot unshare is not a box.
    let max = 0;
    try {
      max = Number(readFileSync("/proc/sys/user/max_user_namespaces", "utf8").trim());
    } catch {
      max = 0;
    }
    if (!(max > 0)) {
      return {
        ok: false,
        reason: "unprivileged user namespaces are not allowed: /proc/sys/user/max_user_namespaces is 0 or unreadable",
        tool: "bwrap",
      };
    }
    const done = run(tool, ["--unshare-pid", "--dev-bind", "/", "/", "--proc", "/proc", "--", "/bin/true"]);
    if (done.code !== 0) {
      return {
        ok: false,
        reason: `bwrap did not run a trivial command: exit ${done.code} ${done.out.trim().slice(0, 120)}`,
        tool: "bwrap",
      };
    }
    return { ok: true, reason: "", tool: "bwrap" };
  }

  return {
    ok: false,
    reason: `no box tool for ${process.platform}: this phase has bwrap and sandbox-exec`,
    tool: null,
  };
}

const GATE: BoxGate = probe();

export function boxGate(): BoxGate {
  return { ...GATE };
}
