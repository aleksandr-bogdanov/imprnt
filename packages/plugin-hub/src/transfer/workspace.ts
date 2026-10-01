import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import {
  assertDistinct, assertLimits, assertPath, buildBundle, comparePaths, contentKey, deltaAgainst, exactKeys, pathProblem, sha256Hex, STAGE_MARKER,
  STAGE_MARKER_TMP, TransferError, verifyBundle, BUNDLE_CLASSES,
  type Bundle, type BundleClass, type BundleLimits, type EntryInput,
} from "./bundle.ts";

/**
 * Capturing one explicitly supplied workspace into a bundle, and staging a
 * bundle into a directory this operation owns.
 *
 * The source is only ever read: nothing is opened for writing, renamed or
 * removed under it. The caller names the root and the files or directories
 * under it, and nothing else is enumerated. No link is followed and no device,
 * socket or pipe is opened. The destination is a directory this call made (or
 * an empty one it was handed), never an existing project tree, and it is
 * written with exclusive creates only, so nothing already there can be
 * overwritten.
 *
 * What a capture does and does not promise. Every read here is finite, so a
 * capture is not an atomic snapshot: a writer can always strike after the last
 * check. What it promises is that a change it can observe is refused, and that
 * the bytes it returns are the bytes it confirmed by a second, independent
 * read of the file. Holding the source still while it runs (the caller's lock
 * or quiescence) and revalidating at the caller's own checkpoint remain the
 * caller's part.
 *
 * Nothing in this file logs, and no refusal carries file contents.
 */

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CHUNK = 64 * 1024;

/** What identifies a file as the same file in the same state, as far as stat can say: a write, a rename over it or a swap moves at least one of these. Stat alone can miss a same-size write on a coarse clock, which is why reads also compare content. */
export interface FileSignature { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }

export function signatureOf(stat: Stats): FileSignature {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

export function sameSignature(a: FileSignature, b: FileSignature): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function errnoOf(error: unknown): string | undefined {
  const named = (error as { code?: unknown } | null)?.code;
  return typeof named === "string" ? named : undefined;
}

function isUnder(path: string, tree: string): boolean { return path === tree || path.startsWith(`${tree}/`); }

/**
 * The one root a transfer reads under, resolved once. A root that is the
 * filesystem root, the account's home or any directory above the home is
 * refused: a home holds every credential the account has, and a root above it
 * with a selected descendant would sweep it all the same. Nothing in this
 * library crawls a home.
 */
export function resolveRoot(root: string): string {
  if (typeof root !== "string" || !isAbsolute(root)) throw new TransferError("root-invalid");
  let real: string;
  try {
    real = realpathSync(root);
    if (!lstatSync(real).isDirectory()) throw new Error("not-a-directory");
  } catch { throw new TransferError("root-invalid"); }
  let home: string | null = null;
  try { home = realpathSync(homedir()); } catch { /* no home to protect */ }
  if (real === parse(real).root || (home !== null && isUnder(home, real))) throw new TransferError("root-too-broad");
  return real;
}

/**
 * The lstat of `rel` under `root`, walking it one part at a time so a link
 * anywhere on the way (a directory that is a link included) is refused and not
 * followed.
 */
export function lstatBelow(root: string, rel: string): Stats {
  assertPath(rel);
  const parts = rel.split("/");
  let at = root;
  let stat: Stats | undefined;
  for (const [n, part] of parts.entries()) {
    at = join(at, part);
    try { stat = lstatSync(at); } catch (error) {
      throw new TransferError(errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR" ? "path-missing" : "unreadable", rel);
    }
    if (stat.isSymbolicLink()) throw new TransferError("symlink", rel);
    if (n < parts.length - 1 && !stat.isDirectory()) throw new TransferError("path-missing", rel);
  }
  return stat!;
}

/**
 * A running count of the bytes a caller lets a whole operation read from
 * regular files, charged before each read from the file's size, so an
 * oversized file is refused without being opened. The caller that passes one
 * owns its policy; a read that would pass `limit` is `limit-scan-bytes`.
 */
export interface ScanBudget { limit: number; used: number }

export function chargeScan(budget: ScanBudget | undefined, bytes: number, rel: string): void {
  if (!budget) return;
  if (bytes > budget.limit - budget.used) throw new TransferError("limit-scan-bytes", rel);
  budget.used += bytes;
}

/** The sha256 of the first `size` bytes of an open file, read in bounded chunks and never held. The file ending early is a truncation under the read. */
function hashFd(fd: number, size: number, rel: string): string {
  const sha = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, size)));
  for (let read = 0; read < size;) {
    const got = readSync(fd, chunk, 0, Math.min(chunk.length, size - read), read);
    if (got === 0) throw new TransferError("source-changed", rel);
    sha.update(chunk.subarray(0, got));
    read += got;
  }
  return sha.digest("hex");
}

function openForRead(root: string, rel: string): number {
  try { return openSync(join(root, rel), constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    throw new TransferError(errnoOf(error) === "ELOOP" ? "symlink" : "unreadable", rel);
  }
}

export interface StableRead {
  signature: FileSignature;
  /** Permission bits. */
  mode: number;
  size: number;
  sha256: string;
  /** The git blob id of the same bytes, when asked for, taken in the same pass. */
  gitOid?: string;
  bytes?: Buffer;
}

/**
 * One regular file read, and only if it stayed the same file in the same state
 * while it was read. The path is lstat-ed, opened without following a link,
 * fstat-ed and read to its recorded size; its bytes are then read a second
 * time, in bounded chunks that are hashed and not held, and must hash the same
 * as the first read; one more byte is probed for; and the file's identity,
 * size and times must be the same before, after and on a second lstat of the
 * path. A file written to, truncated, renamed over or swapped for a link during
 * the read is `source-changed`, never a hash that claims a state the file was
 * not in.
 *
 * The second read is what makes this independent of stat: a same-size write
 * that stat cannot see (a clock too coarse to tell two writes apart, a time
 * put back) still changes what the file hashes to. It is finite, like every
 * read: a write after it returns is not seen here, and a caller that needs the
 * state to hold until a later point confirms it again there (`confirmStable`).
 *
 * `retain` keeps the bytes, in one buffer read straight from the file: the
 * second read is not retained, so no second copy is held. Without it the file
 * is hashed in chunks and nothing is held. With a `scan` budget, a file costs
 * twice its size (both reads), charged before it is opened.
 */
export function readStable(root: string, rel: string,
  options: { retain: boolean; maxBytes?: number; blobFormat?: "sha1" | "sha256"; scan?: ScanBudget; afterRead?: () => void }): StableRead {
  const before = lstatBelow(root, rel);
  if (!before.isFile()) throw new TransferError("special-file", rel);
  if (options.maxBytes !== undefined && before.size > options.maxBytes) throw new TransferError("limit-file-bytes", rel);
  chargeScan(options.scan, 2 * before.size, rel);
  const fd = openForRead(root, rel);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== before.size || !sameSignature(signatureOf(opened), signatureOf(before))) {
      throw new TransferError("source-changed", rel);
    }
    const size = opened.size;
    const sha = createHash("sha256");
    const blob = options.blobFormat ? createHash(options.blobFormat) : null;
    blob?.update(`blob ${size}\0`);
    const whole = options.retain ? Buffer.allocUnsafe(size) : null;
    const chunk = whole ? null : Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, size)));
    let read = 0;
    while (read < size) {
      const into = whole ?? chunk!;
      const want = whole ? size - read : Math.min(chunk!.length, size - read);
      const got = readSync(fd, into, whole ? read : 0, want, read);
      // The file ended before its recorded size: it was truncated under the read.
      if (got === 0) throw new TransferError("source-changed", rel);
      const piece = whole ? whole.subarray(read, read + got) : chunk!.subarray(0, got);
      sha.update(piece);
      blob?.update(piece);
      read += got;
    }
    options.afterRead?.();
    const sha256 = sha.digest("hex");
    if (hashFd(fd, size, rel) !== sha256) throw new TransferError("source-changed", rel);
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, size) > 0) throw new TransferError("source-changed", rel);
    const after = fstatSync(fd);
    const again = lstatBelow(root, rel);
    if (!sameSignature(signatureOf(after), signatureOf(opened)) || !sameSignature(signatureOf(again), signatureOf(opened))) {
      throw new TransferError("source-changed", rel);
    }
    return {
      signature: signatureOf(opened), mode: opened.mode & 0o777, size, sha256,
      ...(blob ? { gitOid: blob.digest("hex") } : {}), ...(whole ? { bytes: whole } : {}),
    };
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError("unreadable", rel);
  } finally { closeSync(fd); }
}

