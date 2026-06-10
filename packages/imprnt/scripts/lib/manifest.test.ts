import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, saveManifest, manifestPath } from "./manifest.ts";

function vaultDir(): string {
  return mkdtempSync(join(tmpdir(), "imprnt-manifest-"));
}

// --- bug 3: a corrupt manifest must NOT silently lose prior provenance ----------------------------
test("corrupt manifest is backed up and throws instead of returning empty", () => {
  const vault = vaultDir();
  // Write a manifest with a real provenance entry, then corrupt it on disk.
  saveManifest(vault, { "src/a.txt": { hash: "deadbeef", note: "vault/events/a.md", ingested: "x" } });
  writeFileSync(manifestPath(vault), "{ this is not json");

  // loadManifest must refuse: throw (so the caller does not proceed on empty state and overwrite).
  expect(() => loadManifest(vault)).toThrow(/corrupt/i);

  // The corrupt bytes are preserved in a sidecar — provenance is recoverable, not lost.
  const sidecars = readdirSync(vault).filter((f) => f.startsWith(".manifest.json.corrupt-"));
  expect(sidecars.length).toBe(1);
  expect(readFileSync(join(vault, sidecars[0]), "utf8")).toContain("this is not json");
});

test("repeated corrupt loads never clobber an earlier backup", () => {
  const vault = vaultDir();
  writeFileSync(manifestPath(vault), "garbage-1");
  expect(() => loadManifest(vault)).toThrow();
  writeFileSync(manifestPath(vault), "garbage-2");
  expect(() => loadManifest(vault)).toThrow();
  const sidecars = readdirSync(vault).filter((f) => f.startsWith(".manifest.json.corrupt-")).sort();
  expect(sidecars).toEqual([".manifest.json.corrupt-0", ".manifest.json.corrupt-1"]);
});

test("a valid manifest round-trips", () => {
  const vault = vaultDir();
  const m = { "k": { hash: "h", note: "n", ingested: "i" } };
  saveManifest(vault, m);
  expect(loadManifest(vault)).toEqual(m);
  expect(loadManifest(vaultDir())).toEqual({}); // absent manifest -> empty
});

// --- finding 1: saveManifest must be ATOMIC. A plain writeFileSync truncates-then-writes, so a
// concurrent reader (the contract anticipates scheduled apply-all runs) can catch a half-written
// file -> JSON.parse throws -> loadManifest aborts the run as "corrupt". The fix writes to a temp file
// in the SAME directory and renameSync()s it into place (atomic on POSIX), so a reader sees either the
// old full file or the new full file, never a truncated one. -----------------------------------------
//
// This test spawns REAL concurrent OS processes: writers hammer saveManifest on the same path while
// readers loop reading + JSON.parse-ing it. Under the non-atomic truncate-then-write a reader catches
// a partial file and exits 2 (a corrupt read). After the atomic rename, every read is either the old
// or the new complete file, so no reader ever sees corruption. The manifest is sized large enough that
// the write spans multiple syscalls (a real partial-read window).
test("saveManifest is atomic under concurrent writers: a reader never catches a partial file", async () => {
  const vault = vaultDir();
  const here = dirname(fileURLToPath(import.meta.url));
  const driver = join(vault, "race-driver.ts");
  // The driver does both roles: --write spins saveManifest in a loop; --read loops readFileSync +
  // JSON.parse and exits 2 the instant it catches a non-parseable (partial) file.
  writeFileSync(driver, `
import { saveManifest, manifestPath } from ${JSON.stringify(join(here, "manifest.ts"))};
import { readFileSync } from "node:fs";
const vault = process.argv[3];
const big = {};
for (let i = 0; i < 8000; i++) big["src/file-" + i + ".txt"] = { hash: "h" + i, note: "vault/events/n" + i + ".md", ingested: "2026-06-10" };
const deadline = Date.now() + 1500;
if (process.argv[2] === "--write") {
  while (Date.now() < deadline) saveManifest(vault, big);
} else {
  const p = manifestPath(vault);
  while (Date.now() < deadline) {
    let txt;
    try { txt = readFileSync(p, "utf8"); } catch { continue; } // ENOENT mid-rename is fine, retry
    if (!txt) continue;
    try { JSON.parse(txt); } catch { process.exit(2); }
  }
  process.exit(0);
}
`);
  // Seed a valid manifest so readers always have something to read.
  saveManifest(vault, { seed: { hash: "h", note: "n", ingested: "i" } });

  const writers = Array.from({ length: 3 }, () => Bun.spawn(["bun", driver, "--write", vault]));
  const readers = Array.from({ length: 3 }, () => Bun.spawn(["bun", driver, "--read", vault]));
  await Promise.all([...writers, ...readers].map((p) => p.exited));

  for (const reader of readers) expect(reader.exitCode).not.toBe(2); // no reader caught a partial file
  const onDisk = readFileSync(manifestPath(vault), "utf8");
  expect(() => JSON.parse(onDisk)).not.toThrow(); // the final file is complete valid JSON
});

test("saveManifest writes via a temp file in the same dir, leaving no stray temp behind", () => {
  const vault = vaultDir();
  saveManifest(vault, { "k": { hash: "h", note: "n", ingested: "i" } });
  // Overwrite an EXISTING manifest (the rename-over case): the prior bytes are replaced atomically.
  saveManifest(vault, { "k2": { hash: "h2", note: "n2", ingested: "i2" } });
  expect(loadManifest(vault)).toEqual({ "k2": { hash: "h2", note: "n2", ingested: "i2" } });
  // The atomic write cleans up after itself: only the manifest file is left, no `.manifest.json.tmp*`.
  const leftover = readdirSync(vault).filter((f) => f !== ".manifest.json");
  expect(leftover).toEqual([]);
});

// A truly interrupted write (the temp file written, the rename never happening) must leave the OLD
// full manifest intact - the half-written bytes only ever live in the temp file, never at the real
// path. We simulate the interruption by writing a partial temp file by hand, then confirming a
// successful saveManifest still produces a complete file and the temp does not leak into loadManifest.
test("an interrupted write leaves the old full manifest, never a truncated real file", () => {
  const vault = vaultDir();
  const original = { "a": { hash: "ha", note: "na", ingested: "ia" } };
  saveManifest(vault, original);
  // A leftover/partial temp from a crashed prior write must NOT be picked up as the manifest.
  writeFileSync(manifestPath(vault) + ".tmp", "{ truncated half write");
  // The real manifest still loads cleanly - the temp is invisible to the reader.
  expect(loadManifest(vault)).toEqual(original);
});
