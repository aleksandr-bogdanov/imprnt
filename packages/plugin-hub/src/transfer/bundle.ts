import { createHash } from "node:crypto";

/**
 * The content-addressed shape of a transfer: a list of regular files (and, for
 * a delta, deletions) with their bytes, modes, sizes and sha256, in one
 * canonical order, under one aggregate digest.
 *
 * This module is pure. It reads no disk and writes none, so every refusal
 * below happens before a single byte is staged anywhere. It knows nothing of
 * the move's state machine, of any adapter's layout or of a session format: an
 * entry's `class` only says which namespace a path belongs to, and `native` is
 * a name held for a later class whose export this library does not invent.
 *
 * Nothing here is ever logged with contents. A refusal is a `TransferError`
 * whose message is its closed code, and whose `path` is the one path at fault.
 */

export type BundleClass = "session" | "workspace" | "native";
export const BUNDLE_CLASSES: readonly BundleClass[] = ["session", "workspace", "native"];

/** The closed list of reasons this library refuses for. */
export type TransferCode =
  // manifest and entries
  | "manifest-malformed" | "manifest-digest" | "entry-hash" | "entry-missing" | "entry-extra" | "entry-size"
  | "path-invalid" | "path-traversal" | "path-absolute" | "path-reserved" | "path-duplicate" | "path-conflict"
  | "mode-unsupported" | "class-unknown" | "class-unhandled"
  | "limit-files" | "limit-file-bytes" | "limit-total-bytes" | "limit-scan-bytes" | "limits-invalid"
  | "base-required" | "base-mismatch" | "tombstone-without-base" | "tombstone-unknown"
  // the source tree
  | "root-invalid" | "root-too-broad" | "path-missing" | "path-excluded" | "symlink" | "special-file"
  | "unreadable" | "source-changed"
  // staging. `stage-ambiguous` is a stage or discard that stopped with something in the directory this
  // operation cannot show it made: the path is named, nothing is removed on a guess, and nothing is claimed removed.
  // `stage-stale` is a receipt that no longer describes the directory (promoted, replaced, discarded already).
  | "destination-invalid" | "destination-exists" | "destination-foreign" | "stage-verify" | "stage-io"
  | "stage-ambiguous" | "stage-stale" | "operation-invalid"
  // repositories
  | "repo-invalid" | "repo-not-toplevel" | "repo-unsafe-config" | "repo-head-unborn" | "repo-conflict"
  | "repo-operation" | "repo-submodule" | "repo-nested" | "repo-symlink" | "repo-index-flags" | "repo-reserved-path"
  | "repo-index-state" | "repo-withheld" | "snapshot-mismatch"
  | "repo-git-failed" | "repo-git-output" | "repo-revision-invalid" | "repo-revision-missing"
  | "dependency-missing";

export class TransferError extends Error {
  readonly code: TransferCode;
  readonly path?: string;
  constructor(code: TransferCode, path?: string) {
    super(code);
    this.name = "TransferError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/** Every bound is the caller's, stated on each call. This library holds no default of its own. */
export interface BundleLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export function assertLimits(limits: BundleLimits): void {
  for (const key of ["maxFiles", "maxFileBytes", "maxTotalBytes"] as const) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 0) throw new TransferError("limits-invalid");
  }
}

/** One file in a manifest. `mode` holds permission bits only. */
export interface FileManifestEntry { path: string; class: BundleClass; kind: "file"; mode: number; size: number; sha256: string }
/** A path the delta removes from its base. */
export interface DeleteManifestEntry { path: string; class: BundleClass; kind: "delete" }
export type ManifestEntry = FileManifestEntry | DeleteManifestEntry;

/**
 * What a bundle is a delta against: an opaque identity that only the side that
 * produced the base can resolve. A bundle's base is its manifest digest, a
 * repository's is the revision it was read at.
 */
export interface BundleBase { id: string }

export interface BundleManifest {
  version: 1;
  base: BundleBase | null;
  entries: ManifestEntry[];
  files: number;
  deletions: number;
  totalBytes: number;
  /** sha256 over the canonical form of everything above. The bundle's identity. */
  digest: string;
}

/** A manifest with the bytes it names. The bytes are the caller's own buffers, never copied. */
export interface Bundle {
  manifest: BundleManifest;
  contents: ReadonlyMap<string, Uint8Array>;
}

export type EntryInput =
  | { path: string; class: BundleClass; mode: number; bytes: Uint8Array }
  | { path: string; class: BundleClass; deleted: true };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
