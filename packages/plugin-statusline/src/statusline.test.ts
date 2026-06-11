import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const STATUSLINE = join(here, "statusline.ts");

const FULL = {
  model: { display_name: "Opus" },
  workspace: { current_dir: "" }, // filled per test
  context_window: { used_percentage: 41.7 },
  cost: { total_cost_usd: 1.234, total_duration_ms: 4_320_000, total_lines_added: 156, total_lines_removed: 23 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2 },
  },
};

// The bar carries ANSI color codes; assertions read the plain text underneath. COLUMNS is pinned
// wide by default so the width fitter never interferes unless a test sets it.
function lineFor(stdin: string, env: Record<string, string> = {}): { out: string; code: number } {
  const r = Bun.spawnSync(["bun", STATUSLINE], {
    stdin: Buffer.from(stdin),
    env: { ...process.env, COLUMNS: "500", ...env },
  });
  // eslint-disable-next-line no-control-regex
  return { out: r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "").trim(), code: r.exitCode };
}

test("renders the full panel from a full payload", () => {
  const payload = { ...FULL, workspace: { current_dir: mkdtempSync(join(tmpdir(), "imprnt-sl-")) } };
  const r = lineFor(JSON.stringify(payload));
  expect(r.code).toBe(0);
  expect(r.out).toContain("Opus");
  expect(r.out).toContain("imprnt-sl-"); // dir basename, no branch segment outside a repo
  expect(r.out).toContain("▰▰▰▱▱▱▱▱ 42%"); // 41.7% -> 3 of 8 cells
  expect(r.out).toContain("$1.23");
  expect(r.out).toContain("1h12m");
  expect(r.out).toContain("+156/-23");
  expect(r.out).toMatch(/5h 24% →\d{2}:\d{2}/); // five-hour window with its reset clock
  expect(r.out).toContain("7d 41%");
  expect(r.out).toMatch(/\d{2}:\d{2}$/); // the wall clock closes the line
});

test("inside a git repo the current branch becomes a segment", () => {
  const repo = mkdtempSync(join(tmpdir(), "imprnt-sl-git-"));
  Bun.spawnSync(["git", "-C", repo, "init", "-q", "-b", "statusline-test-branch"]);
  const r = lineFor(JSON.stringify({ workspace: { current_dir: repo } }));
  expect(r.out).toContain("statusline-test-branch");
});

test("a narrow terminal drops housekeeping segments first, never wraps", () => {
  const payload = { ...FULL, workspace: { current_dir: mkdtempSync(join(tmpdir(), "imprnt-sl-")) } };
  const r = lineFor(JSON.stringify(payload), { COLUMNS: "40" });
  expect(r.out.length).toBeLessThanOrEqual(40);
  expect(r.out).toContain("Opus"); // model survives
  expect(r.out).toContain("%"); // context survives
  expect(r.out).not.toContain("+156"); // lines dropped early
});

test("a missing field drops its segment, the rest still render", () => {
  const r = lineFor(JSON.stringify({ model: { display_name: "Opus" }, cost: {} }));
  expect(r.out).toContain("Opus");
  expect(r.out).not.toContain("▰");
  expect(r.out).not.toContain("$");
});

test("unparseable stdin prints nothing and exits 0 — a status line never crashes a session", () => {
  const r = lineFor("not json");
  expect(r.code).toBe(0);
  expect(r.out).toBe("");
});
