import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const STATUSLINE = join(here, "statusline.ts");

const FULL = {
  model: { display_name: "Opus" },
  session_name: "taxes-deep-dive",
  workspace: { current_dir: "" }, // filled per test
  context_window: { used_percentage: 41.7 },
  cost: { total_cost_usd: 1.234, total_duration_ms: 4_320_000, total_lines_added: 156, total_lines_removed: 23 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1739430000 },
  },
};

// The bar carries ANSI color codes; assertions read the plain text underneath. COLUMNS is pinned
// wide by default so the width fitter never interferes unless a test sets it, the network is
// disabled (no weather curl from tests), and IMPRNT_VAULT is blanked unless a test sets it.
function lineFor(stdin: string, env: Record<string, string> = {}): { out: string; code: number } {
  const r = Bun.spawnSync(["bun", STATUSLINE], {
    stdin: Buffer.from(stdin),
    env: {
      ...process.env,
      COLUMNS: "500",
      IMPRNT_STATUSLINE_NO_NET: "1",
      IMPRNT_VAULT: "",
      IMPRINT_VAULT: "",
      ...env,
    },
  });
  // eslint-disable-next-line no-control-regex
  return { out: r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "").trim(), code: r.exitCode };
}

test("renders the full panel from a full payload", () => {
  const payload = { ...FULL, workspace: { current_dir: mkdtempSync(join(tmpdir(), "imprnt-sl-")) } };
  const r = lineFor(JSON.stringify(payload));
  expect(r.code).toBe(0);
  expect(r.out).toContain("Opus");
  expect(r.out).toContain("taxes-deep-dive"); // the /rename session name
  expect(r.out).toContain("imprnt-sl-"); // dir basename, no branch segment outside a repo
  expect(r.out).toContain("ctx ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱ 42%"); // labeled, 41.7% -> 7 of 16 cells
  expect(r.out).toContain("$1.23");
  expect(r.out).toContain("1h12m");
  expect(r.out).toContain("+156/-23");
  expect(r.out).toMatch(/5h 24% →(\d{2}:\d{2}|\w{3})/); // reset: clock today, weekday otherwise
  expect(r.out).toMatch(/7d 41% →(\d{2}:\d{2}|\w{3})/); // the 7-day window gets a reset too
  expect(r.out).toMatch(/\d{2}:\d{2}$/); // the wall clock closes the line
});

test("a far-off reset renders as a weekday, not a meaningless clock time", () => {
  // resets_at ~100 days out is never "today", so the weekday form must render.
  const payload = {
    rate_limits: { seven_day: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 100 * 86400 } },
  };
  const r = lineFor(JSON.stringify(payload));
  expect(r.out).toMatch(/7d 10% →(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
});

test("inside a git repo the branch renders, with ahead count against its upstream", () => {
  const upstream = mkdtempSync(join(tmpdir(), "imprnt-sl-up-"));
  const opts = { cwd: upstream } as const;
  Bun.spawnSync(["git", "init", "-q", "-b", "statusline-test-branch"], opts);
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], opts);
  const repo = mkdtempSync(join(tmpdir(), "imprnt-sl-git-"));
  Bun.spawnSync(["git", "clone", "-q", upstream, "clone"], { cwd: repo });
  const clone = join(repo, "clone");
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "ahead"], { cwd: clone });
  const r = lineFor(JSON.stringify({ workspace: { current_dir: clone } }));
  expect(r.out).toContain("statusline-test-branch");
  expect(r.out).toContain("↑1");
});

test("the vault segment shows note count and a needs-review flag from IMPRNT_VAULT", () => {
  const vault = mkdtempSync(join(tmpdir(), "imprnt-sl-vault-"));
  mkdirSync(join(vault, "people"));
  writeFileSync(join(vault, "people", "sam.md"), "# Sam\n");
  writeFileSync(join(vault, "finances", "..", "note.md"), "# Note\n");
  writeFileSync(join(vault, "_tags.md"), "control file, not a note\n");
  writeFileSync(join(vault, "_needs-review.md"), "# review\n- orphan link in x\n- untagged y\n");
  const r = lineFor(JSON.stringify({}), { IMPRNT_VAULT: vault });
  expect(r.out).toContain("vault 2 2!"); // 2 notes (_-files excluded), 2 review items
});

test("a narrow terminal drops housekeeping segments first, per row, never wraps", () => {
  const payload = { ...FULL, workspace: { current_dir: mkdtempSync(join(tmpdir(), "imprnt-sl-")) } };
  const r = lineFor(JSON.stringify(payload), { COLUMNS: "40" });
  const rows = r.out.split("\n");
  expect(rows.length).toBe(2);
  for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
  expect(rows[0]).toContain("Opus"); // model survives its row
  expect(rows[1]).toContain("%"); // context survives its row
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