/** Names no bundle may carry: a repository's own control directory, and the marker staging keeps in its root. */
export const STAGE_MARKER = ".imprnt-transfer.json";
export const STAGE_MARKER_TMP = `${STAGE_MARKER}.tmp`;
const RESERVED_SEGMENTS = new Set([".git"]);

/** Whether a path is one this library can carry, or the named reason it is not. The path is never normalised for the caller. */
export function pathProblem(path: unknown): TransferCode | null {
  if (typeof path !== "string" || path === "") return "path-invalid";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "path-absolute";
  // A NUL or any other control character, a backslash, and a name that is not
  // in one normal form all make two spellings of one file, or a file that
  // reads as two on another platform.
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path !== path.normalize("NFC")) return "path-invalid";
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) return "path-invalid";
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "..") return "path-traversal";
    if (part === "" || part === ".") return "path-invalid";
    if (Buffer.byteLength(part) > MAX_SEGMENT_BYTES) return "path-invalid";
    if (RESERVED_SEGMENTS.has(part.toLowerCase())) return "path-reserved";
  }
  // Matched without regard to case, like `.git`: on a case-insensitive disk `.IMPRNT-TRANSFER.JSON` is the marker.
  const folded = path.toLowerCase();
  if (folded === STAGE_MARKER || folded === STAGE_MARKER_TMP) return "path-reserved";
  return null;
}

export function assertPath(path: unknown): asserts path is string {
  const problem = pathProblem(path);
  if (problem) throw new TransferError(problem, typeof path === "string" ? path : undefined);
}

/** The key two paths collide on: the same file on a case-insensitive disk is the same path. */
function foldKey(path: string): string { return path.toLowerCase(); }

/** UTF-8 byte order, the same on every machine and in every locale. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function classRank(one: BundleClass): number { return BUNDLE_CLASSES.indexOf(one); }

function compareEntries(a: ManifestEntry, b: ManifestEntry): number {
  return classRank(a.class) - classRank(b.class) || comparePaths(a.path, b.path);
}

function assertMode(mode: unknown, path: string): asserts mode is number {
  // Permission bits only: a set-id or sticky bit does not cross, and an entry
  // its owner cannot read could not be read back to be verified.
  if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777 || ((mode as number) & 0o400) === 0) {
    throw new TransferError("mode-unsupported", path);
  }
}

/**
 * Two entries of one class may not share a path, nor fold to the same path on a
 * case-insensitive disk, and one may not sit beneath another: a file cannot
 * also be a directory. Entries are in canonical order on the way in.
 */
function assertUnambiguous(entries: ManifestEntry[]): void {
  assertDistinct(entries.map(one => ({ scope: one.class, path: one.path })));
}

/** The same check for paths that share one tree, which is what staging writes: `scope` is the namespace they must be distinct in. */
export function assertDistinct(items: { scope: string; path: string }[]): void {
  const seen = new Set<string>();
  for (const one of items) {
    const key = `${one.scope}\0${foldKey(one.path)}`;
    if (seen.has(key)) throw new TransferError("path-duplicate", one.path);
    seen.add(key);
  }
  for (const one of items) {
    const parts = one.path.split("/");
    for (let n = 1; n < parts.length; n++) {
      if (seen.has(`${one.scope}\0${foldKey(parts.slice(0, n).join("/"))}`)) throw new TransferError("path-conflict", one.path);
    }
  }
}

/** The text a digest is taken over. Every object is built key by key, so its order never depends on how it was made. */
function canonical(manifest: Omit<BundleManifest, "digest">): string {
  return JSON.stringify({
    version: manifest.version,
    base: manifest.base === null ? null : { id: manifest.base.id },
    files: manifest.files,
    deletions: manifest.deletions,
    totalBytes: manifest.totalBytes,
    entries: manifest.entries.map(one => one.kind === "file"
      ? { path: one.path, class: one.class, kind: one.kind, mode: one.mode, size: one.size, sha256: one.sha256 }
      : { path: one.path, class: one.class, kind: one.kind }),
  });
}

function seal(parts: Omit<BundleManifest, "digest">): BundleManifest {
  return { ...parts, digest: sha256Hex(Buffer.from(canonical(parts))) };
}