/**
 * The final check of one file read earlier: it is still a regular file reached
 * without a link, with the same identity, size, mode and times, and its bytes,
 * read again in bounded chunks and not held, hash the same. Anything else is
 * `source-changed`. Like `readStable` it is finite: it says the file was as
 * captured when it ran, not that nobody writes afterwards. With a `scan`
 * budget it costs the file's size, charged before it is opened.
 */
export function confirmStable(root: string, rel: string, expected: Pick<StableRead, "signature" | "mode" | "size" | "sha256">,
  options: { scan?: ScanBudget } = {}): void {
  const now = lstatBelow(root, rel);
  if (!now.isFile() || now.size !== expected.size) throw new TransferError("source-changed", rel);
  chargeScan(options.scan, expected.size, rel);
  const fd = openForRead(root, rel);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== expected.size || (opened.mode & 0o777) !== expected.mode ||
        !sameSignature(signatureOf(opened), expected.signature)) throw new TransferError("source-changed", rel);
    if (hashFd(fd, expected.size, rel) !== expected.sha256) throw new TransferError("source-changed", rel);
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, expected.size) > 0) throw new TransferError("source-changed", rel);
    if (!sameSignature(signatureOf(fstatSync(fd)), expected.signature) || !sameSignature(signatureOf(lstatBelow(root, rel)), expected.signature)) {
      throw new TransferError("source-changed", rel);
    }
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError("unreadable", rel);
  } finally { closeSync(fd); }
}

/**
 * A file read into memory only if it fits both bounds, the file's own and what
 * is left of the total after `total` bytes already held. The refusal says which
 * bound it was, and is made from the file's size before its bytes are read.
 */
export function readWithinBudget(root: string, rel: string, limits: BundleLimits, total: number,
  extra: { blobFormat?: "sha1" | "sha256"; scan?: ScanBudget; afterRead?: () => void } = {}): StableRead {
  const remaining = limits.maxTotalBytes - total;
  try {
    return readStable(root, rel, { retain: true, maxBytes: Math.min(limits.maxFileBytes, remaining), ...extra });
  } catch (error) {
    // A file over what is left of the total, and not over the per-file bound, is the total's refusal.
    if (error instanceof TransferError && error.code === "limit-file-bytes" && remaining < limits.maxFileBytes) {
      throw new TransferError("limit-total-bytes", rel);
    }
    throw error;
  }
}

// What a name alone can say about a file: a dotenv, a key, a token store, a
// login. This is NOT secret detection: a secret in a file named `notes.md` is
// not found by it, and a harmless `.env.example` is caught by it. It is only
// the line an enumeration will not cross by itself. The caller who means to
// carry such a file names it, and a file named is carried.
const CREDENTIAL_FILES: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.(npmrc|yarnrc|netrc|pypirc|git-credentials|pgpass|htpasswd|dockercfg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ppk)$/i,
  /^(credentials|secrets?|token|tokens|auth)(\.(json|ya?ml|toml|ini|txt))?$/i,
];
const CREDENTIAL_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".password-store", "keychains", ".azure", ".gcloud"]);

/** Whether an enumeration steps over this name rather than carry it unasked. */
export function credentialShaped(name: string, directory: boolean): boolean {
  return directory ? CREDENTIAL_DIRS.has(name.toLowerCase()) : CREDENTIAL_FILES.some(pattern => pattern.test(name));
}

/** A path an enumeration did not carry, and why. Nothing is left out without one of these. */
export interface Skipped { path: string; reason: "excluded-tree" | "credential-shaped-name" }

export interface CaptureOptions {
  /** Absolute. The one root everything below is read under. */
  root: string;
  /**
   * Files and directories under `root`, relative to it. Only these are read.
   * `"."` alone means the root itself, walked with the same filters as any
   * directory (it is valid here and in no manifest). A file named here is the
   * caller's deliberate choice and is carried whatever its name; a directory
   * named here, or a root, whose own name is credential-shaped is refused
   * (`path-excluded`), since walking it would carry its contents unasked.
   */
  paths: string[];
  /** The namespace these entries belong to. */
  class: BundleClass;
  /** Generated or runtime trees to step over, relative to `root`. */
  exclude?: string[];
  /** Directory names to step over at any depth. */
  excludeNames?: string[];
  limits: BundleLimits;
  /** Capture a delta against this bundle: what changed is carried, what vanished from the supplied paths is a tombstone. */
  base?: Pick<Bundle, "manifest">;
  /**
   * Called at the two points a concurrent writer could strike: inside a file's
   * read, after its bytes are read and before it is confirmed, and once after
   * every file is read, before the final pass. Production callers pass
   * nothing. A test passes a writer, so the guard is exercised on purpose and
   * not by luck of timing.
   */
  observe?: { afterRead?: (rel: string) => void; afterReads?: () => void };
}

export interface CaptureResult { bundle: Bundle; skipped: Skipped[]; root: string }

interface Enumeration { files: string[]; skipped: Skipped[]; listings: Map<string, string>; gone: string[] }

