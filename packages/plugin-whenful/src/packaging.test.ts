import { test, expect } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Real task mirrors and staged vault notes land in mirror/ and proposed/ when `sync` runs in a
// dev clone, and links.tsv fills with real task↔note rows. None of it may ever reach an npm tarball:
// package.json `files` ships only the .gitkeep placeholders + the links.example.tsv template, and
// .npmignore guards against that list ever being loosened. These tests pin both layers, packing a
// copy of the package with planted "real" data so nothing in the repo is touched.
const pkgDir = join(fileURLToPath(import.meta.url), "..", "..");

test("package.json files[] ships only the placeholders/template, never the live data files", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  expect(pkg.files).toContain("mirror/.gitkeep");
  expect(pkg.files).toContain("proposed/.gitkeep");
  expect(pkg.files).toContain("links.example.tsv");
  // The bare dirs would pack whatever real state a dev-clone sync left in them, and the live join
  // table carries the user's real task↔note rows.
  expect(pkg.files).not.toContain("mirror");
  expect(pkg.files).not.toContain("proposed");
  expect(pkg.files).not.toContain("links.tsv");
});

test("npm pack ships the placeholders/template but never planted mirror/proposed/links data", () => {
  const dir = mkdtempSync(join(tmpdir(), "whenful-pack-"));
  copyFileSync(join(pkgDir, "package.json"), join(dir, "package.json"));
  copyFileSync(join(pkgDir, ".npmignore"), join(dir, ".npmignore"));
  copyFileSync(join(pkgDir, "links.example.tsv"), join(dir, "links.example.tsv"));
  for (const d of ["mirror", "proposed"]) {
    mkdirSync(join(dir, d));
    writeFileSync(join(dir, d, ".gitkeep"), "");
  }
  writeFileSync(join(dir, "mirror", "4242.md"), "real task state - must never ship\n");
  writeFileSync(join(dir, "proposed", "note.md"), "staged vault note - must never ship\n");
  writeFileSync(join(dir, "links.tsv"), "4242\tprojects/secret\tstep\n"); // real join rows - must never ship

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
  expect(shipped).toContain("mirror/.gitkeep");
  expect(shipped).toContain("proposed/.gitkeep");
  expect(shipped).toContain("links.example.tsv");
  expect(shipped).not.toContain("mirror/4242.md");
  expect(shipped).not.toContain("proposed/note.md");
  expect(shipped).not.toContain("links.tsv");
});
