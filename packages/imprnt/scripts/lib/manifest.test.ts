import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
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
// readers loop reading the file and checking it is COMPLETE. Under the non-atomic truncate-then-write
// the file passes through O_TRUNC (a 0-byte window) and grows across multiple write syscalls, so a
// reader catches a 0-byte / short / non-parseable file and exits 2. After the atomic rename, every
// read is either the old or the new full file (both complete), so no reader ever exits 2.
//
// Reliability over the old version: (a) the reader treats a SHORT or EMPTY read as a torn-file hit,
// not just a JSON parse error - O_TRUNC's 0-byte window is the easiest moment to catch and the old
// `if (!txt) continue` was silently skipping exactly it; (b) the writer alternates between two FULL
// manifests of different length, so every write truncates a longer file to a shorter one (a guaranteed
// short-read window) regardless of syscall granularity; (c) more writers/readers + a larger manifest
// widen the window so a plain writeFileSync is caught on essentially every run.
test("saveManifest is atomic under concurrent writers: a reader never catches a partial file", async () => {
  const vault = vaultDir();
  const here = dirname(fileURLToPath(import.meta.url));
  const driver = join(vault, "race-driver.ts");
  // The driver does both roles. --write alternates two full manifests of different size. --read loops
  // readFileSync and exits 2 the instant it catches an empty, short, or non-parseable (torn) file.
  writeFileSync(driver, `
import { saveManifest, manifestPath } from ${JSON.stringify(join(here, "manifest.ts"))};
import { readFileSync } from "node:fs";
const vault = process.argv[3];
function mk(n) {
  const m = {};
  for (let i = 0; i < n; i++) m["src/file-" + i + ".txt"] = { hash: "h" + i, note: "vault/events/n" + i + ".md", ingested: "2026-06-10" };
  return m;
}
const big = mk(20000);          // ~2.4 MB serialized: the write spans many syscalls
const small = mk(12000);        // a shorter FULL manifest: truncating big -> small always leaves a short-read window
const lenBig = JSON.stringify(big, null, 2).length + 1;     // +1 for the trailing newline saveManifest adds
const lenSmall = JSON.stringify(small, null, 2).length + 1;
const minLen = Math.min(lenBig, lenSmall);
const deadline = Date.now() + 1500;
if (process.argv[2] === "--seed") {
  saveManifest(vault, small); // the smallest FULL manifest the racers will ever write, so a complete read is never < minLen
} else if (process.argv[2] === "--write") {
  let flip = false;
  while (Date.now() < deadline) { saveManifest(vault, (flip = !flip) ? big : small); }
} else {
  const p = manifestPath(vault);
  while (Date.now() < deadline) {
    let txt;
    try { txt = readFileSync(p, "utf8"); } catch { continue; } // ENOENT mid-rename is fine, retry
    // A complete file is always one of the two FULL manifests, so its length is >= the shorter full
    // length. An empty or short read is a torn file the atomic rename can never expose.
    if (txt.length < minLen) process.exit(2);
    try { JSON.parse(txt); } catch { process.exit(2); }
  }
  process.exit(0);
}
`);
  // Seed a FULL manifest (the smaller of the two the racers write) so a legitimate read is never
  // shorter than minLen - only a torn write can produce a sub-minLen file.
  await Bun.spawn(["bun", driver, "--seed", vault]).exited;

  const writers = Array.from({ length: 4 }, () => Bun.spawn(["bun", driver, "--write", vault]));
  const readers = Array.from({ length: 4 }, () => Bun.spawn(["bun", driver, "--read", vault]));
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

// The atomic write replaces the manifest by renaming a fresh temp file INTO its directory, never by
// truncating the target in place. That difference is observable deterministically: when the target
// itself is read-only but its directory is writable, the rename-over succeeds (rename needs dir
// write, not file write) while a plain writeFileSync to the read-only path fails with EACCES. A test
// that survives a non-atomic writeFileSync would be vacuous, so this asserts the property only the
// temp+rename satisfies: a read-only manifest is still replaced, in full, with the new content.
test("saveManifest replaces a read-only manifest by rename, not by truncating it in place", () => {
  const vault = vaultDir();
  const original = { "a": { hash: "ha", note: "na", ingested: "ia" } };
  saveManifest(vault, original);
  // Make the existing manifest read-only; the vault dir stays writable so a rename-over can land.
  chmodSync(manifestPath(vault), 0o444);
  const updated = { "b": { hash: "hb", note: "nb", ingested: "ib" } };
  // A plain in-place writeFileSync would throw EACCES here. The temp+rename write succeeds.
  saveManifest(vault, updated);
  expect(loadManifest(vault)).toEqual(updated); // the new content fully replaced the old, no truncation
  // And it cleaned up after itself - no stray temp survived the rename.
  const leftover = readdirSync(vault).filter((f) => f !== ".manifest.json");
  expect(leftover).toEqual([]);
});