function enumerate(root: string, options: CaptureOptions): Enumeration {
  const exclude = (options.exclude ?? []).map(one => { assertPath(one); return one; });
  const names = new Set(options.excludeNames ?? []);
  const found: Enumeration = { files: [], skipped: [], listings: new Map(), gone: [] };
  const bounded = () => { if (found.files.length > options.limits.maxFiles) throw new TransferError("limit-files"); };
  const stepOver = (rel: string, name: string) => exclude.some(tree => isUnder(rel, tree)) || names.has(name);
  /** `rel` is "" for the root itself. */
  const walk = (rel: string) => {
    let entries: string[];
    try { entries = readdirSync(join(root, rel)); } catch { throw new TransferError("unreadable", rel === "" ? "." : rel); }
    entries.sort(comparePaths);
    found.listings.set(rel, entries.join("\0"));
    for (const name of entries) {
      const child = rel === "" ? name : `${rel}/${name}`;
      // A nested repository's control directory is never a workspace file. It
      // is named, and repos.ts is what reads a repository.
      if (name.toLowerCase() === ".git") { found.skipped.push({ path: child, reason: "excluded-tree" }); continue; }
      assertPath(child);
      const stat = lstatBelow(root, child);
      if (stat.isDirectory() ? stepOver(child, name) : exclude.some(tree => isUnder(child, tree))) {
        found.skipped.push({ path: child, reason: "excluded-tree" });
      } else if (stat.isDirectory()) {
        if (credentialShaped(name, true)) found.skipped.push({ path: child, reason: "credential-shaped-name" });
        else walk(child);
      } else if (stat.isFile()) {
        if (credentialShaped(name, false)) found.skipped.push({ path: child, reason: "credential-shaped-name" });
        else { found.files.push(child); bounded(); }
      } else throw new TransferError("special-file", child);
    }
  };
  if (options.paths.includes(".") && options.paths.length > 1) throw new TransferError("path-duplicate", ".");
  for (const rel of options.paths) {
    const whole = rel === ".";
    if (!whole) {
      assertPath(rel);
      // A path the caller asked for that the caller also excluded is a
      // contradiction to be named, not a choice to be made quietly.
      if (exclude.some(tree => isUnder(rel, tree)) || rel.split("/").some(part => names.has(part))) throw new TransferError("path-excluded", rel);
    }
    let stat: Stats;
    try { stat = whole ? lstatSync(root) : lstatBelow(root, rel); } catch (error) {
      // Gone is only a statement when there is a base that had it.
      if (error instanceof TransferError && error.code === "path-missing" && options.base) { found.gone.push(rel); continue; }
      throw error instanceof TransferError ? error : new TransferError("unreadable", rel);
    }
    if (stat.isDirectory()) {
      // The scan's own rule holds at the boundary it starts from: a selected
      // directory, or a root, that is credential-shaped is not swept by
      // implication. Only a file named outright is a deliberate choice.
      if ([basename(root), ...(whole ? [] : rel.split("/"))].some(part => credentialShaped(part, true))) throw new TransferError("path-excluded", rel);
      walk(whole ? "" : rel);
    } else if (stat.isFile()) { found.files.push(rel); bounded(); }
    else throw new TransferError("special-file", rel);
  }
  return found;
}

/**
 * Read the supplied files of one workspace into a bundle. Every path is either
 * in the bundle, in `skipped` with its reason, or a thrown refusal that names
 * it: a link, a device, a file that changed while it was read, a missing
 * supplied path, a bound exceeded.
 *
 * The snapshot is consistent or it is refused, as far as finite reads can say
 * (see the note at the top of this file). Each file is read twice inside
 * `readStable`; after every file has been read, the directories are listed
 * again, and then every file is read a third time and must match what was
 * captured in content, size, mode, identity and times. Any difference is
 * `source-changed`. Bytes read are at most three times `maxTotalBytes`, since
 * carried bytes are bounded by it.
 */
export function captureWorkspace(options: CaptureOptions): CaptureResult {
  assertLimits(options.limits);
  if (!BUNDLE_CLASSES.includes(options.class)) throw new TransferError("class-unknown");
  if (!Array.isArray(options.paths) || options.paths.length === 0) throw new TransferError("path-missing");
  const root = resolveRoot(options.root);
  const first = enumerate(root, options);
  const reads: { rel: string; read: StableRead }[] = [];
  let total = 0;
  for (const rel of first.files) {
    const afterRead = options.observe?.afterRead;
    const read = readWithinBudget(root, rel, options.limits, total, afterRead ? { afterRead: () => afterRead(rel) } : {});
    total += read.size;
    reads.push({ rel, read });
  }
  options.observe?.afterReads?.();
  const second = enumerate(root, options);
  const listed = (one: Enumeration) => JSON.stringify([one.files, one.skipped, [...one.listings], one.gone]);
  if (listed(first) !== listed(second)) throw new TransferError("source-changed");
  for (const { rel, read } of reads) confirmStable(root, rel, read);
  const current: EntryInput[] = reads.map(({ rel, read }) => ({ path: rel, class: options.class, mode: read.mode, bytes: read.bytes! }));
  if (!options.base) return { bundle: buildBundle(current, options.limits), skipped: first.skipped, root };

  // A delta speaks only for what the capture could see: a base path under a
  // supplied path is deleted when it is gone, but one the capture stepped
  // over on purpose is not a deletion, and one outside every supplied path
  // is not asked about. `"."` supplies the whole root.
  const covered = (path: string, one: string) => one === "." || isUnder(path, one);
  const inScope = (cls: BundleClass, path: string) => cls === options.class && options.paths.some(one => covered(path, one)) &&
    !first.skipped.some(one => isUnder(path, one.path));
  const held = options.base.manifest.entries.filter(one => one.kind === "file" && one.class === options.class).map(one => one.path);
  // A supplied path that is missing and was never in the base is not a deletion, it is a wrong path.
  for (const rel of first.gone) if (!held.some(path => covered(path, rel))) throw new TransferError("path-missing", rel);
  return { bundle: deltaAgainst(options.base, current, inScope, options.limits), skipped: first.skipped, root };
}

// ---------------------------------------------------------------------------
// Staging

