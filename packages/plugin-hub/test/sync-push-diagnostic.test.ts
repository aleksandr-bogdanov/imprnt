import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseGitFailure } from "../src/sync/run.ts";

test("a real nonforced push rejected after another writer advances is recorded without raw remote text", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-push-diagnostic-"));
  const remote = join(root, "remote.git"), first = join(root, "first"), second = join(root, "second");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error("fixture-git-failed");
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--bare", "--initial-branch=main", remote);
    git("clone", remote, first);
    writeFileSync(join(first, "note"), "initial");
    git("-C", first, "add", "."); git("-C", first, "commit", "-m", "initial"); git("-C", first, "push", "origin", "main");
    git("clone", remote, second);
    writeFileSync(join(first, "note"), "next");
    git("-C", first, "commit", "-am", "advance"); git("-C", first, "push", "origin", "main");
    git("-C", second, "commit", "--allow-empty", "-m", "parallel");
    const result = Bun.spawnSync(["git", "-C", second, "-c", "core.hooksPath=/dev/null", "push", "origin", "main"],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    const diagnosis = diagnoseGitFailure("push", result.exitCode, null, result.stdout.toString(), result.stderr.toString());
    expect(diagnosis).toEqual({ stage: "push", reason: "remote-advanced", exit: result.exitCode });
    expect(JSON.stringify(diagnosis)).not.toContain(root);
    expect(git("--git-dir", remote, "rev-parse", "main")).toBe(git("-C", first, "rev-parse", "HEAD"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("push diagnostics do not turn unrelated failures into a remote advance", () => {
  expect(diagnoseGitFailure("push", 1, null, "", "fatal: connection closed").reason).toBe("unknown");
  expect(diagnoseGitFailure("fetch", 1, null, "", " ! [rejected] main -> main (fetch first)").reason).toBe("unknown");
});