/** The bounds and the shape every entry list must meet, checked the same on the way out and the way in. */
function assemble(entries: ManifestEntry[], base: BundleBase | null, limits: BundleLimits): BundleManifest {
  assertLimits(limits);
  entries.sort(compareEntries);
  assertUnambiguous(entries);
  let files = 0, deletions = 0, totalBytes = 0;
  for (const one of entries) {
    if (one.kind === "delete") {
      // A full snapshot has nothing to delete from: a tombstone is only ever
      // a statement about a base.
      if (base === null) throw new TransferError("tombstone-without-base", one.path);
      deletions++;
      continue;
    }
    if (one.size > limits.maxFileBytes) throw new TransferError("limit-file-bytes", one.path);
    files++;
    totalBytes += one.size;
    if (totalBytes > limits.maxTotalBytes) throw new TransferError("limit-total-bytes", one.path);
  }
  if (files + deletions > limits.maxFiles) throw new TransferError("limit-files");
  return seal({ version: 1, base, entries, files, deletions, totalBytes });
}

/**
 * Build a bundle from what a capture found. Each entry is checked, hashed and
 * put in canonical order. The bytes are kept by reference, so a bounded
 * transfer holds each file once.
 *
 * `basePaths`, when the base is a bundle the caller holds, is the set of paths
 * its files carry per class: a tombstone for a path the base never had is
 * refused, since it would claim a deletion that removes nothing.
 */
export function buildBundle(inputs: EntryInput[], limits: BundleLimits,
  options: { base?: BundleBase; basePaths?: ReadonlyMap<BundleClass, ReadonlySet<string>> } = {}): Bundle {
  const entries: ManifestEntry[] = [];
  const contents = new Map<string, Uint8Array>();
  for (const input of inputs) {
    assertPath(input.path);
    if (!BUNDLE_CLASSES.includes(input.class)) throw new TransferError("class-unknown", input.path);
    if ("deleted" in input) {
      if (options.basePaths && !options.basePaths.get(input.class)?.has(input.path)) throw new TransferError("tombstone-unknown", input.path);
      entries.push({ path: input.path, class: input.class, kind: "delete" });
      continue;
    }
    assertMode(input.mode, input.path);
    if (!(input.bytes instanceof Uint8Array)) throw new TransferError("manifest-malformed", input.path);
    if (input.bytes.length > limits.maxFileBytes) throw new TransferError("limit-file-bytes", input.path);
    entries.push({ path: input.path, class: input.class, kind: "file", mode: input.mode, size: input.bytes.length, sha256: sha256Hex(input.bytes) });
    contents.set(contentKey(input.class, input.path), input.bytes);
  }
  const manifest = assemble(entries, options.base ?? null, limits);
  return { manifest, contents };
}

/** The key a file's bytes are held under: class and path, so the same path in two classes stays two files. */
export function contentKey(cls: BundleClass, path: string): string { return `${cls}\0${path}`; }

const MANIFEST_KEYS = ["version", "base", "entries", "files", "deletions", "totalBytes", "digest"];
const FILE_KEYS = ["path", "class", "kind", "mode", "size", "sha256"];
const DELETE_KEYS = ["path", "class", "kind"];

/** Whether an object has exactly these own keys, no more and no fewer. */
export function exactKeys(value: object, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => own.includes(key));
}

/**
 * A manifest from untrusted data, or a named refusal. The shape is checked
 * key for key (an unknown key refuses), every entry goes through the same path,
 * mode, ambiguity and bound checks a build does, and the digest is recomputed
 * and must match the one the data claims. Nothing has been written when this
 * returns or throws.
 */
