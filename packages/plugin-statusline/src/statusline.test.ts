import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const STATUSLINE = join(here, "statusline.ts");

// The bar carries ANSI color codes; assertions read the plain text underneath.
function lineFor(stdin: string): { out: string; code: number } {
  const r = Bun.spawnSync(["bun", STATUSLINE], { stdin: Buffer.from(stdin) });
  // eslint-disable-next-line no-control-regex
  return { out: r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "").trim(), code: r.exitCode };
}

test("renders model · dir · context · cost · limits · clock from a full payload", () => {
  const r = lineFor(
    JSON.stringify({
      model: { display_name: "Opus" },
      workspace: { current_dir: mkdtempSync(join(tmpdir(), "imprnt-sl-")) }, // not a git repo
      context_window: { used_percentage: 41.7 },
      cost: { total_cost_usd: 1.234 },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2 },
      },
    }),
  );
  expect(r.code).toBe(0);
  expect(r.out).toContain("Opus");
  expect(r.out).toContain("imprnt-sl-"); // dir basename, no branch segment outside a repo
  expect(r.out).toContain("ctx 42%");
  expect(r.out).toContain("$1.23");
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

test("a missing field drops its segment, the rest still render", () => {
  const r = lineFor(JSON.stringify({ model: { display_name: "Opus" }, cost: {} }));
  expect(r.out).toContain("Opus");
  expect(r.out).not.toContain("ctx");
  expect(r.out).not.toContain("$");
});

test("unparseable stdin prints nothing and exits 0 — a status line never crashes a session", () => {
  const r = lineFor("not json");
  expect(r.code).toBe(0);
  expect(r.out).toBe("");
});
