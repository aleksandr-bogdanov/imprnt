import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