/*
 * What staging may and may not claim. This library removes an object from a
 * destination only if it can show it made that object: it was created by this
 * call (exclusive create, recorded the moment it was open, partial writes
 * included) or it is listed, with the identity it had when it was finished, in
 * a marker whose operation, generation, root identity and plan match the
 * receipt the caller holds. A name is never evidence: not a planned path, not
 * the marker's file name, not a lone temp file, not a token on its own. An
 * object at a name this operation made, but no longer the object it made (a
 * foreign replacement, even with identical bytes), is left where it is and
 * named, and a stage or discard that leaves anything of the kind stops with
 * `stage-ambiguous` and never reports itself removed.
 *
 * What this does not claim. Identity is dev, inode, size and times, which is
 * exact for the objects this operation made and cannot be fooled by a
 * replacement that is another file. It is not proof against an actor that races
 * every system call on a path, and it does not serialise anything: the caller
 * serialises stage, reuse and discard per destination, which is also what makes
 * a late discard detectable (the receipt's generation no longer matches once
 * the stage was replaced, promoted or discarded). A process that dies between
 * creating an object and the next recorded step can leave one this operation
 * cannot later show it made: the retry names it (`stage-ambiguous`) and removes
 * nothing. The marker does not carry a per-file journal for that case.
 */

/** The shape of a caller's operation token. */
const OPERATION = /^[A-Za-z0-9._:-]{1,128}$/;

/** What an object looked like when this operation made it. A field is null when it was not settled then (a file still being written; a directory whose times move as it fills). */
export interface Made { dev: number; ino: number; size: number | null; mtimeMs: number | null; ctimeMs: number | null }

export function madeOf(stat: Stats, complete: boolean): Made {
  return { dev: stat.dev, ino: stat.ino, size: complete ? stat.size : null, mtimeMs: complete ? stat.mtimeMs : null, ctimeMs: complete ? stat.ctimeMs : null };
}

export function isMade(stat: Stats, made: Made): boolean {
  return stat.dev === made.dev && stat.ino === made.ino && (made.size === null || stat.size === made.size) &&
    (made.mtimeMs === null || stat.mtimeMs === made.mtimeMs) && (made.ctimeMs === null || stat.ctimeMs === made.ctimeMs);
}

interface EvidenceFile { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface EvidenceDir { path: string; dev: number; ino: number }
interface Identity { dev: number; ino: number }

/**
 * What a staging directory says about itself, written first and replaced whole
 * when staging completes. It names the stage (operation, generation), the
 * directory (root identity), the bundle and the resolved plan, and, once
 * complete, the identity of every file and directory the stage made.
 */
interface Marker {
  version: 1;
  manifest: string;
  plan: string;
  operation: string;
  generation: string;
  root: Identity;
  state: "staging" | "complete";
  createdRoot: boolean;
  files: string[];
  owned: { files: EvidenceFile[]; dirs: EvidenceDir[] };
}

/**
 * The receipt of a stage: what a caller keeps to reuse or discard exactly this
 * stage later. The orchestrator compares `generation` to tell a stage that was
 * replaced or promoted since from the one it holds, and calls `discardStaged`
 * only with the receipt it got.
 */
export interface StageReceipt {
  /** The real path the stage was made at. A link in it is refused at discard. */
  destination: string;
  manifestDigest: string;
  /** Digest of the resolved plan (base plus delta): what the directory is to hold. */
  planDigest: string;
  operation: string;
  /** Fresh for every stage this library starts, read back from the marker when one is reused. */
  generation: string;
  root: Identity;
  createdRoot: boolean;
  /** Files in the resolved plan: the most files the marker may list. */
  files: number;
  /** Directories the plan's files sit in (more than `files` for deep paths): the most directories the marker may record. */
  dirs: number;
  /** The most bytes the marker may take, from the plan's paths as they serialise (escapes and multibyte characters included). Discard reads no more than this. */
  markerBytes: number;
}

export interface StageOptions {
  bundle: Bundle;
  /** Absolute, and not yet existing (or existing and empty). Its parent must exist. */
  destination: string;
  /** The classes the caller means to stage. A bundle holding any other class is refused, not partly staged. */
  classes: BundleClass[];
  limits: BundleLimits;
  /** The caller's name for this operation, 1 to 128 of letters, digits and `._:-`. Kept in the marker and required again to reuse the stage. It is one part of ownership, never the whole of it. */
  operation: string;
  /** A delta's base, whose digest is the bundle's `base.id`. Its bytes are checked before anything is written. */
  base?: Bundle;
  baseLimits?: BundleLimits;
  /**
   * Called around each staged file's creation: before its exclusive create, and
   * after it is whole. Production callers pass nothing. A test passes a writer
   * (or a thrower), so a collision or a replacement happens on purpose and
   * deterministically.
   */
  observe?: { beforeCreate?: (rel: string) => void; afterCreate?: (rel: string) => void };
}

export interface StageResult { destination: string; manifestDigest: string; files: number; deleted: number; reused: boolean; receipt: StageReceipt }

interface Planned { path: string; mode: number; size: number; sha256: string; bytes: Uint8Array }

/** What the destination will hold, worked out entirely in memory from verified bundles. */
function plan(options: StageOptions): { files: Planned[]; deleted: number; digest: string } {
  const { bundle, base } = options;
  verifyBundle(bundle, options.limits);
  const allowed = new Set(options.classes);
  for (const one of bundle.manifest.entries) if (!allowed.has(one.class)) throw new TransferError("class-unhandled", one.path);
  const held = new Map<string, Planned>();
  let deleted = 0;
  if (bundle.manifest.base === null) {
    if (base) throw new TransferError("base-mismatch");
  } else {
    if (!base) throw new TransferError("base-required");
    if (base.manifest.digest !== bundle.manifest.base.id) throw new TransferError("base-mismatch");
    verifyBundle(base, options.baseLimits ?? options.limits);
    for (const one of base.manifest.entries) {
      if (one.kind !== "file") continue;
      if (!allowed.has(one.class)) throw new TransferError("class-unhandled", one.path);
      held.set(contentKey(one.class, one.path), { path: one.path, mode: one.mode, size: one.size, sha256: one.sha256, bytes: base.contents.get(contentKey(one.class, one.path))! });
    }
  }
  for (const one of bundle.manifest.entries) {
    const key = contentKey(one.class, one.path);
    if (one.kind === "delete") {
      // A deletion is checked against the base that is declared, here, before it is applied.
      if (!held.delete(key)) throw new TransferError("tombstone-unknown", one.path);
      deleted++;
    } else held.set(key, { path: one.path, mode: one.mode, size: one.size, sha256: one.sha256, bytes: bundle.contents.get(key)! });
  }
  const files = [...held.values()].sort((a, b) => comparePaths(a.path, b.path));
  // Two classes share the one staged tree, so the same path in two of them is one file too many.
  assertDistinct(files.map(one => ({ scope: "tree", path: one.path })));
  const digest = sha256Hex(Buffer.from(JSON.stringify([bundle.manifest.digest, files.map(one => [one.path, one.mode, one.size, one.sha256])])));
  return { files, deleted, digest };
}

/** The directories a set of files sits in, parents first, in byte order. */
function directoriesOf(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) dirs.add(dir);
  return [...dirs].sort(comparePaths);
}

function sameList(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((one, n) => one === b[n]); }

