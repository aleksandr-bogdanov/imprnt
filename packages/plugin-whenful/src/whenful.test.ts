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
  copyFileSync(join(srcDir, "client.ts"), join(pluginDir, "client.ts")); // whenful.ts imports it
  return { root, pluginDir, vault };
}

// Write a fixtures dir with one <id>.json per task, shaped like Whenful's TaskResponse. WHENFUL_FIXTURES
// points sync at these so the live code path runs with ZERO network.
function writeFixtures(dir: string, tasks: Array<Record<string, unknown>>) {
  mkdirSync(dir, { recursive: true });
  for (const t of tasks) writeFileSync(join(dir, `${t.id}.json`), JSON.stringify(t));
}

function writeLinks(pluginDir: string, lines: string[]) {
  writeFileSync(join(pluginDir, "links.tsv"), lines.join("\n") + "\n");
}

// Run a whenful script. `env` overlays the child's environment — the sync tests use WHENFUL_FIXTURES
// to drive the live code path with ZERO network, and deliberately clear WHENFUL_TOKEN so the
// missing-auth path is exercised honestly rather than picking up a token from the dev's shell.
function run(pluginDir: string, file: string, args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bun", join(pluginDir, file), ...args], {
    env: { ...process.env, WHENFUL_TOKEN: "", WHENFUL_FIXTURES: "", ...env },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

test("sync reads the real fields from a fixture and renders them into mirror/<id>.md (zero network)", () => {
  const { root, pluginDir } = makeRepo();
  const fixtures = join(root, "fixtures");
  writeFixtures(fixtures, [
    {
      id: 4242,
      title: "Lock in BU insurance: the colon test",
      description: "follow up with the broker",
      domain_name: "finances",
      duration_minutes: 30,
      impact: 1,
      clarity: "normal",
      scheduled_date: "2026-06-20",
      scheduled_time: "09:00:00",
      is_recurring: false,
      status: "active",
      completed_at: null,
      today_instance_completed: null,
    },
  ]);
  writeLinks(pluginDir, ["# header comment", "4242\tprojects/whenful\tstep one"]);

  const r = run(pluginDir, "whenful.ts", ["sync"], { WHENFUL_FIXTURES: fixtures });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("1/1 task(s) mirrored");

  const mirrorFile = join(pluginDir, "mirror", "4242.md");
  expect(existsSync(mirrorFile)).toBe(true);
  const body = readFileSync(mirrorFile, "utf8");
  expect(body).toContain("task_id: 4242");
  expect(body).toContain('status: "active"');
  expect(body).toContain('impact: "high"'); // 1 -> high
  expect(body).toContain("domain: \"finances\"");
  expect(body).toContain("due: \"2026-06-20 09:00:00\"");
  // A title with a colon must round-trip as a quoted YAML scalar, not break the frontmatter.
  expect(body).toContain('title: "Lock in BU insurance: the colon test"');
  // last-sync is stamped so the staleness check is exercisable.
  expect(existsSync(join(pluginDir, "mirror", ".last-sync"))).toBe(true);
});

test("sync neutralizes a newline in a title — no injected frontmatter keys (parses to one block)", () => {
  const { root, pluginDir } = makeRepo();
  const fixtures = join(root, "fixtures");
  // Whenful keeps interior newlines in a title (its validator strips only control chars). A two-line
  // title must NOT split the quoted scalar across physical lines and inject sibling keys at column 0.
  writeFixtures(fixtures, [
    { id: 5, title: "evil\ninjected_key: pwned\nstatus: HIJACKED", description: "ok\nsecond line",
      domain_name: null, duration_minutes: null, impact: 2, clarity: null, scheduled_date: null,
      scheduled_time: null, is_recurring: false, status: "active", completed_at: null,
      today_instance_completed: null },
  ]);
  writeLinks(pluginDir, ["5\tprojects/a\t"]);

  const r = run(pluginDir, "whenful.ts", ["sync"], { WHENFUL_FIXTURES: fixtures });
  expect(r.exitCode).toBe(0);

  const body = readFileSync(join(pluginDir, "mirror", "5.md"), "utf8");
  // The frontmatter block is exactly one fenced region; split on the closing fence and inspect keys.
  const fm = body.split("\n---")[0].replace(/^---\n/, "");
  // No injected key landed at column 0 inside the frontmatter.
  expect(fm).not.toMatch(/^injected_key:/m);
  // status stayed the real server value, not the injected "HIJACKED".
  expect(fm).toMatch(/^status: "active"$/m);
  // title is a single physical line (the newline got collapsed to a space).
  expect(fm).toMatch(/^title: "evil injected_key: pwned status: HIJACKED"$/m);
});

test("sync dedups: one task linked from two notes is fetched and mirrored once", () => {
  const { root, pluginDir, vault } = makeRepo();
  mkdirSync(join(vault, "projects"), { recursive: true });
  const fixtures = join(root, "fixtures");
  writeFixtures(fixtures, [
    { id: 7, title: "shared task", description: null, domain_name: null, duration_minutes: null,
      impact: 2, clarity: null, scheduled_date: null, scheduled_time: null, is_recurring: false,
      status: "active", completed_at: null, today_instance_completed: null },
  ]);
  writeLinks(pluginDir, ["7\tprojects/a\tstep one", "7\tprojects/b\tstep two"]);

  const r = run(pluginDir, "whenful.ts", ["sync"], { WHENFUL_FIXTURES: fixtures });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("1/1 task(s) mirrored"); // deduped to a single fetch
  // An unscheduled task with no domain renders explicit nulls, not a broken frontmatter.
  const body = readFileSync(join(pluginDir, "mirror", "7.md"), "utf8");
  expect(body).toContain("due: null");
  expect(body).toContain("domain: null");
});

test("sync FAILS LOUD (non-zero) when neither WHENFUL_TOKEN nor WHENFUL_FIXTURES is set", () => {
  const { pluginDir } = makeRepo();
  writeLinks(pluginDir, ["4242\tprojects/whenful\t"]);
  // No token, no fixtures — the missing-credential preflight must exit non-zero before any wire call.
  const r = run(pluginDir, "whenful.ts", ["sync"]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr).toContain("WHENFUL_TOKEN");
  // It must NOT stamp a fresh .last-sync on a failed run — that would hide the problem from `check`.
  expect(existsSync(join(pluginDir, "mirror", ".last-sync"))).toBe(false);
});

test("sync isolates a per-task failure (a missing fixture) without sinking the rest, exits non-zero", () => {
  const { root, pluginDir } = makeRepo();
  const fixtures = join(root, "fixtures");
  writeFixtures(fixtures, [
    { id: 1, title: "present", description: null, domain_name: null, duration_minutes: null,
      impact: 3, clarity: null, scheduled_date: null, scheduled_time: null, is_recurring: false,
      status: "active", completed_at: null, today_instance_completed: null },
  ]);
  writeLinks(pluginDir, ["1\tprojects/a\t", "999\tprojects/b\t"]); // 999.json absent

  const r = run(pluginDir, "whenful.ts", ["sync"], { WHENFUL_FIXTURES: fixtures });
  expect(r.exitCode).not.toBe(0); // one task failed
  expect(r.stdout).toContain("1/2 task(s) mirrored"); // the good one still landed
  expect(r.stderr).toContain("999");
  expect(existsSync(join(pluginDir, "mirror", "1.md"))).toBe(true);
});

test("sync rejects a non-numeric task id as a per-task failure (never builds a bad URL)", () => {
  const { root, pluginDir } = makeRepo();
  const fixtures = join(root, "fixtures");
  writeFixtures(fixtures, []);
  writeLinks(pluginDir, ["not-a-number\tprojects/a\t"]);
  const r = run(pluginDir, "whenful.ts", ["sync"], { WHENFUL_FIXTURES: fixtures });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr).toContain("numeric");
});

test("sync with no links exits 0 and writes nothing", () => {
  const { pluginDir } = makeRepo();
  writeLinks(pluginDir, ["# only comments, no rows"]);
  const r = run(pluginDir, "whenful.ts", ["sync"]);
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
  const r = run(pluginDir, "whenful.ts", ["bogus"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("usage");
});
