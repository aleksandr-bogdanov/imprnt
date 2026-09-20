// Test infrastructure: the one gate the real-binary check asks, and how its
// skip stays visible.
//
// How a gated check is skipped, and how the skip stays visible: the same rule
// the OS gate follows, applied to the one gated
// check that needs a real login. The gate is evaluated ONCE, at module load, with
// synchronous spawns, so a test NAME can carry its reason (a name is built
// before any test body runs). The reason goes into the name through
// `gateSuffix`, so bun's reporter prints it beside the skip, and into one
// stderr line through `announceGate`. A static name plus a bare `test.skipIf`
// prints a skip with no reason, which is the silent pass this rule exists to
// prevent.
//
// WHAT THE GATE IS NOT. It asks about the BINARY, never about `src/adapters/`.
// The gated check still imports the adapter normally and asserts the behaviour
// inside its own body, so a gate that closed on a missing behaviour would turn
// a red into a skip, which is the opposite of a red round.
//
// The hub box keeps its `claude` at `~/.local/bin/claude`, which is not on that
// user's non-login PATH, so a SKIP there is the expected and honest outcome.
// CI has no `claude` at all.

import { existsSync } from "node:fs";

export interface ClaudeGate {
  ok: boolean;
  reason: string;
  /** The binary, once it is found and answers. Empty otherwise. */
  bin: string;
}

function sh(
  bin: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  try {
    const out = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" });
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

function probe(): ClaudeGate {
  const claude = onPath("claude");
  if (!claude) {
    return { ok: false, reason: "claude is not on PATH", bin: "" };
  }
  const answer = sh(claude, ["--version"]);
  if (answer.code !== 0) {
    return {
      ok: false,
      reason: `claude --version exited ${answer.code}`,
      bin: claude,
    };
  }
  const said = (answer.stdout + answer.stderr).trim().split("\n")[0] || "nothing";
  return { ok: true, reason: `claude answers ${said}`, bin: claude };
}

const GATE: ClaudeGate = probe();

export function claudeGate(): ClaudeGate {
  return { ...GATE };
}

/** The reason, in the TEST NAME, so a skip is never silent. */
export function gateSuffix(gate: ClaudeGate = GATE): string {
  return gate.ok ? "" : ` [skipped: ${gate.reason}]`;
}

/** One line on stderr, from beforeAll, naming the gate and what it is for. */
export function announceGate(
  gate: ClaudeGate = GATE,
  what = "a check that drives the real loop",
): void {
  process.stderr.write(
    `[claude-gate] ${what} on ${process.platform}: ` +
      `${gate.ok ? `open, ${gate.reason}` : `SKIPPED, ${gate.reason}`}\n`,
  );
}
