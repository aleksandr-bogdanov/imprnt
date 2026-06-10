import { test, expect } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

test("check flags a FUTURE .last-sync stamp as corrupt (non-zero, no negative age)", () => {
  const { pluginDir, vault } = makeRepo();
  mkdirSync(join(vault, "projects"), { recursive: true });
  writeFileSync(join(vault, "projects", "whenful.md"), "# Whenful\n");
  writeLinks(pluginDir, ["task-1\tprojects/whenful\t"]);
  // A sync stamped 5 days in the FUTURE yields a negative age. The old code read that as fresh and
  // printed a nonsensical "-5.0 days ago". A future timestamp is corrupt data - must be flagged.
  const fiveDaysAhead = new Date(Date.now() + 5 * 86_400_000);
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), fiveDaysAhead.toISOString() + "\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("future");
  expect(r.stdout).not.toContain("-5.0 days ago");
});

test("check flags a whitespace-only task_id row as unparseable (trims before validating)", () => {
  const { pluginDir, vault } = makeRepo();
  mkdirSync(join(vault, "projects"), { recursive: true });
  writeFileSync(join(vault, "projects", "whenful.md"), "# Whenful\n");
  // A blank task_id column (a lone space) passed the truthiness check before trimming, then trimmed to
  // "" - a link that cannot key into mirror/<id>.md. Trim first so the blank column is flagged.
  writeLinks(pluginDir, [
    "task-1\tprojects/whenful\t", // good row - still counts
    " \tprojects/whenful\tstep",  // whitespace-only task_id - unparseable after trim
  ]);
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), new Date().toISOString() + "\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("unparseable");
  expect(r.stdout).toContain("1 link(s)"); // only the good row counts
});

test("check exits non-zero on an orphan link (note_slug has no vault note)", () => {
  const { pluginDir } = makeRepo();
  writeLinks(pluginDir, ["task-9\tprojects/does-not-exist\t"]);
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), new Date().toISOString() + "\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("orphan link");
});

test("check survives a broken symlink at vault top level during bare-slug resolution", () => {
  const { pluginDir, vault } = makeRepo();
  mkdirSync(join(vault, "projects"), { recursive: true });
  writeFileSync(join(vault, "projects", "whenful.md"), "# Whenful\n");
  // A dangling symlink sorts before "projects" in the readdir walk - it must be skipped, not crash.
  symlinkSync(join(vault, "no-such-target"), join(vault, "dangling"));
  writeLinks(pluginDir, ["task-1\twhenful\t"]); // bare slug forces the vault folder walk
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), new Date().toISOString() + "\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("sound.");
});

test("check flags a malformed links.tsv row (space-delimited) and exits non-zero", () => {
  const { pluginDir, vault } = makeRepo();
  mkdirSync(join(vault, "projects"), { recursive: true });
  writeFileSync(join(vault, "projects", "whenful.md"), "# Whenful\n");
  writeLinks(pluginDir, [
    "task-1\tprojects/whenful\t", // parseable row - behavior unchanged
    "task-2 projects/whenful step", // space-delimited, no tabs - unparseable as TSV
  ]);
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), new Date().toISOString() + "\n");

  const r = run(pluginDir, "check.ts");
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("unparseable");
  expect(r.stdout).toContain("1 link(s)"); // the parseable row still counts
});

test("usage: unknown command exits 1", () => {
  const { pluginDir } = makeRepo();
  const r = run(pluginDir, "whenful.ts", "bogus");
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("usage");
});
