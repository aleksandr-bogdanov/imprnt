import { test, expect } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Staged vault notes land in proposed/ when the CLI runs in a dev clone, and they are real personal
// finance data. None of it may ever reach an npm tarball: package.json `files` ships only the
// .gitkeep placeholder, and .npmignore guards against that list ever being loosened. These tests pin
// both layers, packing a copy of the package with a planted "real" note so nothing in the repo is
// touched (the packaging-test pattern the plugin packages share).
const pkgDir = join(fileURLToPath(import.meta.url), "..", "..");

test("package.json files[] ships only the .gitkeep placeholder for proposed/", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  expect(pkg.files).toContain("proposed/.gitkeep");
  // The bare dir would pack whatever real staged notes a dev clone holds.
  expect(pkg.files).not.toContain("proposed");
});

test("npm pack ships the .gitkeep placeholder but never planted proposed data", () => {
  const dir = mkdtempSync(join(tmpdir(), "kopeika-pack-"));
  copyFileSync(join(pkgDir, "package.json"), join(dir, "package.json"));
  copyFileSync(join(pkgDir, ".npmignore"), join(dir, ".npmignore"));
  mkdirSync(join(dir, "proposed"));
  writeFileSync(join(dir, "proposed", ".gitkeep"), "");
  writeFileSync(join(dir, "proposed", "note.md"), "staged vault note with real balances - must never ship\n");

  // --ignore-scripts skips prepack (the copy has no src/ to build); --json lists the tarball.
  const proc = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      npm_config_cache: join(dir, ".npm-cache"),
    },
  });
  expect(proc.exitCode).toBe(0);
  const [report] = JSON.parse(proc.stdout.toString());
  const shipped = report.files.map((f: { path: string }) => f.path);
  expect(shipped).toContain("proposed/.gitkeep");
  expect(shipped).not.toContain("proposed/note.md");
});
