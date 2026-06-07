import { test, expect } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The whenful scripts resolve every path from import.meta.url (their own folder) and the repo root two
// levels up. To exercise them in isolation we build a throwaway repo tree:
//
//   <tmp>/plugins/whenful/{whenful.ts, check.ts, links.tsv, mirror/}
//   <tmp>/vault/<folder>/<slug>.md
//
// and copy the real scripts into it. This reaches the actual sync + check code paths (not a re-implement)
// while keeping the real repo's links.tsv/vault untouched.
const srcDir = join(fileURLToPath(import.meta.url), "..");

function makeRepo(): { root: string; pluginDir: string; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "whenful-test-"));
  const pluginDir = join(root, "plugins", "whenful");
  const vault = join(root, "vault");
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(join(pluginDir, "mirror"), { recursive: true });
  mkdirSync(vault, { recursive: true });
  copyFileSync(join(srcDir, "whenful.ts"), join(pluginDir, "whenful.ts"));
  copyFileSync(join(srcDir, "check.ts"), join(pluginDir, "check.ts"));
  return { root, pluginDir, vault };
}

function writeLinks(pluginDir: string, lines: string[]) {
  writeFileSync(join(pluginDir, "links.tsv"), lines.join("\n") + "\n");
}

// Run a whenful script with NO network access available to the process. We can't fully sandbox the
// network from a test, but the sync path is a documented stub: it must complete fast and offline.
function run(pluginDir: string, file: string, ...args: string[]) {
  const proc = Bun.spawnSync(["bun", join(pluginDir, file), ...args]);
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

test("sync makes NO network call and writes a mirror/<id>.md offline", () => {
  const { pluginDir } = makeRepo();
  writeLinks(pluginDir, [
    "# header comment",
    "task-123\tprojects/whenful\tstep one",
  ]);

  const before = Date.now();
  const r = run(pluginDir, "whenful.ts", "sync");
  const elapsed = Date.now() - before;

  expect(r.exitCode).toBe(0);
  // Stub completes essentially instantly. A real network call would not (and the code has none).
  expect(elapsed).toBeLessThan(5000);
  expect(r.stdout).toContain("no live Whenful call is made");

  // The mirror file for the linked task is written from the stub, no wire involved.
  const mirrorFile = join(pluginDir, "mirror", "task-123.md");
  expect(existsSync(mirrorFile)).toBe(true);
  expect(readFileSync(mirrorFile, "utf8")).toContain("task_id: task-123");
  // last-sync is stamped so the staleness check is exercisable.
  expect(existsSync(join(pluginDir, "mirror", ".last-sync"))).toBe(true);
});

test("sync with no links exits 0 and writes nothing (offline)", () => {
  const { pluginDir } = makeRepo();
  writeLinks(pluginDir, ["# only comments, no rows"]);
  const r = run(pluginDir, "whenful.ts", "sync");
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("nothing to mirror");
});

test("check exits 0 on a clean links.tsv (every link resolves, mirror fresh)", () => {
  const { pluginDir, vault } = makeRepo();
  mkdirSync(join(vault, "projects"), { recursive: true });
  writeFileSync(join(vault, "projects", "whenful.md"), "# Whenful\n");
  writeLinks(pluginDir, ["task-1\tprojects/whenful\t"]);
  // Fresh sync stamp so the staleness gate passes.
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), new Date().toISOString() + "\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("sound.");
});

test("check soft-fails (non-zero) when the mirror is older than the stale threshold (>7 days)", () => {
  const { pluginDir, vault } = makeRepo();
  mkdirSync(join(vault, "projects"), { recursive: true });
  writeFileSync(join(vault, "projects", "whenful.md"), "# Whenful\n");
  writeLinks(pluginDir, ["task-1\tprojects/whenful\t"]);
  // Stamp a sync 8 days in the past (> STALE_DAYS of 7). check.ts parses the stamp's date.
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), eightDaysAgo.toISOString() + "\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("stale");
});

test("check exits non-zero on an unparseable .last-sync stamp", () => {
  const { pluginDir, vault } = makeRepo();
  mkdirSync(join(vault, "projects"), { recursive: true });
  writeFileSync(join(vault, "projects", "whenful.md"), "# Whenful\n");
  writeLinks(pluginDir, ["task-1\tprojects/whenful\t"]);
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), "not-a-date garbage\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("unparseable");
});

test("check exits non-zero on an orphan link (note_slug has no vault note)", () => {
  const { pluginDir } = makeRepo();
  writeLinks(pluginDir, ["task-9\tprojects/does-not-exist\t"]);
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), new Date().toISOString() + "\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("orphan link");
});

test("usage: unknown command exits 1", () => {
  const { pluginDir } = makeRepo();
  const r = run(pluginDir, "whenful.ts", "bogus");
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("usage");
});