const MARKER_KEYS = ["version", "manifest", "plan", "operation", "generation", "root", "state", "createdRoot", "files", "owned"];
const FILE_EVIDENCE_KEYS = ["path", "dev", "ino", "size", "mtimeMs", "ctimeMs"];
const DIR_EVIDENCE_KEYS = ["path", "dev", "ino"];

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * What a stage's marker may hold, worked out from the resolved plan's file
 * list alone: how many files, how many directories (a deep path has many more
 * directories than it has files) and how many bytes of JSON. Stage and discard
 * read the marker under the same three numbers, the receipt carries them, and
 * nothing else bounds a marker read.
 */
interface MarkerBounds { files: number; dirs: number; bytes: number }

/** Keys, digests, operation token, generation, root and the state, with room to spare. */
const MARKER_FIXED_BYTES = 4096;
/** A file's evidence object beyond its path: its keys, its separators and five JSON numbers, each at most 24 characters (32 allowed). */
const FILE_EVIDENCE_BYTES = 256;
/** A directory's evidence object beyond its path: its keys, its separators and two numbers. */
const DIR_EVIDENCE_BYTES = 128;
/** A path is at most 1024 bytes and a directory takes at least two of them (a name and its slash), so a file sits in at most 511. */
const MAX_DIRS_PER_FILE = 511;
/** A 1024-byte path serialised: every byte at most doubles (a quote is escaped, a lone surrogate's three bytes become six), plus the quotes. */
const MAX_PATH_JSON_BYTES = 2 * 1024 + 2;

/** The serialised size of a path as the marker writes it: escapes and multibyte characters counted as they come out. */
const pathJsonBytes = (path: string): number => Buffer.byteLength(JSON.stringify(path));

/** The bounds for a plan's files. A path is in the marker's `files` and in its `owned.files`, and every directory above it is in `owned.dirs`, once. */
function markerBounds(listing: readonly string[]): MarkerBounds {
  const dirs = directoriesOf(listing);
  let bytes = MARKER_FIXED_BYTES;
  for (const path of listing) bytes += 2 * pathJsonBytes(path) + 1 + FILE_EVIDENCE_BYTES;
  for (const dir of dirs) bytes += pathJsonBytes(dir) + 1 + DIR_EVIDENCE_BYTES;
  return { files: listing.length, dirs: dirs.length, bytes };
}

/** Whether three numbers could be a plan's bounds at all: whole, and no larger than the most any plan of that many files can need. */
function plausibleBounds(files: unknown, dirs: unknown, bytes: unknown): boolean {
  if (!isWhole(files) || !isWhole(dirs) || !isWhole(bytes)) return false;
  if (dirs > files * MAX_DIRS_PER_FILE) return false;
  const most = MARKER_FIXED_BYTES + files * (2 * MAX_PATH_JSON_BYTES + 1 + FILE_EVIDENCE_BYTES) + dirs * (MAX_PATH_JSON_BYTES + 1 + DIR_EVIDENCE_BYTES);
  return bytes >= MARKER_FIXED_BYTES && bytes <= most;
}

/** The marker's text as a marker, or `destination-foreign`: every key and every value is checked, and no list is longer than its bound. */
function parseMarker(text: string, bounds: MarkerBounds): Marker {
  const foreign = () => new TransferError("destination-foreign");
  let data: any;
  try { data = JSON.parse(text); } catch { throw foreign(); }
  if (!isRecord(data) || !exactKeys(data, MARKER_KEYS) || data.version !== 1 ||
      typeof data.manifest !== "string" || !/^[0-9a-f]{64}$/.test(data.manifest) || typeof data.plan !== "string" || !/^[0-9a-f]{64}$/.test(data.plan) ||
      typeof data.operation !== "string" || !OPERATION.test(data.operation) || typeof data.generation !== "string" || !/^[0-9a-f]{32}$/.test(data.generation) ||
      !isRecord(data.root) || !exactKeys(data.root, ["dev", "ino"]) || !isCount(data.root.dev) || !isCount(data.root.ino) ||
      (data.state !== "staging" && data.state !== "complete") || typeof data.createdRoot !== "boolean" ||
      !Array.isArray(data.files) || data.files.length > bounds.files || data.files.some((one: unknown) => pathProblem(one) !== null) ||
      !isRecord(data.owned) || !exactKeys(data.owned, ["files", "dirs"]) || !Array.isArray(data.owned.files) || !Array.isArray(data.owned.dirs) ||
      data.owned.files.length > bounds.files || data.owned.dirs.length > bounds.dirs) throw foreign();
  for (const one of data.owned.files) {
    if (!isRecord(one) || !exactKeys(one, FILE_EVIDENCE_KEYS) || pathProblem(one.path) !== null ||
        !isCount(one.dev) || !isCount(one.ino) || !isCount(one.size) || !isCount(one.mtimeMs) || !isCount(one.ctimeMs)) throw foreign();
  }
  for (const one of data.owned.dirs) {
    if (!isRecord(one) || !exactKeys(one, DIR_EVIDENCE_KEYS) || pathProblem(one.path) !== null || !isCount(one.dev) || !isCount(one.ino)) throw foreign();
  }
  return data as Marker;
}

/** Whether a marker's lists agree with one another: a stage in progress has recorded nothing, a complete one has recorded exactly its files and their directories. */
function coherent(marker: Marker): boolean {
  if (new Set(marker.files).size !== marker.files.length) return false;
  if (marker.state === "staging") return marker.owned.files.length === 0 && marker.owned.dirs.length === 0;
  return sameList(marker.owned.files.map(one => one.path), marker.files) &&
    sameList(marker.owned.dirs.map(one => one.path), directoriesOf(marker.files));
}

/** The marker, read through a bounded read of a regular file reached without a link; `bounds` are the resolved plan's, which is what its size and its lists are held to. */
function readMarker(destination: string, bounds: MarkerBounds): { marker: Marker; seen: Stats } {
  const path = join(destination, STAGE_MARKER);
  const bound = bounds.bytes;
  let seen: Stats;
  let text: string;
  try {
    seen = lstatSync(path);
    if (!seen.isFile() || seen.size > bound) throw new Error("unusable");
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== seen.ino || opened.dev !== seen.dev || opened.size > bound) throw new Error("unusable");
      const buffer = Buffer.allocUnsafe(opened.size);
      let done = 0;
      while (done < opened.size) {
        const got = readSync(fd, buffer, done, opened.size - done, done);
        if (got === 0) break;
        done += got;
      }
      text = buffer.subarray(0, done).toString("utf8");
    } finally { closeSync(fd); }
  } catch { throw new TransferError("destination-foreign"); }
  return { marker: parseMarker(text, bounds), seen };
}

/** What this operation has made in a destination, each object with the identity it had when made. `null` is an object that was created but could not be identified, which can only be reported. */
interface Owned { files: Map<string, Made | null>; dirs: Map<string, Made | null>; tmp: Made | null; marker: Made | null }

