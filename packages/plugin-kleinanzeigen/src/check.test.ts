import { test, expect } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";

// check.ts resolves every path from its own dir (mirror/, listings/, endpoints.json siblings) and the
// repo root two levels up — exactly the production layout plugins/kleinanzeigen/check.js. We build a
// throwaway plugin dir and copy the real check.ts in, reaching the actual code (not a re-implement).
const srcDir = dirname(fileURLToPath(import.meta.url));

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "ka-check-"));
  const pluginDir = join(root, "plugins", "kleinanzeigen");
  mkdirSync(join(pluginDir, "mirror"), { recursive: true });
  mkdirSync(join(pluginDir, "listings"), { recursive: true });
  copyFileSync(join(srcDir, "check.ts"), join(pluginDir, "check.ts"));
  return { root, pluginDir };
}

function writeConv(pluginDir: string, conv: string, listing: string) {
  writeFileSync(
    join(pluginDir, "mirror", `${conv}.md`),
    `---\nconv: ${conv}\nlisting: ${listing}\ncounterpart: X\nstate: open\nsynthetic: false\n---\n# X\n`,
  );
}
function writeBuyConv(pluginDir: string, conv: string, listing: string) {
  writeFileSync(
    join(pluginDir, "mirror", `${conv}.md`),
    `---\nconv: ${conv}\nside: buying\nlisting: ${listing}\ncounterpart: X\nstate: open\nsynthetic: false\n---\n# X\n`,
  );
}
function writeFactSheet(pluginDir: string, listing: string) {
  writeFileSync(join(pluginDir, "listings", `${listing}.yaml`), `listing: ${listing}\nmodel: X\n`);
}
function stampSync(pluginDir: string, iso: string) {
  writeFileSync(join(pluginDir, "mirror", ".last-sync"), iso + "\n");
}
function run(pluginDir: string) {
  const proc = Bun.spawnSync(["bun", join(pluginDir, "check.ts")]);
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

test("sound: fresh mirror, every listing has a fact sheet -> exit 0", () => {
  const { pluginDir } = makeRepo();
  writeConv(pluginDir, "erik", "9000000001");
  writeFactSheet(pluginDir, "9000000001");
  stampSync(pluginDir, new Date().toISOString());
  const r = run(pluginDir);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("sound.");
});

test("flags missing endpoints.json as a NOTE, still exit 0 (offline is legit)", () => {
  const { pluginDir } = makeRepo();
  writeConv(pluginDir, "erik", "9000000001");
  writeFactSheet(pluginDir, "9000000001");
  stampSync(pluginDir, new Date().toISOString());
  const r = run(pluginDir);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("endpoints.json");
});

test("stale mirror (>2h) -> exit 1", () => {
  const { pluginDir } = makeRepo();
  writeConv(pluginDir, "erik", "9000000001");
  writeFactSheet(pluginDir, "9000000001");
  stampSync(pluginDir, new Date(Date.now() - 3 * 3_600_000).toISOString());
  const r = run(pluginDir);
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("stale");
});

test("future .last-sync stamp -> corrupt, exit 1", () => {
  const { pluginDir } = makeRepo();
  writeConv(pluginDir, "erik", "9000000001");
  writeFactSheet(pluginDir, "9000000001");
  stampSync(pluginDir, new Date(Date.now() + 3 * 3_600_000).toISOString());
  const r = run(pluginDir);
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("future");
});

test("orphan listing ref (SELLING conversation about a listing with no fact sheet) -> exit 1", () => {
  const { pluginDir } = makeRepo();
  writeConv(pluginDir, "erik", "9999999999"); // no fact sheet for this listing
  stampSync(pluginDir, new Date().toISOString());
  const r = run(pluginDir);
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout).toContain("no fact sheet");
});

test("a BUYING conversation needs no fact sheet — no orphan, exit 0", () => {
  const { pluginDir } = makeRepo();
  writeBuyConv(pluginDir, "rtx-seller", "9999999999"); // buying side: a fact sheet is a sell-side concern
  stampSync(pluginDir, new Date().toISOString());
  const r = run(pluginDir);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("sound.");
});
