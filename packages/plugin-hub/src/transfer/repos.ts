import { createHash } from "node:crypto";
import { existsSync, lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { PROGRAM_KEYS } from "../sync/run.ts";
import {
  assertLimits, assertPath, buildBundle, comparePaths, sha256Hex, TransferError, verifyBundle,
  type Bundle, type BundleLimits, type EntryInput,
} from "./bundle.ts";
import {
  confirmStable, credentialShaped, errnoOf, lstatBelow, readStable, readWithinBudget, resolveRoot, sameSignature, type FileSignature, type ScanBudget,
} from "./workspace.ts";

/**
 * A read-only snapshot of ONE repository the caller named, and the check a
 * destination makes before a revision is used there.
 *
 * What this is not: it does not commit, stage, fetch, reset, check out,
 * rebase, push or take a lock, in the source or anywhere else, and it reaches
 * no network. It does not materialise anything in a destination repository:
 * that orchestration (an isolated worktree or clone from the destination's own
 * object store, the bundle's bytes laid over it, the index rebuilt) is left
 * unimplemented on purpose, because it is where the move's state machine and
 * the adapter's layout meet, and a snapshot that is taken is not a transfer
 * that is usable. `requireLocalRevision` is the one precondition of it that is
 * stable on its own. The git it needs is 2.31 or newer (`--show-scope`,
 * `--path-format`); an older one refuses as `repo-git-failed`.
 *
 * How the source is read. The repository's own config is asked first, and a key
 * that would start a program (a filter, a helper, a hook path, a diff or merge
 * driver, an include) refuses the snapshot before any other command runs. The
 * commands that then run are plumbing that starts none of them: `rev-parse`,
 * `symbolic-ref`, `ls-tree`, `ls-files` and `cat-file`. Status is not asked of
 * git at all. `status` and `diff` compare file contents through filters and
 * text conversions, and a caller cannot know what a repository's attributes
 * would run there, so the same answer is worked out here from three lists git
 * gives without filtering (HEAD's tree, the index, the untracked files) and
 * the working tree's own bytes, hashed with git's blob hash. Every git call
 * has its inherited `GIT_*` cleared, optional locks off and hooks, fsmonitor
 * and the ext and fd transports turned off on the command line, and what git
 * prints is kept only long enough to be parsed, never in an error.
 *
 * The working tree is compared raw. A repository that stores text with
 * converted line endings therefore shows every such file as changed, which is
 * the safe direction: it is carried, not assumed equal.
 */

/** Where the bytes of a staged index blob, one the working tree does not hold, travel inside a bundle. */
export const INDEX_BLOB_PREFIX = ".imprnt-transfer/index/";

export interface RepoLimits extends BundleLimits {
  /** The most a single git command may print before it is stopped and refused. */
  maxGitOutputBytes: number;
  /**
   * The most bytes one snapshot may read from regular files in all, working
   * files and the index file alike. Every read is charged before it happens,
   * from the file's size, so an oversized file is refused by name
   * (`limit-scan-bytes`) without being opened. A file costs twice its size for
   * one `readStable` (the read and its confirming read) and once more for the
   * final pass, so a clean working file counts three times its size, a carried
   * one five times (its first read, the second read that retains its bytes, and
   * the final pass), and the index file four times (the start and the end of
   * the snapshot), six when a staged empty blob makes its flags be read.
   * Carried bytes are bounded separately, by `maxFileBytes` and `maxTotalBytes`.
   */
  maxScanBytes: number;
}

/** What one side of git holds for a path: its mode as git writes it, and the blob id. */
export interface RepoSide { mode: string; oid: string }

export interface RepoChange {
  path: string;
  /** Two letters, as `git status --porcelain` says them. The first is HEAD against the index (` ` same, `A`, `M`, `D`), the second the index against the working tree (` ` same, `M`, `D`, `?` not in the index). */
  status: string;
  head: RepoSide | null;
  index: RepoSide | null;
  /** The working file, or null when there is none. Permission bits, size, sha256 and git blob id. */
  worktree: { mode: number; size: number; sha256: string; oid: string } | null;
  /** What travels for the working tree: its bytes, a deletion of HEAD's file, nothing (HEAD already has it), or nothing because an untracked path is credential-shaped and was not asked for. A tracked path whose bytes would be withheld is refused instead, so `withheld` is only ever an untracked file. */
  carried: "worktree" | "tombstone" | "none" | "withheld";
  /** Set when the index holds bytes that neither HEAD nor the working tree does: they travel under `INDEX_BLOB_PREFIX` + their oid. */
  indexBlob?: "carried";
}

export interface RepoMetadata {
  version: 1;
  objectFormat: "sha1" | "sha256";
  head: string;
  /** Null for a detached HEAD. */
  branch: string | null;
  /** The digest of the bundle these changes travel in. It binds this metadata to exactly one bundle: two snapshots at the same HEAD differ here. */
  bundleDigest: string;
  /** sha256 of the index file's own bytes, as they were. Null when the repository has none. */
  indexSha256: string | null;
  tracked: number;
  clean: number;
  changes: RepoChange[];
  /** The files the caller named, each carried or verified equal to HEAD's. */
  dependencies: { path: string; state: "carried" | "tracked-clean"; mode: number; size: number; sha256: string }[];
  /** Untracked files left out because their names are credential-shaped and the caller did not name them. Integration resolves any the work needs. */
  withheld: { path: string; what: "worktree"; reason: "credential-shaped-name" }[];
}

export interface RepoSnapshot {
  metadata: RepoMetadata;
  /** sha256 of the metadata's canonical text (`metadataDigestOf`). */
  metadataDigest: string;
  /** The bytes that travel. A delta against the revision: its base id is `git:<format>:<head>`. */
  bundle: Bundle;
  source: {
    root: string;
    gitDir: string;
    /** The repository's identity for a lock: the real path of its common git directory, which is what the sync keys its own lock on. The caller takes the lock and revalidates at its checkpoint. */
    commonDir: string;
  };
}

export interface RepoSnapshotOptions {
  /** Absolute path of the repository's top level. */
  repo: string;
  limits: RepoLimits;
  /** Repository-relative files the caller says the work needs, beyond what is changed: an ignored file, say, or a credential-shaped tracked one. Each is carried, or verified equal to HEAD's, or refused by name. Naming a file is also what lets a changed credential-shaped tracked file travel. */
  dependencyFiles?: string[];
  /** Called once after every file is read and before the final comparison, where a concurrent writer could strike. Production callers pass nothing; a test passes the writer. */
  observe?: { afterReads?: () => void | Promise<void> };
}

// ---------------------------------------------------------------------------
// metadata binding

const sideText = (side: RepoSide | null) => side === null ? null : { mode: side.mode, oid: side.oid };

/** The text a metadata digest is taken over. Every object is built key by key, so its order never depends on how the metadata was made or carried. */
function canonicalMetadata(metadata: RepoMetadata): string {
  return JSON.stringify({
    version: metadata.version, objectFormat: metadata.objectFormat, head: metadata.head, branch: metadata.branch,
    bundleDigest: metadata.bundleDigest, indexSha256: metadata.indexSha256, tracked: metadata.tracked, clean: metadata.clean,
    changes: metadata.changes.map(one => ({
      path: one.path, status: one.status, head: sideText(one.head), index: sideText(one.index),
      worktree: one.worktree === null ? null : { mode: one.worktree.mode, size: one.worktree.size, sha256: one.worktree.sha256, oid: one.worktree.oid },
      carried: one.carried, ...(one.indexBlob ? { indexBlob: one.indexBlob } : {}),
    })),
    dependencies: metadata.dependencies.map(one => ({ path: one.path, state: one.state, mode: one.mode, size: one.size, sha256: one.sha256 })),
    withheld: metadata.withheld.map(one => ({ path: one.path, what: one.what, reason: one.reason })),
  });
}

export function metadataDigestOf(metadata: RepoMetadata): string { return sha256Hex(Buffer.from(canonicalMetadata(metadata))); }

/**
 * The one entry point a consumer uses before it trusts a snapshot, or a
 * metadata and a bundle it was handed separately: the bundle is verified, the
 * metadata's digest is recomputed and must be the one claimed, the metadata
 * must name this bundle's digest, the bundle must be a delta against this
 * metadata's revision, and every carried path and deletion the metadata lists
 * must be what the bundle holds. A metadata and a bundle from two snapshots of
 * the same HEAD fail here (`snapshot-mismatch`, naming the part), never pass as
 * a pair. Nothing is read from a disk.
 */
export function verifySnapshot(snapshot: Pick<RepoSnapshot, "metadata" | "metadataDigest" | "bundle">, limits: BundleLimits): void {
  const mismatch = (part: string) => new TransferError("snapshot-mismatch", part);
  verifyBundle(snapshot.bundle, limits);
  const { metadata, bundle } = snapshot;
  let digest: string;
  try { digest = metadataDigestOf(metadata); } catch { throw mismatch("metadata"); }
  if (digest !== snapshot.metadataDigest) throw mismatch("metadata");
  if (metadata.bundleDigest !== bundle.manifest.digest) throw mismatch("bundle");
  if (bundle.manifest.base?.id !== `git:${metadata.objectFormat}:${metadata.head}`) throw mismatch("base");
  const entries = new Map(bundle.manifest.entries.filter(one => one.class === "workspace").map(one => [one.path, one]));
  for (const change of metadata.changes) {
    const entry = entries.get(change.path);
    if (change.carried === "worktree") {
      if (entry?.kind !== "file" || !change.worktree || entry.sha256 !== change.worktree.sha256 || entry.mode !== change.worktree.mode) throw mismatch(change.path);
    } else if (change.carried === "tombstone") {
      if (entry?.kind !== "delete") throw mismatch(change.path);
    } else if (entry !== undefined) throw mismatch(change.path);
  }
}

// ---------------------------------------------------------------------------
// git

/** The environment every git call gets: the process's own with every `GIT_*` taken out, and what a read-only, offline, unprompted call needs put back. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string" && !key.startsWith("GIT_")) env[key] = value;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  // A partial clone's missing object is fetched lazily by git unless told not to.
  env.GIT_NO_LAZY_FETCH = "1";
  env.LC_ALL = "C";
  return env;
}

/**
 * One git call. `label` is a fixed name for the step and is the only thing a
 * failure says: git's own words carry paths and credential-bearing urls.
 * Output past `maxBytes` stops the command.
 */
async function runGit(repo: string, args: string[], maxBytes: number, label: string): Promise<Buffer> {
  const child = (() => {
    try {
      return Bun.spawn(["git", "-C", repo, "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
        "-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never", ...args],
      { env: gitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    } catch { throw new TransferError("repo-git-failed", "spawn"); }
  })();
  const chunks: Uint8Array[] = [];
  let held = 0;
  const reader = child.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    held += value.length;
    if (held > maxBytes) {
      child.kill();
      await child.exited;
      throw new TransferError("repo-git-output", label);
    }
    chunks.push(value);
  }
  if (await child.exited !== 0) throw new TransferError("repo-git-failed", label);
  return Buffer.concat(chunks);
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The scopes git names a config entry's origin by. Keys always hold a dot and no scope does, so the two never read as each other.
const CONFIG_SCOPES = new Set(["system", "global", "local", "worktree", "command", "submodule", "unknown"]);

/**
 * `config --list --show-scope --name-only -z`, as (scope, key) pairs. Every
 * field ends in a NUL, so a tab or any other character inside a subsection can
 * neither split a key nor hide one. (An older git that joins the scope to the
 * key with a tab even under `-z` is read too: no key starts with a scope and a
 * tab.) Anything else is a git this reader does not understand, refused.
 */
function configEntries(buffer: Buffer): { scope: string; key: string }[] {
  const tokens = buffer.toString("utf8").split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const out: { scope: string; key: string }[] = [];
  for (let n = 0; n < tokens.length;) {
    const token = tokens[n];
    const tab = token.indexOf("\t");
    if (CONFIG_SCOPES.has(token) && n + 1 < tokens.length) { out.push({ scope: token, key: tokens[n + 1] }); n += 2; }
    else if (tab > 0 && CONFIG_SCOPES.has(token.slice(0, tab))) { out.push({ scope: token.slice(0, tab), key: token.slice(tab + 1) }); n += 1; }
    else throw new TransferError("repo-git-failed", "config");
  }
  return out;
}

/**
 * A config key that may be said in a refusal: its section and variable names,
 * with any subsection replaced. A subsection is caller text (a url that can
 * hold a password, a path, a remote's name) and is never repeated.
 */
function redactedKey(key: string): string {
  const first = key.indexOf("."), last = key.lastIndexOf(".");
  if (first < 0) return "<key>";
  const word = (part: string) => /^[a-z][a-z0-9-]{0,63}$/i.test(part) ? part.toLowerCase() : "<name>";
  return first === last ? `${word(key.slice(0, first))}.${word(key.slice(last + 1))}` : `${word(key.slice(0, first))}.<subsection>.${word(key.slice(last + 1))}`;
}

/**
 * Refuse a repository whose own config would start a program, or fetch on its
 * own behalf, before any command that could reach it. The program keys are the
 * sync's (`PROGRAM_KEYS`), asked of the repository's own scopes only: a helper
 * the account installed for itself is the account's choice. A partial clone is
 * refused as well, since a missing object there is fetched, and this library
 * never reaches a network. The refusal names the key's section and variable,
 * never a subsection and never a value.
 */
export async function assertSafeConfig(repo: string, maxBytes: number): Promise<void> {
  const listed = await runGit(repo, ["config", "--list", "--show-scope", "--name-only", "--no-includes", "-z"], maxBytes, "config");
  for (const { scope, key } of configEntries(listed)) {
    if (scope !== "local" && scope !== "worktree") continue;
    if (PROGRAM_KEYS.some(pattern => pattern.test(key)) || /^extensions\.partialclone$/i.test(key) || /^remote\..+\.(promisor|partialclonefilter)$/i.test(key)) {
      throw new TransferError("repo-unsafe-config", redactedKey(key));
    }
  }
}

function blobOid(format: "sha1" | "sha256", bytes: Uint8Array): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** A path as git printed it, refused by name unless it is one a bundle can carry. */
function repoPath(path: string): string {
  // A name that was not UTF-8 came through decoding as the replacement character, and is not the name git holds.
  if (path.includes(String.fromCharCode(0xfffd))) throw new TransferError("path-invalid", path);
  assertPath(path);
  if (path === ".imprnt-transfer" || path.startsWith(".imprnt-transfer/")) throw new TransferError("repo-reserved-path", path);
  return path;
}

function records(buffer: Buffer): string[] { return buffer.toString("utf8").split("\0").filter(one => one !== ""); }

/** `ls-tree -r -z`: `<mode> <type> <oid>\t<path>`. */
function parseTree(buffer: Buffer): Map<string, RepoSide> {
  const out = new Map<string, RepoSide>();
  for (const one of records(buffer)) {
    const tab = one.indexOf("\t");
    const [mode, , oid] = one.slice(0, tab).split(" ");
    if (tab < 0 || !OID.test(oid ?? "")) throw new TransferError("repo-git-failed", "ls-tree");
    out.set(repoPath(one.slice(tab + 1)), { mode, oid });
  }
  return out;
}

/** `ls-files -s -z`: `<mode> <oid> <stage>\t<path>`. A conflicted path has entries at stages 1 to 3 and none at 0. */
function parseIndex(buffer: Buffer): { entries: Map<string, RepoSide>; conflicted: string | null } {
  const entries = new Map<string, RepoSide>();
  let conflicted: string | null = null;
  for (const one of records(buffer)) {
    const tab = one.indexOf("\t");
    const [mode, oid, stage] = one.slice(0, tab).split(" ");
    if (tab < 0 || !OID.test(oid ?? "")) throw new TransferError("repo-git-failed", "ls-files");
    const path = repoPath(one.slice(tab + 1));
    if (stage !== "0") conflicted ??= path;
    else entries.set(path, { mode, oid });
  }
  return { entries, conflicted };
}

const same = (a: RepoSide | null, b: RepoSide | null) => a === b || (a !== null && b !== null && a.mode === b.mode && a.oid === b.oid);

/**
 * The paths the index file marks intent-to-add (`git add -N`), read from the
 * file's own bytes: git lists such an entry as the empty blob, exactly as it
 * lists a file really staged empty, and `ls-files -v` does not show the flag.
 * The flag is bit 0x2000 of the extended flags of a version 3 or 4 entry
 * (git's documented index format). This reads the bytes it is given and
 * nothing else, and refuses as `repo-index-state` anything it cannot read
 * with certainty: another version, an entry running off the file, a split
 * or sparse index (whose entries are not all in this file).
 */
export function intentToAddPaths(bytes: Uint8Array, format: "sha1" | "sha256"): string[] {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const hash = format === "sha256" ? 32 : 20;
  const refuse = () => new TransferError("repo-index-state", "index");
  if (data.length < 12 + hash || data.toString("latin1", 0, 4) !== "DIRC") throw refuse();
  const version = data.readUInt32BE(4);
  if (version < 2 || version > 4) throw refuse();
  const count = data.readUInt32BE(8);
  const end = data.length - hash;
  const found: string[] = [];
  let previous: Buffer = Buffer.alloc(0);
  let pos = 12;
  for (let n = 0; n < count; n++) {
    // ten 32-bit stat fields, the object id, then 16 bits of flags (bit 0x4000: 16 more bits of extended flags follow)
    const fixed = 40 + hash;
    if (pos + fixed + 2 > end) throw refuse();
    const flags = data.readUInt16BE(pos + fixed);
    let at = pos + fixed + 2;
    let intent = false;
    if ((flags & 0x4000) !== 0) {
      if (version < 3 || at + 2 > end) throw refuse();
      intent = (data.readUInt16BE(at) & 0x2000) !== 0;
      at += 2;
    }
    let name: Buffer;
    if (version === 4) {
      // A count of bytes to cut from the previous name, then the rest of this one, NUL-terminated.
      let byte = data[at++];
      let cut = byte & 127;
      while ((byte & 128) !== 0) {
        if (at >= end) throw refuse();
        byte = data[at++];
        cut = (cut + 1) * 128 + (byte & 127);
      }
      const nul = data.indexOf(0, at);
      if (nul < 0 || nul >= end || cut > previous.length) throw refuse();
      name = Buffer.concat([previous.subarray(0, previous.length - cut), data.subarray(at, nul)]);
      pos = nul + 1;
    } else {
      // The name and its NULs fill the entry out to a multiple of 8 bytes from its start.
      const nul = data.indexOf(0, at);
      if (nul < 0 || nul >= end) throw refuse();
      name = data.subarray(at, nul);
      pos += (at - pos + name.length + 8) & ~7;
    }
    if (pos > end) throw refuse();
    previous = name;
    if (intent) found.push(name.toString("utf8"));
  }
  // What follows the entries is extensions, each a 4-byte name and a 4-byte length, then the checksum.
  while (pos + 8 <= end) {
    const signature = data.toString("latin1", pos, pos + 4);
    if (signature === "link" || signature === "sdir") throw refuse();
    pos += 8 + data.readUInt32BE(pos + 4);
  }
  if (pos !== end) throw refuse();
  return found;
}

// ---------------------------------------------------------------------------
// working tree

type Worktree =
  | { kind: "file"; mode: number; size: number; sha256: string; oid: string; signature: FileSignature }
  | { kind: "link"; oid: string };

/** What is at `rel` in the working tree, judged without following a link. A link anywhere on the way in is refused by `lstatBelow`. */
function probe(root: string, rel: string): "absent" | "file" | "link" | "other" {
  const slash = rel.lastIndexOf("/");
  if (slash >= 0) {
    try { if (!lstatBelow(root, rel.slice(0, slash)).isDirectory()) return "absent"; } catch (error) {
      if (error instanceof TransferError && error.code === "path-missing") return "absent";
      throw error;
    }
  }
  let stat: Stats;
  try { stat = lstatSync(join(root, rel)); } catch (error) {
    if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR") return "absent";
    throw new TransferError("unreadable", rel);
  }
  return stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : "other";
}

function readWorktree(root: string, rel: string, format: "sha1" | "sha256", scan: ScanBudget): Worktree | null {
  const kind = probe(root, rel);
  if (kind === "absent") return null;
  if (kind === "other") throw new TransferError("special-file", rel);
  if (kind === "link") {
    try { return { kind: "link", oid: blobOid(format, readlinkSync(join(root, rel), "buffer")) }; } catch { throw new TransferError("unreadable", rel); }
  }
  const read = readStable(root, rel, { retain: false, blobFormat: format, scan });
  return { kind: "file", mode: read.mode, size: read.size, sha256: read.sha256, oid: read.gitOid!, signature: read.signature };
}

/**
 * The final pass over one path read earlier: it must be, now, what `before`
 * says it was. A file is read again and must match in content, size, mode and
 * identity (`confirmStable`), not only in its times. Anything else is
 * `source-changed`, except a spent scan budget, which is its own refusal.
 */
function confirmWorktree(root: string, rel: string, format: "sha1" | "sha256", before: Worktree | null, scan: ScanBudget): void {
  const changed = () => new TransferError("source-changed", rel);
  try {
    const kind = probe(root, rel);
    if (before === null) { if (kind !== "absent") throw changed(); return; }
    if (before.kind === "link") {
      const now = kind === "link" ? readWorktree(root, rel, format, scan) : null;
      if (now?.kind !== "link" || now.oid !== before.oid) throw changed();
      return;
    }
    if (kind !== "file") throw changed();
    confirmStable(root, rel, before, { scan });
  } catch (error) {
    if (error instanceof TransferError && error.code === "limit-scan-bytes") throw error;
    throw changed();
  }
}

const sideOf = (wt: Worktree | null): RepoSide | null =>
  wt === null ? null : wt.kind === "link" ? { mode: "120000", oid: wt.oid } : { mode: (wt.mode & 0o100) !== 0 ? "100755" : "100644", oid: wt.oid };

/** Whether a repository path is one this snapshot will not carry unasked: a credential-shaped name, or one inside a credential-shaped directory. */
function secretPath(rel: string): boolean {
  const parts = rel.split("/");
  return credentialShaped(parts[parts.length - 1], false) || parts.slice(0, -1).some(part => credentialShaped(part, true));
}

// ---------------------------------------------------------------------------
// snapshot

// The git directory entries whose presence means an operation is half done.
const OPERATION_STATE = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "sequencer"];

/**
 * Snapshot one repository without changing it: where HEAD is, what the index
 * holds, and every path whose index or working-tree state is not HEAD's, each
 * with its modes and hashes, staged-against-working differences included.
 *
 * The bytes that travel are the working tree's for every path that differs
 * from HEAD (untracked files too), a tombstone for every HEAD file the working
 * tree no longer has, and the index's own blob for every staged path whose
 * staged bytes the working tree does not also hold. A file named by
 * `dependencyFiles` is carried even when git ignores it.
 *
 * A credential-shaped path (its name, or a directory above it) is not swept
 * in. An untracked one is left out and listed in `withheld`. A tracked one
 * whose changed bytes would have to be left out, whether the working file's or
 * a staged blob's, is refused (`repo-withheld`), since a snapshot that dropped
 * them would silently give a destination HEAD's old bytes: it succeeds only
 * when the caller names that exact path in `dependencyFiles`. A deleted
 * tracked one is a tombstone like any other, and an unchanged one is untouched.
 *
 * Refused by name, with nothing recovered or repaired: config that starts a
 * program or fetches, an operation half done, conflicted paths, a submodule
 * or nested repository, a changed or untracked symlink, sparse or
 * assume-unchanged entries, an intent-to-add entry (git lists it as a staged
 * empty blob, and this snapshot cannot yet carry the difference:
 * `repo-index-state`), an unborn HEAD, a special file, a path a bundle cannot
 * carry, anything over the limits.
 *
 * It is consistent or refused, as far as finite reads can say, and it is not
 * an atomic snapshot: HEAD, the branch, the index file's bytes, the untracked
 * list and every working file's identity are read before and after, and every
 * file that contributed (clean ones and carried ones alike) is read again at
 * the end and must match in content, size, mode and identity. Any difference
 * is `source-changed`; a write after that last pass cannot be seen. The caller
 * owns serialisation against a concurrent writer (the sync's lock is keyed on
 * `source.commonDir`), holds the source still while this runs, and revalidates
 * the snapshot at its own checkpoint. `limits.maxScanBytes` bounds all of the
 * reading. A consumer checks a snapshot with `verifySnapshot`.
 */
export async function snapshotRepo(options: RepoSnapshotOptions): Promise<RepoSnapshot> {
  const { limits } = options;
  assertLimits(limits);
  for (const key of ["maxGitOutputBytes", "maxScanBytes"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new TransferError("limits-invalid");
  }
  const scan: ScanBudget = { limit: limits.maxScanBytes, used: 0 };
  const root = resolveRoot(options.repo);
  const git = (args: string[], label: string, max = limits.maxGitOutputBytes) => runGit(root, args, max, label);
  const line = async (args: string[], label: string) => (await git(args, label)).toString("utf8").trim();

  let top: string;
  try { top = realpathSync(await line(["rev-parse", "--show-toplevel"], "toplevel")); } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError("repo-not-toplevel");
  }
  if (top !== root) throw new TransferError("repo-not-toplevel");
  await assertSafeConfig(root, limits.maxGitOutputBytes);

  const gitDir = realpathSync(await line(["rev-parse", "--absolute-git-dir"], "git-dir"));
  const commonDir = realpathSync(await line(["rev-parse", "--path-format=absolute", "--git-common-dir"], "common-dir"));
  for (const name of OPERATION_STATE) if (existsSync(join(gitDir, name))) throw new TransferError("repo-operation", name);

  const deps = new Set<string>();
  for (const one of options.dependencyFiles ?? []) {
    deps.add(repoPath(one));
  }

  /** What must be the same at the end as at the start: HEAD, which branch it is on, the index file's bytes and the untracked list. */
  const state = async () => {
    let head: string;
    try { head = await line(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], "head"); } catch (error) {
      if (error instanceof TransferError && error.code === "repo-git-failed") throw new TransferError("repo-head-unborn");
      throw error;
    }
    if (!OID.test(head)) throw new TransferError("repo-git-failed", "head");
    let branch: string | null = null;
    try {
      const ref = await line(["symbolic-ref", "--quiet", "HEAD"], "branch");
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } catch (error) {
      // Exit 1 is a detached HEAD. A failure to run git at all is not.
      if (!(error instanceof TransferError && error.code === "repo-git-failed" && error.path === "branch")) throw error;
    }
    let indexSha256: string | null = null;
    try { indexSha256 = readStable(gitDir, "index", { retain: false, scan }).sha256; } catch (error) {
      if (!(error instanceof TransferError && error.code === "path-missing")) throw error;
    }
    const untracked = (await git(["ls-files", "-o", "--exclude-standard", "-z"], "untracked")).toString("utf8");
    return { head, branch, indexSha256, untracked };
  };

  const start = await state();
  const format = start.head.length === 64 ? "sha256" : "sha1";

  const head = parseTree(await git(["ls-tree", "-r", "-z", "--full-tree", start.head], "ls-tree"));
  const { entries: index, conflicted } = parseIndex(await git(["ls-files", "-s", "-z"], "ls-files"));
  if (conflicted !== null) throw new TransferError("repo-conflict", conflicted);
  for (const one of [...head, ...index]) if (one[1].mode === "160000") throw new TransferError("repo-submodule", one[0]);
  // `-v` tags a skip-worktree (sparse) entry `S` and an assume-unchanged one in lower case: in both the index does not
  // vouch for the working tree, and neither is a state this snapshot can describe truthfully.
  for (const one of records(await git(["ls-files", "-v", "-z"], "ls-files-flags"))) {
    if (one[0] === "S" || (one[0] >= "a" && one[0] <= "z")) throw new TransferError("repo-index-flags", one.slice(2));
  }
  // An intent-to-add entry reads as a staged empty blob, and so does a file really staged empty: only the index file's
  // own flags tell them apart. They are read only when some entry is the empty blob, from bytes bound to the index
  // hash taken at the start, so an ordinary repository never depends on this parse.
  const empty = blobOid(format, new Uint8Array(0));
  if ([...index.values()].some(side => side.oid === empty)) {
    const read = readStable(gitDir, "index", { retain: true, scan });
    if (read.sha256 !== start.indexSha256) throw new TransferError("source-changed", "index");
    const intent = intentToAddPaths(read.bytes!, format);
    if (intent.length > 0) throw new TransferError("repo-index-state", repoPath(intent.sort(comparePaths)[0]));
  }
  const untracked: string[] = [];
  for (const one of records(Buffer.from(start.untracked))) {
    // An untracked directory that is itself a repository is listed with a trailing slash.
    if (one.endsWith("/")) throw new TransferError("repo-nested", one);
    untracked.push(repoPath(one));
  }

  const paths = [...new Set([...head.keys(), ...index.keys(), ...untracked, ...deps])].sort(comparePaths);
  const seen = new Map<string, Worktree | null>();
  for (const rel of paths) seen.set(rel, readWorktree(root, rel, format, scan));

  const entries: EntryInput[] = [];
  const blobs = new Map<string, Uint8Array>();
  const changes: RepoChange[] = [];
  const withheld: RepoMetadata["withheld"] = [];
  let clean = 0, total = 0;
  const room = () => { if (entries.length + blobs.size >= limits.maxFiles) throw new TransferError("limit-files"); };

  for (const rel of paths) {
    const wt = seen.get(rel)!;
    const h = head.get(rel) ?? null, i = index.get(rel) ?? null, w = sideOf(wt);
    // A dependency the caller named that is nowhere: the dependency check below refuses it by name.
    if (!h && !i && !w) continue;
    const x = same(h, i) ? " " : !h ? "A" : !i ? "D" : "M";
    const y = i === null ? (w ? "?" : " ") : !w ? "D" : same(i, w) ? " " : "M";
    if (x === " " && y === " ") { clean++; continue; }
    // A link can be neither carried nor recreated here, so it may only be left as HEAD has it.
    if ([h, i, w].some(side => side?.mode === "120000")) throw new TransferError("repo-symlink", rel);
    // Naming the exact file is the caller's deliberate choice to carry it.
    const secret = !deps.has(rel) && secretPath(rel);
    let carried: RepoChange["carried"] = "none";
    if (w && !same(w, h)) carried = secret ? "withheld" : "worktree";
    else if (!w && h) carried = "tombstone";
    if (carried === "withheld") {
      // A path HEAD or the index has is not one to leave out quietly: the destination would be given the old bytes.
      if (h || i) throw new TransferError("repo-withheld", rel);
      withheld.push({ path: rel, what: "worktree", reason: "credential-shaped-name" });
    }
    if (carried === "worktree") {
      room();
      const read = readWithinBudget(root, rel, limits, total, { blobFormat: format, scan });
      const before = wt as Extract<Worktree, { kind: "file" }>;
      if (read.sha256 !== before.sha256 || read.mode !== before.mode || !sameSignature(read.signature, before.signature)) throw new TransferError("source-changed", rel);
      total += read.size;
      entries.push({ path: rel, class: "workspace", mode: read.mode, bytes: read.bytes! });
    } else if (carried === "tombstone") { room(); entries.push({ path: rel, class: "workspace", deleted: true }); }

    let indexBlob: RepoChange["indexBlob"];
    if (i && i.oid !== h?.oid && i.oid !== w?.oid) {
      // Staged bytes that only the index holds cannot be left out either.
      if (secret) throw new TransferError("repo-withheld", rel);
      indexBlob = "carried";
      if (!blobs.has(i.oid)) {
        room();
        let bytes: Buffer;
        try { bytes = await git(["cat-file", "blob", i.oid], "cat-file", Math.min(limits.maxFileBytes, limits.maxTotalBytes - total)); } catch (error) {
          if (error instanceof TransferError && error.code === "repo-git-output") throw new TransferError("limit-file-bytes", rel);
          throw error;
        }
        if (blobOid(format, bytes) !== i.oid) throw new TransferError("repo-git-failed", "cat-file");
        total += bytes.length;
        blobs.set(i.oid, bytes);
      }
    }
    changes.push({
      path: rel, status: x + y, head: h, index: i,
      worktree: wt?.kind === "file" ? { mode: wt.mode, size: wt.size, sha256: wt.sha256, oid: wt.oid } : null,
      carried, ...(indexBlob ? { indexBlob } : {}),
    });
  }

  // What the caller said the work needs, each one carried, verified or refused by name.
  const dependencies: RepoMetadata["dependencies"] = [];
  for (const rel of [...deps].sort(comparePaths)) {
    const wt = seen.get(rel) ?? null;
    if (wt === null) throw new TransferError("dependency-missing", rel);
    if (wt.kind === "link") throw new TransferError("repo-symlink", rel);
    const change = changes.find(one => one.path === rel);
    if (change?.carried === "worktree") { dependencies.push({ path: rel, state: "carried", mode: wt.mode, size: wt.size, sha256: wt.sha256 }); continue; }
    // A named file git ignores is neither in HEAD nor the index, so the loop above already carried it like an untracked one.
    // What is left here is a file HEAD has byte for byte, which the destination gets from HEAD.
    if (!same(head.get(rel) ?? null, sideOf(wt))) throw new TransferError("repo-git-failed", "dependency");
    dependencies.push({ path: rel, state: "tracked-clean", mode: wt.mode, size: wt.size, sha256: wt.sha256 });
  }
  for (const [oid, bytes] of blobs) entries.push({ path: `${INDEX_BLOB_PREFIX}${oid}`, class: "workspace", mode: 0o644, bytes });

  // The same repository, or nothing: HEAD, the branch, the index file's bytes and the untracked list as they were, and then
  // every path read as it was, clean files and carried files alike, by content and not by stat alone.
  await options.observe?.afterReads?.();
  const end = await state();
  if (end.head !== start.head || end.branch !== start.branch || end.indexSha256 !== start.indexSha256 || end.untracked !== start.untracked) {
    throw new TransferError("source-changed");
  }
  for (const [rel, wt] of seen) confirmWorktree(root, rel, format, wt, scan);

  const bundle = buildBundle(entries, limits, { base: { id: `git:${format}:${start.head}` } });
  const metadata: RepoMetadata = {
    version: 1, objectFormat: format, head: start.head, branch: start.branch, bundleDigest: bundle.manifest.digest, indexSha256: start.indexSha256,
    tracked: index.size, clean, changes, dependencies, withheld,
  };
  return { metadata, metadataDigest: metadataDigestOf(metadata), bundle, source: { root, gitDir, commonDir } };
}

/**
 * The destination's precondition for using a revision: that its own object
 * store already holds that commit. A revision that is not there blocks the
 * transfer by name. It is never fetched: no command here contacts a remote,
 * and lazy fetching is turned off for the one that could.
 */
export async function requireLocalRevision(options: { repo: string; revision: string; maxGitOutputBytes: number }): Promise<void> {
  if (typeof options.revision !== "string" || !OID.test(options.revision)) throw new TransferError("repo-revision-invalid");
  if (!Number.isSafeInteger(options.maxGitOutputBytes) || options.maxGitOutputBytes < 0) throw new TransferError("limits-invalid");
  const root = resolveRoot(options.repo);
  let top: string;
  try { top = realpathSync((await runGit(root, ["rev-parse", "--show-toplevel"], options.maxGitOutputBytes, "toplevel")).toString("utf8").trim()); } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError("repo-not-toplevel");
  }
  if (top !== root) throw new TransferError("repo-not-toplevel");
  await assertSafeConfig(root, options.maxGitOutputBytes);
  try { await runGit(root, ["cat-file", "-e", `${options.revision}^{commit}`], options.maxGitOutputBytes, "revision"); } catch (error) {
    if (error instanceof TransferError && error.code === "repo-git-failed") throw new TransferError("repo-revision-missing", options.revision);
    throw error;
  }
}