/**
 * Create a file that does not exist, write it, set its mode and sync it.
 * `track` hears of it the moment it is open, whole or not, and again when it is
 * complete, so a failed write still leaves the file recorded as this
 * operation's.
 */
export function writeExclusive(abs: string, bytes: Uint8Array, mode: number, track: (made: Made | null) => void): Made {
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    try { track(madeOf(fstatSync(fd), false)); } catch { track(null); }
    let done = 0;
    while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
    // Not subject to the umask, so the mode on disk is the mode the manifest says.
    fchmodSync(fd, mode);
    fsyncSync(fd);
    const whole = madeOf(fstatSync(fd), true);
    track(whole);
    return whole;
  } finally { closeSync(fd); }
}

/**
 * The marker is replaced whole, so a crash leaves the old one or the new one
 * and never half of either. Its temp file is tracked from its creation, and
 * once renamed the marker takes its identity (without the change time, which a
 * rename moves).
 */
function writeMarker(destination: string, marker: Marker, ours: Owned): void {
  const tmp = join(destination, STAGE_MARKER_TMP);
  const made = writeExclusive(tmp, Buffer.from(JSON.stringify(marker)), 0o600, one => { ours.tmp = one === null ? null : { ...one, ctimeMs: null }; });
  renameSync(tmp, join(destination, STAGE_MARKER));
  ours.tmp = null;
  ours.marker = { ...made, ctimeMs: null };
}

/** What is at `rel` against what was made there: nothing (gone), the object this operation made, or anything else. No link is followed on the way. */
function claim(destination: string, rel: string, made: Made | null, kind: "file" | "dir"): "gone" | "ours" | "other" {
  let stat: Stats;
  try { stat = rel === STAGE_MARKER || rel === STAGE_MARKER_TMP ? lstatSync(join(destination, rel)) : lstatBelow(destination, rel); } catch (error) {
    const gone = error instanceof TransferError ? error.code === "path-missing" : errnoOf(error) === "ENOENT";
    return gone ? "gone" : "other";
  }
  if (made === null || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) return "other";
  return isMade(stat, made) ? "ours" : "other";
}

/** The first name left in a directory, to say what stopped its removal; "." when it cannot be listed. */
function firstEntry(destination: string): string {
  try { return readdirSync(destination).sort()[0] ?? "."; } catch { return "."; }
}

/**
 * Remove what this operation made, and only that, and return what it left.
 * The root must still be the directory that was staged into (identity, not a
 * link, parent not a link). Each file goes only if what is at its path is the
 * object made there; each directory only if it is the one made and is empty;
 * the temp file and the marker only as the objects this operation wrote. The
 * marker stays while anything else does, so what remains is still named by
 * it; the root goes only if this operation created it and nothing is left.
 * Anything not removed is in the returned list, by its path, and a caller
 * that gets a non-empty list must not report the stage discarded.
 */
function removeOwned(destination: string, root: Identity, owned: Owned, createdRoot: boolean): string[] {
  let at: Stats;
  try { at = lstatSync(destination); } catch (error) { return errnoOf(error) === "ENOENT" ? [] : ["."]; }
  let parent: string | null = null;
  try { parent = realpathSync(dirname(destination)); } catch { /* treated as a link below */ }
  if (parent !== dirname(destination) || at.isSymbolicLink() || !at.isDirectory() || at.dev !== root.dev || at.ino !== root.ino) return ["."];

  const left: string[] = [];
  const settle = (rel: string, made: Made | null, kind: "file" | "dir", remove: () => void) => {
    const verdict = claim(destination, rel, made, kind);
    if (verdict === "gone") return;
    if (verdict === "other") { left.push(rel); return; }
    try { remove(); } catch (error) { if (errnoOf(error) !== "ENOENT") left.push(rel); }
  };
  for (const [rel, made] of [...owned.files].reverse()) settle(rel, made, "file", () => unlinkSync(join(destination, rel)));
  for (const [rel, made] of [...owned.dirs].sort((a, b) => b[0].split("/").length - a[0].split("/").length)) {
    settle(rel, made, "dir", () => rmdirSync(join(destination, rel)));
  }
  if (owned.tmp) settle(STAGE_MARKER_TMP, owned.tmp, "file", () => unlinkSync(join(destination, STAGE_MARKER_TMP)));
  if (left.length === 0 && owned.marker) settle(STAGE_MARKER, owned.marker, "file", () => unlinkSync(join(destination, STAGE_MARKER)));
  if (createdRoot && left.length === 0) {
    try { rmdirSync(destination); } catch (error) { if (errnoOf(error) !== "ENOENT") left.push(firstEntry(destination)); }
  }
  return left;
}

/** The first recorded object whose path now holds something else, for a check made before anything is changed. */
function firstForeign(destination: string, marker: Marker): string | null {
  for (const one of marker.owned.files) {
    if (claim(destination, one.path, { dev: one.dev, ino: one.ino, size: one.size, mtimeMs: one.mtimeMs, ctimeMs: one.ctimeMs }, "file") === "other") return one.path;
  }
  for (const one of marker.owned.dirs) {
    if (claim(destination, one.path, { dev: one.dev, ino: one.ino, size: null, mtimeMs: null, ctimeMs: null }, "dir") === "other") return one.path;
  }
  return null;
}

/** What is in the staged tree now, files by relative path and directories, read without following a link. `cap` bounds the entries it will list. */
function listTree(root: string, cap: number): { files: Map<string, Stats>; dirs: Set<string> } {
  const files = new Map<string, Stats>(), dirs = new Set<string>();
  const walk = (rel: string) => {
    for (const name of readdirSync(rel === "" ? root : join(root, rel))) {
      if (files.size + dirs.size >= cap) throw new TransferError("stage-verify", rel === "" ? "." : rel);
      const child = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(root, child));
      if (stat.isDirectory()) { dirs.add(child); walk(child); } else if (stat.isFile()) files.set(child, stat);
      else throw new TransferError("stage-verify", child);
    }
  };
  walk("");
  return { files, dirs };
}

/**
 * The staged tree against the plan, read back from disk: every file's size and
 * mode are checked before its bytes are read, the read is capped at the planned
 * size, nothing is extra and every deletion is absent.
 */
function verifyStaged(destination: string, files: Planned[]): void {
  const dirs = new Set(directoriesOf(files.map(one => one.path)));
  // The plan's files and directories, and the marker.
  const tree = listTree(destination, files.length + dirs.size + 1);
  const wanted = new Map(files.map(one => [one.path, one]));
  for (const path of tree.files.keys()) if (path !== STAGE_MARKER && !wanted.has(path)) throw new TransferError("stage-verify", path);
  for (const dir of tree.dirs) if (!dirs.has(dir)) throw new TransferError("stage-verify", dir);
  for (const one of files) {
    const stat = tree.files.get(one.path);
    if (!stat) throw new TransferError("stage-verify", one.path);
    if ((stat.mode & 0o777) !== one.mode || stat.size !== one.size) throw new TransferError("stage-verify", one.path);
    let read: StableRead;
    try { read = readStable(destination, one.path, { retain: false, maxBytes: one.size }); } catch { throw new TransferError("stage-verify", one.path); }
    if (read.size !== one.size || read.sha256 !== one.sha256) throw new TransferError("stage-verify", one.path);
  }
}

