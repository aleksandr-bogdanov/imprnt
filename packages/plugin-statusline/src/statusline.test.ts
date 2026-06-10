import { test, expect } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const STATUSLINE = join(here, "statusline.ts");

function lineFor(stdin: string): { out: string; code: number } {
  const r = Bun.spawnSync(["bun", STATUSLINE], { stdin: Buffer.from(stdin) });
  return { out: r.stdout.toString().trim(), code: r.exitCode };
}

test("renders model · dir · context · cost from a full payload", () => {
  const r = lineFor(
    JSON.stringify({
      model: { display_name: "Opus" },
      workspace: { current_dir: "/Users/x/projects/imprnt" },
      context_window: { used_percentage: 41.7 },
      cost: { total_cost_usd: 1.234 },
    }),
  );
  expect(r.code).toBe(0);
  expect(r.out).toBe("Opus · imprnt · ctx 42% · $1.23");
});

test("a missing field drops its segment, the rest still render", () => {
  const r = lineFor(JSON.stringify({ model: { display_name: "Opus" }, cost: {} }));
  expect(r.out).toBe("Opus");
});

test("unparseable stdin prints nothing and exits 0 — a status line never crashes a session", () => {
  const r = lineFor("not json");
  expect(r.code).toBe(0);
  expect(r.out).toBe("");
});
