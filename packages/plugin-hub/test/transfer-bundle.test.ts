// The transfer bundle is pure: entries in, a canonical manifest and one digest
// out, and every refusal made before anything could be written. These tests
// hold the shape a later stage can rely on, not the constants it is made of.

import { expect, test } from "bun:test";
import {
  buildBundle, contentKey, deltaAgainst, parseManifest, sha256Hex, TransferError, verifyBundle,
  type Bundle, type BundleClass, type BundleLimits, type EntryInput,
} from "../src/transfer/bundle.ts";

const L: BundleLimits = { maxFiles: 10, maxFileBytes: 64, maxTotalBytes: 256 };
const file = (path: string, text: string, extra: Partial<{ class: "session" | "workspace" | "native"; mode: number }> = {}): EntryInput =>
  ({ path, class: extra.class ?? "workspace", mode: extra.mode ?? 0o644, bytes: Buffer.from(text) });

/** The code a refusal carries, or "none" when the call went through. */
function refusal(run: () => unknown): string {
  try { run(); } catch (error) {
    if (error instanceof TransferError) return error.code;
    throw error;
  }
  return "none";
}

/** A manifest as data off a wire: plain JSON, free to be edited. */
const wire = (bundle: Bundle): any => JSON.parse(JSON.stringify(bundle.manifest));

test("the same entries make the same manifest and digest in any order, in byte order of path", () => {
  const a = buildBundle([file("é.txt", "3"), file("B.txt", "1"), file("a.txt", "2")], L);
  const b = buildBundle([file("a.txt", "2"), file("é.txt", "3"), file("B.txt", "1")], L);
  expect(a.manifest).toEqual(b.manifest);
  expect(a.manifest.entries.map(one => one.path)).toEqual(["B.txt", "a.txt", "é.txt"]);
  // Anything an entry says moves the digest: bytes, mode, class, and the base.
  const changed = [
    buildBundle([file("é.txt", "3"), file("B.txt", "1"), file("a.txt", "X")], L),
    buildBundle([file("é.txt", "3"), file("B.txt", "1"), file("a.txt", "2", { mode: 0o755 })], L),
    buildBundle([file("é.txt", "3"), file("B.txt", "1"), file("a.txt", "2", { class: "session" })], L),
  ];
  for (const other of changed) expect(other.manifest.digest).not.toBe(a.manifest.digest);
  expect(new Set(changed.map(one => one.manifest.digest)).size).toBe(3);
});

test("a bundle holds each file's bytes once, by reference", () => {
  const bytes = Buffer.from("held once");
  const bundle = buildBundle([{ path: "one.txt", class: "workspace", mode: 0o644, bytes }], L);
  expect(bundle.contents.get(contentKey("workspace", "one.txt"))).toBe(bytes);
  expect(bundle.manifest.entries[0]).toMatchObject({ size: bytes.length, sha256: sha256Hex(bytes) });
});

test("a path that could leave the tree or be read two ways is refused by name", () => {
  const cases: [string, string][] = [
    ["../x", "path-traversal"], ["a/../b", "path-traversal"], ["/etc/passwd", "path-absolute"], ["C:/x", "path-absolute"],
    ["a//b", "path-invalid"], ["./a", "path-invalid"], ["a/", "path-invalid"], ["", "path-invalid"], ["a\\b", "path-invalid"],
    ["a\0b", "path-invalid"], ["e\u0301.txt", "path-invalid"],
    [".git/hooks/pre-commit", "path-reserved"], ["x/.GIT/config", "path-reserved"], [".imprnt-transfer.json", "path-reserved"],
    [".IMPRNT-Transfer.json.tmp", "path-reserved"],
    // The root walk `.` is a capture's own spelling, never a path a manifest may name.
    [".", "path-invalid"],
  ];
  for (const [path, code] of cases) expect(refusal(() => buildBundle([file(path, "x")], L)), JSON.stringify(path)).toBe(code);
});

test("duplicates, case-folded twins and a file that is also a directory are refused, while two classes may share a path", () => {
  expect(refusal(() => buildBundle([file("a.txt", "1"), file("a.txt", "2")], L))).toBe("path-duplicate");
  expect(refusal(() => buildBundle([file("a.txt", "1"), file("A.TXT", "2")], L))).toBe("path-duplicate");
  expect(refusal(() => buildBundle([file("a", "1"), file("a/b", "2")], L))).toBe("path-conflict");
  const both = buildBundle([file("a.txt", "1"), file("a.txt", "2", { class: "session" })], L);
  expect(both.manifest.entries.map(one => one.class)).toEqual(["session", "workspace"]);
});