function receiptOf(marker: Marker, destination: string, bounds: MarkerBounds): StageReceipt {
  return {
    destination, manifestDigest: marker.manifest, planDigest: marker.plan, operation: marker.operation, generation: marker.generation,
    root: { dev: marker.root.dev, ino: marker.root.ino }, createdRoot: marker.createdRoot, files: bounds.files, dirs: bounds.dirs, markerBytes: bounds.bytes,
  };
}

/**
 * Stage a verified bundle into a directory this call owns.
 *
 * Everything that can be refused is refused before the first write: the
 * manifest and every byte against it, the classes, the operation, the base and
 * each tombstone against it, the destination. The destination must not exist,
 * or be empty: one holding anything else is refused as it stands, and no file
 * in it is ever replaced, because every file is created exclusively.
 *
 * A marker naming the stage (operation, a fresh generation), the directory's
 * identity, the bundle's digest and the resolved plan goes down first. A
 * directory whose marker says `complete` for this bundle, plan, operation and
 * root is read back (content, then the identity of everything it recorded) and
 * reported `reused`, with the receipt it was made under. A directory whose
 * marker is an unfinished one of this stage and holds nothing else is
 * continued. A directory with anything else in it, an unfinished stage's
 * files included, is refused and left exactly as it is: a crashed stage is
 * not cleaned up by guessing, it is `stage-ambiguous` and named, since nothing
 * records which of its files this operation made. A marker for another
 * bundle, plan, operation or directory is `destination-foreign`.
 *
 * A failed stage removes what this call made, each object only if it is still
 * the object that was made, and rethrows. If anything is left that this call
 * cannot show it made (a foreign file at a planned name, a replaced file, a
 * directory that now holds something else), it is left, named, and the stage
 * stops with `stage-ambiguous` instead of the error that started it.
 *
 * The caller serialises stage, reuse and discard per destination.
 */
export function stageBundle(options: StageOptions): StageResult {
  assertLimits(options.limits);
  if (typeof options.operation !== "string" || !OPERATION.test(options.operation)) throw new TransferError("operation-invalid");
  const { files, deleted, digest: planned } = plan(options);
  const digest = options.bundle.manifest.digest;
  const listing = files.map(one => one.path);
  const bounds = markerBounds(listing);

  if (typeof options.destination !== "string" || !isAbsolute(options.destination)) throw new TransferError("destination-invalid");
  const name = basename(options.destination);
  if (name === "" || name === "." || name === "..") throw new TransferError("destination-invalid");
  let parent: string;
  try { parent = realpathSync(dirname(options.destination)); } catch { throw new TransferError("destination-invalid"); }
  const destination = join(parent, name);

  const ours: Owned = { files: new Map(), dirs: new Map(), tmp: null, marker: null };
  let existing: Stats | null = null;
  try { existing = lstatSync(destination); } catch (error) { if (errnoOf(error) !== "ENOENT") throw new TransferError("destination-invalid"); }
  let createdRoot = true;
  let rootStat: Stats;
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new TransferError("destination-exists");
    rootStat = existing;
    createdRoot = false;
    let names: string[];
    try { names = readdirSync(destination); } catch { throw new TransferError("destination-invalid"); }
    if (names.length > 0) {
      if (!names.includes(STAGE_MARKER)) {
        // A crash between the marker's write and its rename leaves only the temp file. It is this library's name and nobody's proof: it is named and left.
        if (names.length === 1 && names[0] === STAGE_MARKER_TMP) throw new TransferError("stage-ambiguous", STAGE_MARKER_TMP);
        throw new TransferError("destination-exists");
      }
      const { marker, seen } = readMarker(destination, bounds);
      if (marker.manifest !== digest || marker.plan !== planned || marker.operation !== options.operation ||
          marker.root.dev !== rootStat.dev || marker.root.ino !== rootStat.ino || !sameList(marker.files, listing) || !coherent(marker)) {
        throw new TransferError("destination-foreign");
      }
      if (marker.state === "complete") {
        verifyStaged(destination, files);
        const foreign = firstForeign(destination, marker);
        if (foreign !== null) throw new TransferError("stage-ambiguous", foreign);
        return { destination, manifestDigest: digest, files: files.length, deleted, reused: true, receipt: receiptOf(marker, destination, bounds) };
      }
      const others = names.filter(one => one !== STAGE_MARKER);
      if (others.length > 0) throw new TransferError("stage-ambiguous", others.sort()[0]);
      // An unfinished marker of this stage, alone in the directory: there is nothing else to be wrong about, so the stage goes on from it.
      ours.marker = { ...madeOf(seen, true), ctimeMs: null };
      createdRoot = marker.createdRoot;
    }
  } else {
    try { mkdirSync(destination, { mode: 0o700 }); } catch (error) {
      throw new TransferError(errnoOf(error) === "EEXIST" ? "destination-exists" : "destination-invalid");
    }
    // Made by this call, so it is this call's to remove; if it cannot even be identified it is named and left.
    try { rootStat = lstatSync(destination); } catch { throw new TransferError("stage-ambiguous", "."); }
    if (!rootStat.isDirectory()) throw new TransferError("stage-ambiguous", ".");
  }

  const root: Identity = { dev: rootStat.dev, ino: rootStat.ino };
  const marker: Marker = {
    version: 1, manifest: digest, plan: planned, operation: options.operation, generation: randomBytes(16).toString("hex"), root,
    state: "staging", createdRoot, files: listing, owned: { files: [], dirs: [] },
  };
  try {
    writeMarker(destination, marker, ours);
    for (const one of files) {
      const parts = one.path.split("/");
      for (let n = 1; n < parts.length; n++) {
        const dir = parts.slice(0, n).join("/");
        if (ours.dirs.has(dir)) continue;
        // Exclusive: a directory that is already there is not ours to reuse.
        mkdirSync(join(destination, dir), { mode: 0o700 });
        ours.dirs.set(dir, null);
        ours.dirs.set(dir, madeOf(lstatSync(join(destination, dir)), false));
      }
      options.observe?.beforeCreate?.(one.path);
      writeExclusive(join(destination, one.path), one.bytes, one.mode, made => { ours.files.set(one.path, made); });
      options.observe?.afterCreate?.(one.path);
    }
    verifyStaged(destination, files);
    const evidence: Marker["owned"] = { files: [], dirs: [] };
    for (const rel of listing) {
      const made = ours.files.get(rel);
      if (!made || made.size === null || made.mtimeMs === null || made.ctimeMs === null) throw new TransferError("stage-io");
      evidence.files.push({ path: rel, dev: made.dev, ino: made.ino, size: made.size, mtimeMs: made.mtimeMs, ctimeMs: made.ctimeMs });
    }
    for (const rel of directoriesOf(listing)) {
      const made = ours.dirs.get(rel);
      if (!made) throw new TransferError("stage-io");
      evidence.dirs.push({ path: rel, dev: made.dev, ino: made.ino });
    }
    const complete: Marker = { ...marker, state: "complete", owned: evidence };
    writeMarker(destination, complete, ours);
    return { destination, manifestDigest: digest, files: files.length, deleted, reused: false, receipt: receiptOf(complete, destination, bounds) };
  } catch (error) {
    const left = removeOwned(destination, root, ours, createdRoot);
    if (left.length > 0) throw new TransferError("stage-ambiguous", left[0]);
    if (error instanceof TransferError) throw error;
    throw new TransferError("stage-io");
  }
}