export function parseManifest(data: unknown, limits: BundleLimits): BundleManifest {
  assertLimits(limits);
  if (typeof data !== "object" || data === null || Array.isArray(data) || !exactKeys(data, MANIFEST_KEYS)) throw new TransferError("manifest-malformed");
  const raw = data as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.entries) || typeof raw.digest !== "string" || !/^[0-9a-f]{64}$/.test(raw.digest)) {
    throw new TransferError("manifest-malformed");
  }
  let base: BundleBase | null = null;
  if (raw.base !== null) {
    const held = raw.base as Record<string, unknown> | undefined;
    if (typeof held !== "object" || Array.isArray(held) || !exactKeys(held, ["id"]) || typeof held.id !== "string" || held.id === "") {
      throw new TransferError("manifest-malformed");
    }
    base = { id: held.id };
  }
  const entries: ManifestEntry[] = [];
  for (const item of raw.entries) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TransferError("manifest-malformed");
    const one = item as Record<string, unknown>;
    assertPath(one.path);
    if (typeof one.class !== "string" || !BUNDLE_CLASSES.includes(one.class as BundleClass)) throw new TransferError("class-unknown", one.path);
    if (one.kind === "delete" && exactKeys(one, DELETE_KEYS)) {
      entries.push({ path: one.path, class: one.class as BundleClass, kind: "delete" });
    } else if (one.kind === "file" && exactKeys(one, FILE_KEYS)) {
      assertMode(one.mode, one.path);
      if (!Number.isSafeInteger(one.size) || (one.size as number) < 0 || typeof one.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(one.sha256)) {
        throw new TransferError("manifest-malformed", one.path);
      }
      entries.push({ path: one.path, class: one.class as BundleClass, kind: "file", mode: one.mode, size: one.size as number, sha256: one.sha256 });
    } else throw new TransferError("manifest-malformed", one.path);
  }
  const manifest = assemble(entries, base, limits);
  // The claimed totals and order are the recomputed ones or the data is not
  // what it says it is. A manifest re-ordered by hand changes nothing here but
  // its digest, so the claimed order has to be the canonical one too.
  if (manifest.digest !== raw.digest || manifest.files !== raw.files || manifest.deletions !== raw.deletions ||
      manifest.totalBytes !== raw.totalBytes) throw new TransferError("manifest-digest");
  const claimed = raw.entries as Record<string, unknown>[];
  if (claimed.some((one, n) => one.path !== manifest.entries[n].path || one.class !== manifest.entries[n].class)) throw new TransferError("manifest-digest");
  return manifest;
}

/**
 * The bytes against the manifest, every entry: each named file is present at
 * its size and hash, and nothing is held that the manifest does not name.
 * Called before any staging, and by staging again on what it read back.
 */
export function verifyBundle(bundle: Bundle, limits: BundleLimits): void {
  const manifest = parseManifest(JSON.parse(JSON.stringify(bundle.manifest)), limits);
  if (manifest.digest !== bundle.manifest.digest) throw new TransferError("manifest-digest");
  const wanted = new Set<string>();
  for (const one of manifest.entries) {
    if (one.kind === "delete") continue;
    const key = contentKey(one.class, one.path);
    wanted.add(key);
    const bytes = bundle.contents.get(key);
    if (bytes === undefined) throw new TransferError("entry-missing", one.path);
    if (bytes.length !== one.size) throw new TransferError("entry-size", one.path);
    if (sha256Hex(bytes) !== one.sha256) throw new TransferError("entry-hash", one.path);
  }
  for (const key of bundle.contents.keys()) if (!wanted.has(key)) throw new TransferError("entry-extra", key.split("\0")[1]);
}

/** The paths of the files a manifest carries, per class: what a delta built on it may delete from. */
export function pathsOf(manifest: BundleManifest): Map<BundleClass, Set<string>> {
  const out = new Map<BundleClass, Set<string>>();
  for (const one of manifest.entries) {
    if (one.kind !== "file") continue;
    if (!out.has(one.class)) out.set(one.class, new Set());
    out.get(one.class)!.add(one.path);
  }
  return out;
}

/**
 * The delta that takes `base` to `current`, for the paths in `scope`: what is
 * new or changed is carried, what `base` had in scope and `current` lacks
 * becomes a tombstone, and what is identical is left out, since the base
 * already holds it and staging checks it against the base's digest.
 *
 * `scope` says which base paths the capture could have seen, so a path outside
 * it is never read as deleted: a capture of one directory is silent about the
 * rest of the base.
 */
export function deltaAgainst(base: Pick<Bundle, "manifest">, current: EntryInput[], inScope: (cls: BundleClass, path: string) => boolean,
  limits: BundleLimits): Bundle {
  const held = new Map<string, FileManifestEntry>();
  for (const one of base.manifest.entries) if (one.kind === "file") held.set(contentKey(one.class, one.path), one);
  const out: EntryInput[] = [];
  const present = new Set<string>();
  for (const input of current) {
    if ("deleted" in input) continue;
    const key = contentKey(input.class, input.path);
    present.add(key);
    const before = held.get(key);
    if (before && before.mode === input.mode && before.size === input.bytes.length && before.sha256 === sha256Hex(input.bytes)) continue;
    out.push(input);
  }
  for (const [key, one] of held) if (!present.has(key) && inScope(one.class, one.path)) out.push({ path: one.path, class: one.class, deleted: true });
  return buildBundle(out, limits, { base: { id: base.manifest.digest }, basePaths: pathsOf(base.manifest) });
}