test("a mode that is not plain permission bits, or that its owner could not read back, is refused", () => {
  for (const mode of [0o4755, 0o1777, 0o000, 0o200, -1, 1.5, 0o1000]) {
    expect(refusal(() => buildBundle([file("a", "x", { mode })], L)), String(mode)).toBe("mode-unsupported");
  }
  expect(refusal(() => buildBundle([file("a", "x", { mode: 0o755 }), file("b", "x", { mode: 0o400 })], L))).toBe("none");
});

test("the bounds are the caller's, are enforced as named refusals, and a refusal never carries contents", () => {
  expect(refusal(() => buildBundle([file("a", "x".repeat(65))], L))).toBe("limit-file-bytes");
  expect(refusal(() => buildBundle([1, 2, 3, 4, 5].map(n => file(`f${n}`, "y".repeat(60))), L))).toBe("limit-total-bytes");
  expect(refusal(() => buildBundle([1, 2, 3].map(n => file(`f${n}`, "z")), { ...L, maxFiles: 2 }))).toBe("limit-files");
  for (const bad of [{ ...L, maxFiles: -1 }, { ...L, maxFileBytes: Number.NaN }, { ...L, maxTotalBytes: 1.5 }]) {
    expect(refusal(() => buildBundle([file("a", "x")], bad))).toBe("limits-invalid");
  }
  try { buildBundle([file("a", "TOPSECRET".repeat(20))], L); } catch (error) {
    expect(String((error as Error).message) + JSON.stringify(error)).not.toContain("TOPSECRET");
  }
});

test("a deletion is a statement about a base, and is refused without one or about a path the base never had", () => {
  const gone: EntryInput = { path: "old.txt", class: "workspace", deleted: true };
  expect(refusal(() => buildBundle([gone], L))).toBe("tombstone-without-base");
  const known = new Map<BundleClass, Set<string>>([["workspace", new Set(["old.txt"])]]);
  expect(refusal(() => buildBundle([gone], L, { base: { id: "b1" }, basePaths: new Map() }))).toBe("tombstone-unknown");
  const delta = buildBundle([gone], L, { base: { id: "b1" }, basePaths: known });
  expect(delta.manifest).toMatchObject({ files: 0, deletions: 1, base: { id: "b1" } });
  expect(buildBundle([gone], L, { base: { id: "b2" }, basePaths: known }).manifest.digest).not.toBe(delta.manifest.digest);
});

test("a manifest read back from its text is the same manifest", () => {
  const bundle = buildBundle([file("a.txt", "1"), file("dir/b.txt", "22", { mode: 0o755 })], L);
  expect(parseManifest(wire(bundle), L)).toEqual(bundle.manifest);
  const delta = buildBundle([{ path: "x", class: "workspace", deleted: true }], L, { base: { id: "b" }, basePaths: new Map<BundleClass, Set<string>>([["workspace", new Set(["x"])]]) });
  expect(parseManifest(wire(delta), L)).toEqual(delta.manifest);
});