function assertReceipt(receipt: StageReceipt): void {
  const ok = isRecord(receipt) && typeof receipt.destination === "string" && isAbsolute(receipt.destination) && basename(receipt.destination) !== "" &&
    typeof receipt.manifestDigest === "string" && /^[0-9a-f]{64}$/.test(receipt.manifestDigest) &&
    typeof receipt.planDigest === "string" && /^[0-9a-f]{64}$/.test(receipt.planDigest) &&
    typeof receipt.operation === "string" && OPERATION.test(receipt.operation) &&
    typeof receipt.generation === "string" && /^[0-9a-f]{32}$/.test(receipt.generation) &&
    isRecord(receipt.root) && isCount(receipt.root.dev) && isCount(receipt.root.ino) && typeof receipt.createdRoot === "boolean" &&
    plausibleBounds(receipt.files, receipt.dirs, receipt.markerBytes);
  if (!ok) throw new TransferError("destination-invalid");
}

/**
 * Remove a stage this library made, found by the receipt it gave, and nothing
 * else. Before anything changes: the destination is a real directory reached
 * through no link (a link as the destination or in its parents is refused, and
 * never resolved into its target), it is the directory that was staged into,
 * and its marker is the one the receipt names (manifest, plan, operation,
 * generation, root, creation). A directory that was replaced, promoted or
 * already discarded is `stage-stale`, a marker for another bundle or plan is
 * `destination-foreign`, and neither is touched. The receipt's `files`, `dirs`
 * and `markerBytes` must be whole numbers no plan of that size could exceed;
 * the marker is read under them (a marker that is larger, or lists more files
 * or directories, is foreign) and they must be the ones its own file list works
 * out to. Then the marker's recorded
 * files and directories are checked against what is there: one that is now
 * another object stops the discard before anything is removed.
 *
 * Only what the marker records is removed, each object by identity, then the
 * marker, and the root only if the stage created it. It returns only when
 * everything is gone. Anything left (a directory that has since gained files
 * of someone else's, say) is named in `stage-ambiguous`, and the marker stays;
 * discard is never reported for a stage with leftovers. A stage still
 * `staging` (recorded nothing) is discarded only if it holds nothing but its
 * marker. The caller serialises this with every other use of the destination.
 */
export function discardStaged(options: { receipt: StageReceipt }): void {
  const { receipt } = options;
  assertReceipt(receipt);
  const destination = receipt.destination;
  let parent: string;
  try { parent = realpathSync(dirname(destination)); } catch { throw new TransferError("destination-invalid"); }
  if (parent !== dirname(destination)) throw new TransferError("destination-invalid");
  let at: Stats;
  try { at = lstatSync(destination); } catch (error) {
    throw new TransferError(errnoOf(error) === "ENOENT" ? "stage-stale" : "destination-invalid");
  }
  if (at.isSymbolicLink() || !at.isDirectory()) throw new TransferError("destination-invalid");
  if (at.dev !== receipt.root.dev || at.ino !== receipt.root.ino) throw new TransferError("stage-stale");
  try { lstatSync(join(destination, STAGE_MARKER)); } catch (error) {
    throw new TransferError(errnoOf(error) === "ENOENT" ? "stage-stale" : "destination-foreign");
  }
  const { marker, seen } = readMarker(destination, { files: receipt.files, dirs: receipt.dirs, bytes: receipt.markerBytes });
  if (marker.manifest !== receipt.manifestDigest || marker.plan !== receipt.planDigest) throw new TransferError("destination-foreign");
  if (marker.operation !== receipt.operation || marker.generation !== receipt.generation || marker.createdRoot !== receipt.createdRoot ||
      marker.root.dev !== receipt.root.dev || marker.root.ino !== receipt.root.ino) throw new TransferError("stage-stale");
  // The receipt's bounds are the ones this marker's own file list works out to: a receipt that only bounds the read is also the plan it names.
  const listed = markerBounds(marker.files);
  if (listed.files !== receipt.files || listed.dirs !== receipt.dirs || listed.bytes !== receipt.markerBytes) throw new TransferError("stage-stale");
  if (!coherent(marker)) throw new TransferError("destination-foreign");
  // The marker read is the marker that is there.
  let now: Stats;
  try { now = lstatSync(join(destination, STAGE_MARKER)); } catch { throw new TransferError("stage-stale"); }
  if (now.dev !== seen.dev || now.ino !== seen.ino || now.size !== seen.size || now.mtimeMs !== seen.mtimeMs) throw new TransferError("stage-stale");

  if (marker.state === "staging") {
    let names: string[];
    try { names = readdirSync(destination); } catch { throw new TransferError("destination-invalid"); }
    const others = names.filter(one => one !== STAGE_MARKER);
    if (others.length > 0) throw new TransferError("stage-ambiguous", others.sort()[0]);
  } else {
    const foreign = firstForeign(destination, marker);
    if (foreign !== null) throw new TransferError("stage-ambiguous", foreign);
  }
  const owned: Owned = {
    files: new Map(marker.owned.files.map(one => [one.path, { dev: one.dev, ino: one.ino, size: one.size, mtimeMs: one.mtimeMs, ctimeMs: one.ctimeMs }])),
    dirs: new Map(marker.owned.dirs.map(one => [one.path, { dev: one.dev, ino: one.ino, size: null, mtimeMs: null, ctimeMs: null }])),
    tmp: null,
    marker: { dev: seen.dev, ino: seen.ino, size: seen.size, mtimeMs: seen.mtimeMs, ctimeMs: null },
  };
  const left = removeOwned(destination, marker.root, owned, marker.createdRoot);
  if (left.length > 0) throw new TransferError("stage-ambiguous", left[0]);
}