test("malformed or tampered manifests are refused by name, each one before anything could be staged", () => {
  const bundle = buildBundle([file("a.txt", "1"), file("b.txt", "22")], L);
  const edit = (change: (manifest: any) => void) => { const data = wire(bundle); change(data); return data; };
  const other = "f".repeat(64);
  const cases: [string, unknown, string][] = [
    ["not an object", "manifest", "manifest-malformed"],
    ["null", null, "manifest-malformed"],
    ["an array", [], "manifest-malformed"],
    ["missing key", edit(m => { delete m.totalBytes; }), "manifest-malformed"],
    ["unknown key", edit(m => { m.extra = 1; }), "manifest-malformed"],
    ["other version", edit(m => { m.version = 2; }), "manifest-malformed"],
    ["entries not a list", edit(m => { m.entries = {}; }), "manifest-malformed"],
    ["digest not hex", edit(m => { m.digest = "abc"; }), "manifest-malformed"],
    ["entry with an extra key", edit(m => { m.entries[0].note = "x"; }), "manifest-malformed"],
    ["entry of unknown kind", edit(m => { m.entries[0].kind = "link"; }), "manifest-malformed"],
    ["bad sha256", edit(m => { m.entries[0].sha256 = "zz"; }), "manifest-malformed"],
    ["negative size", edit(m => { m.entries[0].size = -1; }), "manifest-malformed"],
    ["unknown class", edit(m => { m.entries[0].class = "home"; }), "class-unknown"],
    ["traversal smuggled in", edit(m => { m.entries[0].path = "../x"; }), "path-traversal"],
    ["absolute path smuggled in", edit(m => { m.entries[0].path = "/x"; }), "path-absolute"],
    ["set-id mode", edit(m => { m.entries[0].mode = 0o4755; }), "mode-unsupported"],
    ["duplicate path", edit(m => { m.entries[1].path = "a.txt"; }), "path-duplicate"],
    ["a hash that is well formed and wrong", edit(m => { m.entries[0].sha256 = other; }), "manifest-digest"],
    ["totals that lie", edit(m => { m.totalBytes = 1; }), "manifest-digest"],
    ["entries put out of canonical order", edit(m => { m.entries.reverse(); }), "manifest-digest"],
    ["a base added after the digest", edit(m => { m.base = { id: "x" }; }), "manifest-digest"],
  ];
  for (const [name, data, code] of cases) expect(refusal(() => parseManifest(data, L)), name).toBe(code);
  // The limits apply to what a manifest claims, not only to what a build makes.
  expect(refusal(() => parseManifest(wire(bundle), { ...L, maxFiles: 1 }))).toBe("limit-files");
  expect(refusal(() => parseManifest(wire(bundle), { ...L, maxFileBytes: 1 }))).toBe("limit-file-bytes");
});

test("bytes are checked against the manifest entry by entry, and nothing the manifest does not name may come with them", () => {
  const bundle = buildBundle([file("a.txt", "one"), file("b.txt", "two")], L);
  expect(refusal(() => verifyBundle(bundle, L))).toBe("none");
  const with_ = (change: (held: Map<string, Uint8Array>) => void): Bundle => {
    const held = new Map(bundle.contents);
    change(held);
    return { manifest: bundle.manifest, contents: held };
  };
  const a = contentKey("workspace", "a.txt");
  expect(refusal(() => verifyBundle(with_(held => held.set(a, Buffer.from("ONE"))), L))).toBe("entry-hash");
  expect(refusal(() => verifyBundle(with_(held => held.set(a, Buffer.from("on"))), L))).toBe("entry-size");
  expect(refusal(() => verifyBundle(with_(held => held.delete(a)), L))).toBe("entry-missing");
  expect(refusal(() => verifyBundle(with_(held => held.set(contentKey("workspace", "c.txt"), Buffer.from("x"))), L))).toBe("entry-extra");
  const forged = { manifest: { ...bundle.manifest, digest: "0".repeat(64) }, contents: bundle.contents };
  expect(refusal(() => verifyBundle(forged, L))).toBe("manifest-digest");
});

test("a delta carries what changed, tombstones what left its scope, and leaves out what the base already holds", () => {
  const base = buildBundle([file("app/keep.txt", "same"), file("app/edit.txt", "v1"), file("app/drop.txt", "bye"), file("other/far.txt", "x")], L);
  const now = [file("app/keep.txt", "same"), file("app/edit.txt", "v2"), file("app/new.txt", "hi")];
  const delta = deltaAgainst(base, now, (cls, path) => cls === "workspace" && path.startsWith("app/"), L);
  expect(delta.manifest.base).toEqual({ id: base.manifest.digest });
  expect(delta.manifest.entries.map(one => `${one.kind}:${one.path}`)).toEqual(["delete:app/drop.txt", "file:app/edit.txt", "file:app/new.txt"]);
  // `other/far.txt` is absent from the capture and outside its scope: not asked about, so not deleted.
  expect(delta.manifest.deletions).toBe(1);
  expect(verifyBundle(delta, L)).toBeUndefined();
  const unchanged = deltaAgainst(base, [file("app/keep.txt", "same"), file("app/edit.txt", "v1"), file("app/drop.txt", "bye"), file("other/far.txt", "x")], () => true, L);
  expect(unchanged.manifest).toMatchObject({ files: 0, deletions: 0 });
  // A mode change alone is a change.
  const chmod = deltaAgainst(base, [file("app/keep.txt", "same", { mode: 0o755 })], (_c, path) => path === "app/keep.txt", L);
  expect(chmod.manifest.entries.map(one => one.path)).toEqual(["app/keep.txt"]);
});
