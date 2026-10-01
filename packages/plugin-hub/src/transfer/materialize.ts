import { randomBytes } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync,
  symlinkSync, unlinkSync, type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assertDistinct, assertLimits, comparePaths, contentKey, exactKeys, pathProblem, sha256Hex, TransferError } from "./bundle.ts";
import {
  assertSafeConfig, blobOid, configEntries, INDEX_BLOB_PREFIX, metadataDigestOf, OID, parseIndex, parseTree, runGit, snapshotRepo, verifySnapshot,
  type GitCall, type RepoChange, type RepoLimits, type RepoMetadata, type RepoSide, type RepoSnapshot,
} from "./repos.ts";
import { errnoOf, isMade, madeOf, resolveRoot, writeExclusive, type Made } from "./workspace.ts";

/**
 * Materialising a snapshot of one repository into a NEW directory this call
 * owns, from the ONE existing repository the caller selected as the
 * destination, and from nothing else.
 *
 * What a returned repository is. A self-contained git repository at
 * `<destination>/repo`: HEAD's whole reachable history and every object of the
 * final index are in its own object database. There are no alternates, no
 * hardlinks into another object store, no shallow file and no deferred detach
 * or repack step, so pruning, collecting or deleting the selected repository
 * (or the source) later cannot break it. Its HEAD, branch (or detached state),
 * index entries (mode, object id and path, stage 0) and working files are the
 * snapshot's, and nothing else is: no remote, hook, credential or config of the
 * source or the destination is copied, and no branch, tag or history beyond
 * HEAD's own.
 *
 * Where everything comes from. The snapshot's bytes (changed, staged,
 * untracked and carried files, and the index blobs no file holds) are the
 * caller's own buffers. HEAD's history and tree come from the selected
 * repository through `pack-objects --stdout --revs` of HEAD alone (no `--all`,
 * no `--thin`), kept in memory under `maxObjectBytes` and then indexed into the
 * new repository by `index-pack --stdin`. A clean file's bytes are read back
 * from the NEW repository, one bounded batch at a time, never from the source
 * path (which is never opened) and never through a filter. A staged object
 * that HEAD's tree does not hold is written from the snapshot's verified bytes
 * with `hash-object -w --no-filters`, and an index entry whose object is
 * neither in HEAD's tree nor carried is refused (`repo-object-missing`). The
 * snapshot's index blobs live only inside the object database: they never
 * become project files.
 *
 * What is refused before anything is created (all of it happens while the
 * destination path does not yet exist): a snapshot that is not one genuine
 * pair, or whose bundle holds an entry no change names; a destination that is
 * not a top-level repository, has a partial-clone or program-starting config,
 * another object format, no such commit, a shallow file, grafts, replace refs,
 * a compatibility hash or an `objects/info/alternates` or `http-alternates` file
 * of its common directory (`repo-history-unsupported`, `repo-object-format`; the
 * alternates case is a shared or reference clone, deliberately not supported here: the
 * file's presence is all that is looked at, its paths are never read or
 * followed, and it is refused before any command that resolves or copies an
 * object runs); a
 * missing tree, blob or history object (`repo-object-missing`, which is never
 * a budget error); a branch name git cannot hold; two paths that fold to one or
 * a file that is also a directory; a submodule; and every bound the plan can
 * already be measured against. Nothing is fetched, lazily or otherwise.
 *
 * Bounds, all explicit and finite, all the caller's. `maxObjectBytes` bounds
 * the pack kept in memory (transiently about twice over while it is joined
 * into one buffer), `limit-object-bytes` when a history is larger: a copy that
 * does not fit is refused, never truncated. The pack's object count, and every
 * directory entry this call owns (`.git` and the working tree), are bounded by
 * `maxEntries`. `maxOutputBytes` bounds every byte this call writes: working
 * files and link targets, the pack and its index, loose objects, the index file
 * and the marker. It is charged from measured sizes before creation and from
 * what is on disk before the marker is completed. A single git command's output
 * is bounded by `maxGitOutputBytes`; there are no unbounded files, queues or
 * stderr (stderr is not read at all).
 *
 * What git is allowed. Every call clears inherited `GIT_*`, and turns off hooks,
 * fsmonitor, the ext and fd transports and lazy fetching. Every call here also
 * reads no system or global config, no attribute file and no home, and does no
 * garbage collection, maintenance, reflog or bitmap (`GitCall.isolated`, fixed
 * inside the library: there is no way to pass an environment or a `-c`). The
 * repository is created with an empty template, so it has no hooks and no
 * `info/exclude`, and its config is read back: any system or global entry
 * refuses. Commands run in the selected repository are `rev-parse`,
 * `for-each-ref`, `config --list`, `cat-file` (`-e`, `--batch-check`), `ls-tree`,
 * `rev-list` and `pack-objects --stdout`, which write nothing there: no object
 * is freshened, no ref, config or index is touched. No checkout, filter,
 * commit, fetch, rebase or push is ever run, so `.gitattributes` in the tree
 * starts nothing.
 *
 * Ownership follows the staging contract (workspace.ts). A directory, file or
 * link is removed only if this call made it, and only as the same object
 * (device, inode, and for a file or link size and times). Files made by a git
 * call are claimed only after that call succeeded, by reading `.git` back at a
 * checkpoint (after `init`, after `index-pack`, after each loose object, and
 * after the objects, the index and each ref write); what a failed git call left
 * behind is unrecorded, so it is left where it is and named `stage-ambiguous`,
 * with nothing removed on a guess. A checkpoint never adopts what was already
 * there: before every git call that writes in `.git`, `.git` is compared, path
 * for path and object for object, with what the last checkpoint recorded, and a
 * file added, replaced or gone since (by an observer, a person, another
 * process) is `stage-ambiguous` before that call runs. The recorded inventory
 * stays as it was, so a rollback removes only what it names and leaves the rest.
 * The read-only verification that follows the last checkpoint writes nothing in
 * `.git` either, so before the marker is completed `.git` is compared with the
 * record once more, and a difference is refused the same way. The marker is
 * held to the same rule: it is written only where nothing is, and replaced
 * only while the path is still the regular file this call wrote and settled
 * (full identity, ctime included), else it is `stage-ambiguous` naming the
 * marker and the changed file is left with its bytes. The
 * completed marker lists every owned object with its identity, bounded by the
 * count and by the path bytes, and is what a retry, a reuse and a discard check
 * the directory against. The caller serialises every call on one destination;
 * nothing here claims an atomic filesystem snapshot.
 *
 * Fidelity limits, named. A changed file keeps its exact permission bits, and
 * so does a tracked clean file the caller named as a dependency: the snapshot
 * records its mode, size and hash, the exec bit must agree with HEAD's tree and
 * the bytes are held to that hash, else `snapshot-mismatch`. Any other clean
 * file keeps only its executable bit (the metadata carries no more). The
 * index's entries are the snapshot's exactly; its file bytes, version and
 * stat data are not, so `indexSha256` is not compared and git re-hashes the
 * files once. The index carries no stat data, so an ordinary `git status` or
 * `git diff` in the new repository may refresh it and rewrite `.git/index`
 * (not only a commit): from then on the marker's identity for that file is
 * stale and `discardMaterialized` answers `stage-ambiguous`, removing nothing.
 * Withheld untracked files are not carried and are returned. The
 * source's local config, `info/exclude`, remotes, refs other than HEAD's and
 * its reflogs are not carried.
 */

export interface MaterializeLimits extends RepoLimits {
  /** The most bytes this call may write in all: working files and link targets, the pack and its index, loose objects, the index file and the marker. */
  maxOutputBytes: number;
  /** The most bytes of pack the history copy may take. A history that needs more is refused (`limit-object-bytes`), never truncated. */
  maxObjectBytes: number;
  /** The most objects the history may hold, and the most files, directories and links this call may own under the destination (`limit-entries`). */
  maxEntries: number;
}

export type MaterializeStep = "init" | "pack" | "objects" | "worktree" | "index" | "refs";

export interface MaterializeOptions {
  snapshot: Pick<RepoSnapshot, "metadata" | "metadataDigest" | "bundle">;
  /** Absolute top level of the ONE selected destination repository. Read, never written; must hold the snapshot's HEAD commit. */
  destinationRepo: string;
  /** Absolute. Must not exist, its parent must; it is made with mode 0700 and holds the marker and `repo/`. */
  destination: string;
  /** The caller's name for this operation, 1 to 128 of letters, digits and `._:-`. Kept in the marker and required again to reuse it. */
  operation: string;
  limits: MaterializeLimits;
  /** Called after each step's files are recorded (`pack`: the history's pack and its sidecars, before any loose object). Production callers pass nothing; a test passes a thrower or a writer. */
  observe?: { afterStep?: (step: MaterializeStep) => void };
}

/** What a caller keeps to reuse or discard exactly this materialisation later. */
export interface MaterializeReceipt {
  /** The real path the materialisation was made at. */
  destination: string;
  /** `destination` + `/repo`. */
  repo: string;
  operation: string;
  /** Fresh for every materialisation this library starts, read back from the marker when one is reused. */
  generation: string;
  root: { dev: number; ino: number };
  metadataDigest: string;
  head: string;
  /** Files, directories and links the marker lists: the most it may list. */
  entries: number;
  /** The most bytes the marker may take, from its listed paths as they serialise. Discard reads no more than this. */
  markerBytes: number;
}

export interface MaterializeResult {
  repo: string;
  head: string;
  branch: string | null;
  /** Regular working files written. */
  files: number;
  /** Symbolic links written (clean links HEAD has, left as they are). */
  links: number;
  /** Untracked files the snapshot did not carry, by name. */
  withheld: RepoMetadata["withheld"];
  reused: boolean;
  receipt: MaterializeReceipt;
}

// ---------------------------------------------------------------------------
// names, constants

const OPERATION = /^[A-Za-z0-9._:-]{1,128}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MARKER = ".imprnt-materialize.json";
const MARKER_TMP = `${MARKER}.tmp`;
const REPO = "repo";
const GIT = `${REPO}/.git`;
const ISOLATED: GitCall = { isolated: true };

const MODE_FILE = "100644";
const MODE_EXEC = "100755";
const MODE_LINK = "120000";

/** The bytes of clean blobs read back in one `cat-file --batch`, and the most files in one batch. A single larger blob is a batch of its own, bounded by `maxFileBytes`. */
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_FILES = 2000;
/** A link's target is a path: no operating system takes more than this. */
const MAX_LINK_BYTES = 4096;

/** What `git init` with an empty template is given to write beside its objects (config, HEAD, refs), with room to spare. */
const SKELETON_BYTES = 4096;
/** The most `.git` entries a fresh repository holds before any object of ours is written (directories, HEAD, config, refs, the index, the pack and its sidecars), with room to spare. */
const GIT_BASE_ENTRIES = 64;
/** A path inside `.git` that git makes: `objects/ab/<62 hex>` is the longest, and this is well past it. */
const GIT_PATH_JSON_BYTES = 200;

// The marker's bounds are worked out from its listed paths alone, as staging's are, and every reader holds it to them.
const MARKER_FIXED_BYTES = 4096;
/** An entry's evidence beyond its path: its keys, separators and five JSON numbers, each at most 24 characters (32 allowed). */
const EVIDENCE_BYTES = 256;
/** A working path is at most 1024 bytes, and `repo/` precedes it. */
const MAX_OWNED_PATH = 1100;
/** An owned path serialised: every byte at most doubles (escapes), plus the quotes. */
const MAX_PATH_JSON_BYTES = 2 * MAX_OWNED_PATH + 2;

const pathJsonBytes = (path: string): number => Buffer.byteLength(JSON.stringify(path));

function markerBytesFor(paths: readonly string[]): number {
  let bytes = MARKER_FIXED_BYTES;
  for (const path of paths) bytes += pathJsonBytes(path) + 1 + EVIDENCE_BYTES;
  return bytes;
}

/** The most a marker of `entries` owned objects can take, whatever their paths. */
function markerBytesMost(entries: number): number { return MARKER_FIXED_BYTES + entries * (MAX_PATH_JSON_BYTES + 1 + EVIDENCE_BYTES); }

type Format = "sha1" | "sha256";
const hashBytes = (format: Format): number => format === "sha256" ? 32 : 20;
const hashHex = (format: Format): number => 2 * hashBytes(format);

/** Whether anything is at `path`, a dangling link included, and without following a link. An error other than "not there" counts as there. */
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { return errnoOf(error) !== "ENOENT" && errnoOf(error) !== "ENOTDIR"; }
}

const isUnder = (path: string, tree: string): boolean => path === tree || path.startsWith(`${tree}/`);
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);

function assertMaterializeLimits(limits: MaterializeLimits): void {
  assertLimits(limits);
  for (const key of ["maxGitOutputBytes", "maxScanBytes", "maxOutputBytes", "maxObjectBytes", "maxEntries"] as const) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 0) throw new TransferError("limits-invalid");
  }
}

// Characters HFS+ ignores when it compares names: `.git` with one of them inside is `.git` there.
const IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** A path this library writes itself, refused by name unless it is one a checkout could write safely: nothing that is, or could read as, `.git`. */
function checkPath(path: string): void {
  const problem = pathProblem(path);
  if (problem) throw new TransferError(problem, path);
  if (path === ".imprnt-transfer" || path.startsWith(".imprnt-transfer/")) throw new TransferError("repo-reserved-path", path);
  for (const part of path.split("/")) {
    const folded = part.replace(IGNORABLE, "").toLowerCase();
    if (folded === ".git" || folded === "git~1") throw new TransferError("path-reserved", path);
  }
}

function isPermission(mode: unknown): mode is number {
  return typeof mode === "number" && Number.isInteger(mode) && mode >= 0 && mode <= 0o777 && (mode & 0o400) !== 0;
}

function directoriesOf(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) dirs.add(dir);
  return [...dirs].sort(comparePaths);
}

// ---------------------------------------------------------------------------
// the plan: what the new repository must hold, worked out from verified bytes and one tree

interface Planned {
  path: string;
  kind: "file" | "link";
  /** Permission bits of a file. */
  mode: number;
  oid: string;
  /** Known at once for carried bytes, from the repository's own answer for a blob it holds (-1 until then). */
  size: number;
  /** The snapshot's bytes, or null when the bytes are HEAD's blob, read back from the new repository. */
  bytes: Uint8Array | null;
  /** What the bytes must hash to, when the metadata says so. */
  sha256: string | null;
}

interface Plan {
  head: string;
  branch: string | null;
  format: Format;
  /** The final index: path to mode and object id, stage 0. */
  index: Map<string, RepoSide>;
  /** The final working tree, in path byte order. */
  files: Planned[];
  dirs: string[];
  /** Objects the index needs that HEAD's tree does not hold, with the verified bytes they are written from. */
  toWrite: Map<string, Uint8Array>;
  /** The bytes of every working file and link target. */
  outputBytes: number;
}

const sameSide = (a: RepoSide | null, b: RepoSide | null): boolean => a === b || (a !== null && b !== null && a.mode === b.mode && a.oid === b.oid);

/** `cat-file --batch-check` in `repo`: what each object is, and absent from the map when it is missing. */
async function checkObjects(repo: string, oids: readonly string[], format: Format): Promise<Map<string, { type: string; size: number }>> {
  const found = new Map<string, { type: string; size: number }>();
  if (oids.length === 0) return found;
  const out = await runGit(repo, ["cat-file", "--batch-check"], oids.length * (hashHex(format) + 48) + 64, "cat-file",
    { ...ISOLATED, stdin: Buffer.from(`${oids.join("\n")}\n`) });
  const lines = out.toString("utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== oids.length) throw new TransferError("repo-git-failed", "cat-file");
  for (const [n, line] of lines.entries()) {
    const parts = line.split(" ");
    if (parts[0] !== oids[n]) throw new TransferError("repo-git-failed", "cat-file");
    if (parts.length === 2 && parts[1] === "missing") continue;
    if (parts.length !== 3 || !/^[0-9]{1,16}$/.test(parts[2])) throw new TransferError("repo-git-failed", "cat-file");
    found.set(oids[n], { type: parts[1], size: Number(parts[2]) });
  }
  return found;
}

/**
 * Blobs read back from `repo` by `cat-file --batch`, which applies no filter, in
 * one bounded command: its output cannot exceed the sizes already asked for.
 * Each blob is held to its object id, so a wrong byte is refused by name.
 */
async function readBlobs(repo: string, wanted: readonly Planned[], format: Format): Promise<Map<string, Buffer>> {
  const got = new Map<string, Buffer>();
  const bound = wanted.reduce((sum, one) => sum + one.size + hashHex(format) + 40, 64);
  const out = await runGit(repo, ["cat-file", "--batch"], bound, "cat-file", { ...ISOLATED, stdin: Buffer.from(`${wanted.map(one => one.oid).join("\n")}\n`) });
  let pos = 0;
  for (const one of wanted) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) throw new TransferError("repo-git-failed", "cat-file");
    const header = out.toString("latin1", pos, nl).split(" ");
    if (header.length === 2 && header[0] === one.oid && header[1] === "missing") throw new TransferError("repo-object-missing", one.path);
    if (header.length !== 3 || header[0] !== one.oid || header[1] !== "blob" || header[2] !== String(one.size)) throw new TransferError("materialize-verify", one.path);
    const bytes = out.subarray(nl + 1, nl + 1 + one.size);
    if (bytes.length !== one.size || out[nl + 1 + one.size] !== 0x0a) throw new TransferError("materialize-verify", one.path);
    if (blobOid(format, bytes) !== one.oid) throw new TransferError("materialize-verify", one.path);
    got.set(one.oid, bytes);
    pos = nl + one.size + 2;
  }
  return got;
}

/**
 * What the new repository must hold, read from `treeRepo`'s tree at the
 * snapshot's HEAD: the repository's HEAD tree (the selected one before
 * creation, the new one when a finished materialisation is checked again). The
 * snapshot's own claims are checked against the bytes the bundle holds and
 * against that tree before any of it is used; every disagreement is
 * `snapshot-mismatch`, naming the path.
 */
async function buildPlan(snapshot: Pick<RepoSnapshot, "metadata" | "bundle">, limits: MaterializeLimits, treeRepo: string): Promise<Plan> {
  const { metadata, bundle } = snapshot;
  const mismatch = (part: string) => new TransferError("snapshot-mismatch", part);
  const format = metadata.objectFormat;
  if (format !== "sha1" && format !== "sha256") throw new TransferError("repo-object-format");

  // Every bundle entry is a file a change carries, a deletion a change names, or an index blob under its own object id.
  const carried = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
  const deletions = new Set<string>();
  for (const entry of bundle.manifest.entries) {
    if (entry.class !== "workspace") throw mismatch(entry.path);
    if (entry.kind === "delete") { deletions.add(entry.path); continue; }
    const bytes = bundle.contents.get(contentKey(entry.class, entry.path));
    if (bytes === undefined) throw mismatch(entry.path);
    if (entry.path.startsWith(INDEX_BLOB_PREFIX)) {
      const oid = entry.path.slice(INDEX_BLOB_PREFIX.length);
      if (!OID.test(oid) || oid.length !== hashHex(format) || blobOid(format, bytes) !== oid) throw mismatch(entry.path);
      blobs.set(oid, bytes);
    } else carried.set(entry.path, bytes);
  }

  const changed = new Map<string, RepoChange>();
  for (const change of metadata.changes) {
    if (changed.has(change.path)) throw mismatch(change.path);
    checkPath(change.path);
    changed.set(change.path, change);
  }
  const claimed = new Set<string>();
  const indexBlobs = new Set<string>();
  for (const change of changed.values()) {
    if (change.carried === "worktree") {
      const bytes = carried.get(change.path);
      const wt = change.worktree;
      if (bytes === undefined || !wt || bytes.length !== wt.size || blobOid(format, bytes) !== wt.oid || wt.sha256 !== sha256Hex(bytes)) throw mismatch(change.path);
      claimed.add(change.path);
    } else if (change.carried === "tombstone") {
      if (!change.head || !deletions.has(change.path)) throw mismatch(change.path);
    } else if (change.carried === "withheld") {
      // A path HEAD or the index has is never left out quietly (the snapshot refuses it), so a claim that one was is not a snapshot.
      if (change.head !== null || change.index !== null) throw mismatch(change.path);
    } else if (change.carried !== "none") throw mismatch(change.path);
    if (change.indexBlob === "carried") {
      if (!change.index || !blobs.has(change.index.oid)) throw mismatch(change.path);
      indexBlobs.add(change.index.oid);
    } else if (change.indexBlob !== undefined) throw mismatch(change.path);
  }
  for (const path of carried.keys()) if (!claimed.has(path)) throw mismatch(path);
  for (const oid of blobs.keys()) if (!indexBlobs.has(oid)) throw mismatch(`${INDEX_BLOB_PREFIX}${oid}`);
  for (const path of deletions) if (changed.get(path)?.carried !== "tombstone") throw mismatch(path);

  // HEAD's tree. A tree that cannot be read is an object the destination does not hold.
  let listed: Buffer;
  try { listed = await runGit(treeRepo, ["ls-tree", "-r", "-z", "--full-tree", metadata.head], limits.maxGitOutputBytes, "ls-tree", ISOLATED); } catch (error) {
    if (error instanceof TransferError && error.code === "repo-git-failed") throw new TransferError("repo-object-missing", "tree");
    throw error;
  }
  const tree = parseTree(listed);
  const treeOids = new Set<string>();
  for (const [path, side] of tree) {
    if (side.mode === "160000") throw new TransferError("repo-submodule", path);
    if (side.mode !== MODE_FILE && side.mode !== MODE_EXEC && side.mode !== MODE_LINK) throw new TransferError("mode-unsupported", path);
    if (side.oid.length !== hashHex(format)) throw new TransferError("repo-object-format", path);
    checkPath(path);
    treeOids.add(side.oid);
  }
  for (const change of changed.values()) if (!sameSide(tree.get(change.path) ?? null, change.head)) throw mismatch(change.path);
  let withHead = 0;
  for (const change of changed.values()) if (change.head !== null) withHead++;
  if (tree.size - withHead !== metadata.clean) throw mismatch("clean");

  // The dependencies the caller named, each one held to what the tree and the changes say of its path. A tracked-clean one is written with the
  // mode and bytes the metadata records (the metadata digest covers them), so the exec bit must agree with the tree's and nothing is normalised away.
  if (!Array.isArray(metadata.dependencies)) throw mismatch("dependencies");
  const dependencies = new Map<string, RepoMetadata["dependencies"][number]>();
  for (const raw of metadata.dependencies as unknown[]) {
    const dep: unknown = raw;
    if (!isRecord(dep) || typeof dep.path !== "string") throw mismatch("dependencies");
    if (dependencies.has(dep.path) || !exactKeys(dep, ["path", "state", "mode", "size", "sha256"]) || (dep.state !== "carried" && dep.state !== "tracked-clean") ||
        !isPermission(dep.mode) || !isWhole(dep.size) || typeof dep.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(dep.sha256)) throw mismatch(dep.path);
    dependencies.set(dep.path, dep as RepoMetadata["dependencies"][number]);
  }
  for (const dep of dependencies.values()) {
    const change = changed.get(dep.path);
    const wt = change?.worktree ?? null;
    const execBit = (dep.mode & 0o100) !== 0;
    if (dep.state === "carried") {
      if (change?.carried !== "worktree" || !wt || wt.mode !== dep.mode || wt.size !== dep.size || wt.sha256 !== dep.sha256) throw mismatch(dep.path);
    } else if (change) {
      // HEAD's own bytes in the working tree, with only the index differing: the change is the file, and it must say what the dependency says.
      if (change.carried !== "none" || !wt || !change.head || change.head.mode === MODE_LINK || wt.mode !== dep.mode || wt.size !== dep.size || wt.sha256 !== dep.sha256 ||
          (change.head.mode === MODE_EXEC) !== execBit) throw mismatch(dep.path);
    } else {
      const side = tree.get(dep.path);
      if (!side || (side.mode !== MODE_FILE && side.mode !== MODE_EXEC) || (side.mode === MODE_EXEC) !== execBit) throw mismatch(dep.path);
    }
  }

  // The final index: HEAD's tree, each change applied.
  const index = new Map<string, RepoSide>(tree);
  for (const change of changed.values()) {
    if (change.index === null) { index.delete(change.path); continue; }
    if ((change.index.mode !== MODE_FILE && change.index.mode !== MODE_EXEC) || !OID.test(change.index.oid) || change.index.oid.length !== hashHex(format)) {
      throw new TransferError("mode-unsupported", change.path);
    }
    index.set(change.path, { mode: change.index.mode, oid: change.index.oid });
  }
  if (index.size !== metadata.tracked) throw mismatch("tracked");

  // The final working tree.
  const files: Planned[] = [];
  for (const [path, side] of tree) {
    if (changed.has(path)) continue;
    if (side.mode === MODE_LINK) { files.push({ path, kind: "link", mode: 0o777, oid: side.oid, size: -1, bytes: null, sha256: null }); continue; }
    // A named dependency keeps the mode, size and bytes hash the source recorded for it (validated above); any other clean file keeps the exec bit only.
    const dep = dependencies.get(path);
    files.push(dep
      ? { path, kind: "file", mode: dep.mode, oid: side.oid, size: dep.size, bytes: null, sha256: dep.sha256 }
      : { path, kind: "file", mode: side.mode === MODE_EXEC ? 0o755 : 0o644, oid: side.oid, size: -1, bytes: null, sha256: null });
  }
  for (const change of changed.values()) {
    const wt = change.worktree;
    if (change.carried === "worktree") {
      const bytes = carried.get(change.path)!;
      if (!isPermission(wt!.mode)) throw new TransferError("mode-unsupported", change.path);
      files.push({ path: change.path, kind: "file", mode: wt!.mode, oid: wt!.oid, size: bytes.length, bytes, sha256: wt!.sha256 });
    } else if (change.carried === "none" && wt) {
      // The working file is HEAD's own bytes (git saw no difference), while the index holds something else or nothing.
      if (!change.head || change.head.oid !== wt.oid || change.head.mode === MODE_LINK || !isPermission(wt.mode) || !isWhole(wt.size)) throw mismatch(change.path);
      files.push({ path: change.path, kind: "file", mode: wt.mode, oid: wt.oid, size: wt.size, bytes: null, sha256: wt.sha256 });
    }
  }
  files.sort((a, b) => comparePaths(a.path, b.path));
  assertDistinct(files.map(one => ({ scope: "worktree", path: one.path })));
  assertDistinct([...index.keys()].map(path => ({ scope: "index", path })));

  // What the repository holds of the blobs HEAD's tree names: present, blobs, and their sizes.
  const held = await checkObjects(treeRepo, [...new Set(files.filter(one => one.bytes === null).map(one => one.oid))], format);
  let outputBytes = 0;
  for (const one of files) {
    if (one.bytes === null) {
      const found = held.get(one.oid);
      if (!found || found.type !== "blob") throw new TransferError("repo-object-missing", one.path);
      if (one.size >= 0 && one.size !== found.size) throw mismatch(one.path);
      one.size = found.size;
    }
    if (one.kind === "link" ? one.size < 1 || one.size > MAX_LINK_BYTES : one.size > limits.maxFileBytes) {
      throw new TransferError(one.kind === "link" ? "repo-symlink" : "limit-file-bytes", one.path);
    }
    outputBytes += one.size;
  }

  // Objects the index needs that HEAD's tree does not hold are written from bytes the snapshot carries, or the index is refused.
  const byOid = new Map<string, Uint8Array>(blobs);
  for (const one of files) if (one.bytes !== null && one.kind === "file") byOid.set(one.oid, one.bytes);
  const toWrite = new Map<string, Uint8Array>();
  for (const [path, side] of index) {
    if (treeOids.has(side.oid) || toWrite.has(side.oid)) continue;
    const bytes = byOid.get(side.oid);
    if (!bytes) throw new TransferError("repo-object-missing", path);
    toWrite.set(side.oid, bytes);
  }
  return { head: metadata.head, branch: metadata.branch, format, index, files, dirs: directoriesOf(files.map(one => one.path)), toWrite, outputBytes };
}

// ---------------------------------------------------------------------------
// the selected repository: read-only checks, and the history

interface Source { plan: Plan; pack: Buffer | null; objects: number }

/**
 * `rev-list --objects` of HEAD in `repo`: the ids of every object reachable, each once. Output past what `maxEntries` objects can print
 * is `limit-entries`. A missing commit or tree makes the command fail; a missing blob need not, so a caller that must know
 * every one is there asks `missingFrom` about the ids as well.
 */
async function closure(repo: string, head: string, format: Format, limits: MaterializeLimits): Promise<string[]> {
  let out: Buffer;
  try {
    out = await runGit(repo, ["rev-list", "--objects", head], limits.maxEntries * (hashHex(format) + 2 + 1024) + 4096, "rev-list", ISOLATED);
  } catch (error) {
    if (error instanceof TransferError && error.code === "repo-git-output") throw new TransferError("limit-entries", "objects");
    throw error;
  }
  const oids: string[] = [];
  for (const line of out.toString("latin1").split("\n")) {
    if (line === "") continue;
    const oid = line.slice(0, hashHex(format));
    if (!OID.test(oid)) throw new TransferError("repo-git-failed", "rev-list");
    oids.push(oid);
  }
  return oids;
}

/** The first of `oids` that `repo` does not hold, or null. */
async function missingFrom(repo: string, oids: readonly string[], format: Format): Promise<string | null> {
  const found = await checkObjects(repo, oids, format);
  return oids.find(oid => !found.has(oid)) ?? null;
}

function packCount(pack: Buffer, format: Format): number {
  if (pack.length < 12 + hashBytes(format) || pack.toString("latin1", 0, 4) !== "PACK" || pack.readUInt32BE(4) !== 2) throw new TransferError("repo-git-failed", "pack-objects");
  return pack.readUInt32BE(8);
}

/**
 * Everything read from the selected repository, all of it before anything is
 * created. The repository is read only through commands that write nothing
 * there, each with the isolated mode, and the history is refused rather than
 * copied unfaithfully: shallow, grafted, replaced and compatibility-hash
 * repositories are named, a missing object is `repo-object-missing`, and a pack
 * over `maxObjectBytes` or more objects than `maxEntries` is a budget refusal.
 */
async function readDestination(options: MaterializeOptions, target: string): Promise<Source> {
  const { snapshot, limits } = options;
  const { metadata } = snapshot;
  const root = resolveRoot(options.destinationRepo);
  const git = (args: string[], label: string, max = limits.maxGitOutputBytes) => runGit(root, args, max, label, ISOLATED);
  const line = async (args: string[], label: string) => (await git(args, label)).toString("utf8").trim();

  let top: string;
  try { top = realpathSync(await line(["rev-parse", "--show-toplevel"], "toplevel")); } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError("repo-not-toplevel");
  }
  if (top !== root) throw new TransferError("repo-not-toplevel");
  await assertSafeConfig(root, limits.maxGitOutputBytes, ISOLATED);
  if (await line(["rev-parse", "--show-object-format"], "object-format") !== metadata.objectFormat) throw new TransferError("repo-object-format");
  const commonDir = realpathSync(await line(["rev-parse", "--path-format=absolute", "--git-common-dir"], "common-dir"));
  // A directory inside the selected repository, or around it, would write into it (or be removed with it).
  if (isUnder(target, root) || isUnder(root, target) || isUnder(target, commonDir) || isUnder(commonDir, target)) throw new TransferError("destination-invalid");

  // An object store that reaches into another one (a shared or reference clone) is read through to that other store by every command that
  // resolves or packs objects, which is not "the selected repository and nothing else". Its mere presence is refused, before any such command
  // runs: no path in it is parsed, followed or read. A linked worktree's ordinary common directory has neither file and is not affected.
  for (const name of ["alternates", "http-alternates"]) {
    if (exists(join(commonDir, "objects", "info", name))) throw new TransferError("repo-history-unsupported", "alternates");
  }

  // A history that does not copy as it is: its missing parents, rewritten parents and replaced objects are not what a pack of HEAD carries.
  if (existsSync(join(commonDir, "shallow")) || await line(["rev-parse", "--is-shallow-repository"], "shallow") !== "false") {
    throw new TransferError("repo-history-unsupported", "shallow");
  }
  if (existsSync(join(commonDir, "info", "grafts"))) throw new TransferError("repo-history-unsupported", "grafts");
  if ((await git(["for-each-ref", "--count=1", "--format=%(refname)", "refs/replace/"], "replace")).length > 0) throw new TransferError("repo-history-unsupported", "replace");
  for (const { scope, key } of configEntries(await git(["config", "--list", "--show-scope", "--name-only", "--no-includes", "-z"], "config"))) {
    if ((scope === "local" || scope === "worktree") && /^extensions\.compatobjectformat$/i.test(key)) throw new TransferError("repo-object-format", "compat");
  }

  try { await git(["cat-file", "-e", `${metadata.head}^{commit}`], "revision"); } catch (error) {
    if (error instanceof TransferError && error.code === "repo-git-failed") throw new TransferError("repo-revision-missing", metadata.head);
    throw error;
  }
  if (metadata.branch !== null) {
    const branch = metadata.branch;
    // A name starting `refs/` is ambiguous (`refs/heads/refs/x` or a ref elsewhere), and the marker holds the name, so it is bounded.
    if (typeof branch !== "string" || branch === "" || branch.startsWith("refs/") || Buffer.byteLength(branch) > 1024) throw new TransferError("repo-branch-invalid");
    try { await git(["check-ref-format", `refs/heads/${branch}`], "branch-name", 256); } catch (error) {
      if (error instanceof TransferError && error.code === "repo-git-failed") throw new TransferError("repo-branch-invalid");
      throw error;
    }
  }

  const plan = await buildPlan(snapshot, limits, root);

  // HEAD's history and tree, and nothing else: no `--all`, no `--thin`, so every delta base is in the pack.
  let pack: Buffer;
  try {
    pack = await runGit(root, ["pack-objects", "--stdout", "--revs", "-q"], limits.maxObjectBytes, "pack-objects", { ...ISOLATED, stdin: Buffer.from(`${metadata.head}\n`) });
  } catch (error) {
    if (!(error instanceof TransferError)) throw error;
    if (error.code === "repo-git-output") throw new TransferError("limit-object-bytes", "pack");
    if (error.code === "repo-git-failed") {
      // Not the budget. Say whether it is an object the history needs and the repository lacks.
      let oids: string[];
      try { oids = await closure(root, metadata.head, plan.format, limits); } catch (again) {
        if (again instanceof TransferError && again.code === "repo-git-failed") throw new TransferError("repo-object-missing", "history");
        throw again;
      }
      if (await missingFrom(root, oids, plan.format) !== null) throw new TransferError("repo-object-missing", "history");
    }
    throw error;
  }
  const objects = packCount(pack, plan.format);
  if (objects < 1 || objects > limits.maxEntries) throw new TransferError("limit-entries", "objects");
  return { plan, pack, objects };
}

/** The budgets measurable before anything is created: owned entries, and every byte about to be written. */
function assertBudgets(plan: Plan, pack: Buffer, objects: number, limits: MaterializeLimits): void {
  const hb = hashBytes(plan.format);
  const ownedPaths = [REPO, ...plan.dirs.map(dir => `${REPO}/${dir}`), ...plan.files.map(one => `${REPO}/${one.path}`)];
  const gitEntries = GIT_BASE_ENTRIES + 2 * plan.toWrite.size + (plan.branch === null ? 0 : plan.branch.split("/").length);
  if (ownedPaths.length + gitEntries > limits.maxEntries) throw new TransferError("limit-entries", "entries");

  let loose = 0;
  for (const bytes of plan.toWrite.values()) loose += bytes.length + Math.ceil(bytes.length / 1000) + 128;
  let indexBytes = 32 + 2 * hb + 4096;
  for (const path of plan.index.keys()) indexBytes += 56 + hb + Buffer.byteLength(path);
  // The pack index and the reverse index beside it: fanout, names, checksums, offsets (large ones too), and the trailers.
  const sidecars = 2048 + objects * (hb + 20) + 4 * hb;
  const marker = markerBytesFor(ownedPaths) + gitEntries * (GIT_PATH_JSON_BYTES + 1 + EVIDENCE_BYTES);
  // The marker is written to a temp file and renamed over the last one, so two of it are on disk at once.
  const total = plan.outputBytes + loose + pack.length + sidecars + indexBytes + SKELETON_BYTES + 2 * marker;
  if (total > limits.maxOutputBytes) throw new TransferError("limit-total-bytes", "output");
}

// ---------------------------------------------------------------------------
// what this call owns

interface Identity { dev: number; ino: number }
interface Listing { files: Map<string, Stats>; dirs: Map<string, Stats>; links: Map<string, Stats> }

/**
 * What this call has made, each object with the identity it had when made,
 * keyed by path relative to the destination. `git` is what `repo/.git` held
 * at the last checkpoint after a git call that succeeded. A null is an object
 * that was created and could not be identified, which can only be reported.
 */
interface Owned {
  files: Map<string, Made | null>;
  dirs: Map<string, Made | null>;
  links: Map<string, Made | null>;
  git: Listing | null;
  tmp: Made | null;
  marker: Made | null;
}

const newOwned = (): Owned => ({ files: new Map(), dirs: new Map(), links: new Map(), git: null, tmp: null, marker: null });

/**
 * What is under `sub` of `root` now (all of it when `sub` is empty), read without following a link. `cap` bounds the entries it will
 * list (`limit-entries`); anything that is not a file, directory or link is named (`stage-ambiguous`).
 */
function listUnder(root: string, sub: string, cap: number): Listing {
  const out: Listing = { files: new Map(), dirs: new Map(), links: new Map() };
  let count = 0;
  const take = () => { if (++count > cap) throw new TransferError("limit-entries", sub === "" ? "." : sub); };
  const walk = (rel: string) => {
    let names: string[];
    try { names = readdirSync(rel === "" ? root : join(root, rel)); } catch { throw new TransferError("stage-ambiguous", rel === "" ? "." : rel); }
    names.sort();
    for (const name of names) {
      const child = rel === "" ? name : `${rel}/${name}`;
      take();
      let stat: Stats;
      try { stat = lstatSync(join(root, child)); } catch { throw new TransferError("stage-ambiguous", child); }
      if (stat.isDirectory()) { out.dirs.set(child, stat); walk(child); }
      else if (stat.isSymbolicLink()) out.links.set(child, stat);
      else if (stat.isFile()) out.files.set(child, stat);
      else throw new TransferError("stage-ambiguous", child);
    }
  };
  if (sub !== "") {
    let stat: Stats;
    try { stat = lstatSync(join(root, sub)); } catch { throw new TransferError("stage-ambiguous", sub); }
    if (!stat.isDirectory()) throw new TransferError("stage-ambiguous", sub);
    take();
    out.dirs.set(sub, stat);
  }
  walk(sub);
  return out;
}

function within(listing: Listing, prefix: string): Listing {
  const pick = (from: Map<string, Stats>) => new Map([...from].filter(([rel]) => isUnder(rel, prefix)));
  return { files: pick(listing.files), dirs: pick(listing.dirs), links: pick(listing.links) };
}

/**
 * The first path (in path byte order) at which `now` is not what `before` recorded: one added, one gone, or one that is another object
 * than the one recorded. Null when `now` is exactly `before`. Nothing is adopted or changed by asking.
 */
function firstDifference(before: Listing, now: Listing): string | null {
  const differing: string[] = [];
  for (const [complete, was, is] of [[true, before.files, now.files], [true, before.links, now.links], [false, before.dirs, now.dirs]] as const) {
    for (const [rel, stat] of is) {
      const prior = was.get(rel);
      if (!prior || !isMade(stat, madeOf(prior, complete))) differing.push(rel);
    }
    for (const rel of was.keys()) if (!is.has(rel)) differing.push(rel);
  }
  return differing.sort(comparePaths)[0] ?? null;
}

function madeMaps(listing: Listing): { files: Map<string, Made>; dirs: Map<string, Made>; links: Map<string, Made> } {
  const of = (from: Map<string, Stats>, complete: boolean) => new Map([...from].map(([rel, stat]) => [rel, madeOf(stat, complete)] as const));
  return { files: of(listing.files, true), dirs: of(listing.dirs, false), links: of(listing.links, true) };
}

/** What is at `rel` against what was made there: nothing (gone), the object this call made, or anything else. No link is followed on the way. */
function claim(destination: string, rel: string, made: Made | null, kind: "file" | "dir" | "link"): "gone" | "ours" | "other" {
  const parts = rel.split("/");
  let at = destination;
  let stat: Stats | undefined;
  for (const [n, part] of parts.entries()) {
    at = join(at, part);
    try { stat = lstatSync(at); } catch (error) { return errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR" ? "gone" : "other"; }
    if (n < parts.length - 1 && (stat.isSymbolicLink() || !stat.isDirectory())) return "other";
  }
  if (made === null || stat === undefined) return "other";
  if (kind === "file" ? !stat.isFile() : kind === "dir" ? !stat.isDirectory() : !stat.isSymbolicLink()) return "other";
  return isMade(stat, made) ? "ours" : "other";
}

function firstEntry(destination: string): string {
  try { return readdirSync(destination).sort()[0] ?? "."; } catch { return "."; }
}

/**
 * Remove what this call made, and only that, and return what it left. The root
 * must still be the directory that was made (identity, not a link, parent not a
 * link). Each file and link goes only if what is at its path is the object made
 * there; each directory only if it is the one made and is empty; the temp file
 * and the marker only as the objects this call wrote. The marker stays while
 * anything else does, so what remains is still named by it; the root goes only
 * when nothing is left. A caller that gets a non-empty list must not report the
 * work undone.
 */
function removeOwned(destination: string, root: Identity, owned: Owned): string[] {
  let at: Stats;
  try { at = lstatSync(destination); } catch (error) { return errnoOf(error) === "ENOENT" ? [] : ["."]; }
  let parent: string | null = null;
  try { parent = realpathSync(dirname(destination)); } catch { /* treated as a link below */ }
  if (parent !== dirname(destination) || at.isSymbolicLink() || !at.isDirectory() || at.dev !== root.dev || at.ino !== root.ino) return ["."];

  const git = owned.git ? madeMaps(owned.git) : { files: new Map<string, Made>(), dirs: new Map<string, Made>(), links: new Map<string, Made>() };
  const left: string[] = [];
  const settle = (rel: string, made: Made | null, kind: "file" | "dir" | "link", remove: () => void) => {
    const verdict = claim(destination, rel, made, kind);
    if (verdict === "gone") return;
    if (verdict === "other") { left.push(rel); return; }
    try { remove(); } catch (error) { if (errnoOf(error) !== "ENOENT") left.push(rel); }
  };
  for (const [kind, maps] of [["file", [owned.files, git.files]], ["link", [owned.links, git.links]]] as const) {
    for (const map of maps) for (const [rel, made] of [...map].reverse()) settle(rel, made, kind, () => unlinkSync(join(destination, rel)));
  }
  const dirs = [...owned.dirs, ...git.dirs].sort((a, b) => b[0].split("/").length - a[0].split("/").length);
  for (const [rel, made] of dirs) settle(rel, made, "dir", () => rmdirSync(join(destination, rel)));
  if (owned.tmp) settle(MARKER_TMP, owned.tmp, "file", () => unlinkSync(join(destination, MARKER_TMP)));
  if (left.length === 0 && owned.marker) settle(MARKER, owned.marker, "file", () => unlinkSync(join(destination, MARKER)));
  if (left.length === 0) {
    try { rmdirSync(destination); } catch (error) { if (errnoOf(error) !== "ENOENT") left.push(firstEntry(destination)); }
  }
  return left;
}

// ---------------------------------------------------------------------------
// the marker

interface FileEvidence { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface DirEvidence { path: string; dev: number; ino: number }

/**
 * What a materialisation's directory says about itself, written first and
 * replaced whole when the work is complete: the snapshot it is for, the
 * operation, a fresh generation, the root's identity and, once complete, the
 * identity of every file, directory and link this call made under `repo/`.
 */
interface Marker {
  version: 1;
  snapshot: string;
  operation: string;
  generation: string;
  root: Identity;
  state: "staging" | "complete";
  head: string;
  branch: string | null;
  owned: { files: FileEvidence[]; dirs: DirEvidence[]; links: FileEvidence[] };
}

const MARKER_KEYS = ["version", "snapshot", "operation", "generation", "root", "state", "head", "branch", "owned"];
const FILE_EVIDENCE_KEYS = ["path", "dev", "ino", "size", "mtimeMs", "ctimeMs"];
const DIR_EVIDENCE_KEYS = ["path", "dev", "ino"];

/** A path in the marker: inside `repo`, no empty or dot segment, no control character. It is not a bundle path: `.git` is in it. */
function ownedPathOk(path: unknown): path is string {
  if (typeof path !== "string" || Buffer.byteLength(path) > MAX_OWNED_PATH || /[\u0000-\u001f\u007f\\]/.test(path)) return false;
  if (path !== REPO && !path.startsWith(`${REPO}/`)) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

const markerPaths = (marker: Marker): string[] => [...marker.owned.files, ...marker.owned.links, ...marker.owned.dirs].map(one => one.path).sort(comparePaths);

interface MarkerBounds { entries: number; bytes: number }

/** The marker's text as a marker, or `destination-foreign`: every key and value is checked, and no list is longer than its bound. */
function parseMarker(text: string, bounds: MarkerBounds): Marker {
  const foreign = () => new TransferError("destination-foreign");
  let data: any;
  try { data = JSON.parse(text); } catch { throw foreign(); }
  if (!isRecord(data) || !exactKeys(data, MARKER_KEYS) || data.version !== 1 || typeof data.snapshot !== "string" || !/^[0-9a-f]{64}$/.test(data.snapshot) ||
      typeof data.operation !== "string" || !OPERATION.test(data.operation) || typeof data.generation !== "string" || !/^[0-9a-f]{32}$/.test(data.generation) ||
      !isRecord(data.root) || !exactKeys(data.root, ["dev", "ino"]) || !isCount(data.root.dev) || !isCount(data.root.ino) ||
      (data.state !== "staging" && data.state !== "complete") || typeof data.head !== "string" || !OID.test(data.head) ||
      (data.branch !== null && typeof data.branch !== "string") ||
      !isRecord(data.owned) || !exactKeys(data.owned, ["files", "dirs", "links"]) || !Array.isArray(data.owned.files) || !Array.isArray(data.owned.dirs) ||
      !Array.isArray(data.owned.links) || data.owned.files.length + data.owned.dirs.length + data.owned.links.length > bounds.entries) throw foreign();
  for (const list of [data.owned.files, data.owned.links]) {
    for (const one of list) {
      if (!isRecord(one) || !exactKeys(one, FILE_EVIDENCE_KEYS) || !ownedPathOk(one.path) ||
          !isCount(one.dev) || !isCount(one.ino) || !isCount(one.size) || !isCount(one.mtimeMs) || !isCount(one.ctimeMs)) throw foreign();
    }
  }
  for (const one of data.owned.dirs) {
    if (!isRecord(one) || !exactKeys(one, DIR_EVIDENCE_KEYS) || !ownedPathOk(one.path) || !isCount(one.dev) || !isCount(one.ino)) throw foreign();
  }
  return data as Marker;
}

/** Whether a marker's lists agree with one another: a marker in progress has recorded nothing, a complete one lists each path once, every parent directory, and `repo/.git`. */
function coherent(marker: Marker): boolean {
  const paths = markerPaths(marker);
  if (marker.state === "staging") return paths.length === 0;
  if (new Set(paths).size !== paths.length) return false;
  const dirs = new Set(marker.owned.dirs.map(one => one.path));
  if (!dirs.has(REPO) || !dirs.has(GIT)) return false;
  return paths.every(path => path === REPO || dirs.has(dirname(path)));
}

/** The marker, read through a bounded read of a regular file reached without a link. */
function readMarker(destination: string, bounds: MarkerBounds): { marker: Marker; seen: Stats } {
  const path = join(destination, MARKER);
  let seen: Stats;
  let text: string;
  try {
    seen = lstatSync(path);
    if (!seen.isFile() || seen.size > bounds.bytes) throw new Error("unusable");
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== seen.ino || opened.dev !== seen.dev || opened.size > bounds.bytes) throw new Error("unusable");
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

/**
 * The marker is replaced whole, so a crash leaves the old one or the new one and never half of either. Its temp file is tracked from its creation.
 *
 * Nothing is renamed over a path this call cannot show it made. Immediately before the rename, the first marker finds nothing at its path, and
 * a replacement finds exactly the regular file `owned.marker` recorded (device, inode, size, mtime and ctime, so an in-place edit is a difference
 * even when its size and mtime were put back). Anything else is `stage-ambiguous` naming the marker, with `owned.marker` as it was, so the
 * rollback leaves that path and removes only the rest. After the rename, which moves the file's ctime, the settled identity is read from the
 * path and accepted only as the file this call wrote (the identity it had before the rename, ctime apart); a replacement seen there is never adopted.
 */
function writeMarker(destination: string, marker: Marker, owned: Owned): number {
  const tmp = join(destination, MARKER_TMP);
  const path = join(destination, MARKER);
  const text = Buffer.from(JSON.stringify(marker));
  const ambiguous = () => new TransferError("stage-ambiguous", MARKER);
  const made = writeExclusive(tmp, text, 0o600, one => { owned.tmp = one === null ? null : { ...one, ctimeMs: null }; });
  if (owned.marker === null) {
    if (exists(path)) throw ambiguous();
  } else {
    let there: Stats;
    try { there = lstatSync(path); } catch { throw ambiguous(); }
    if (!there.isFile() || !isMade(there, owned.marker)) throw ambiguous();
  }
  renameSync(tmp, path);
  owned.tmp = null;
  const written: Made = { ...made, ctimeMs: null };
  let settled: Stats | null = null;
  try { settled = lstatSync(path); } catch { /* not identified: bound below as the file written, and named */ }
  if (settled === null || !settled.isFile() || !isMade(settled, written)) {
    owned.marker = written;
    throw ambiguous();
  }
  owned.marker = madeOf(settled, true);
  return text.length;
}

function receiptOf(marker: Marker, destination: string): MaterializeReceipt {
  const paths = markerPaths(marker);
  return {
    destination, repo: join(destination, REPO), operation: marker.operation, generation: marker.generation,
    root: { dev: marker.root.dev, ino: marker.root.ino }, metadataDigest: marker.snapshot, head: marker.head,
    entries: paths.length, markerBytes: markerBytesFor(paths),
  };
}

/**
 * The directory against a complete marker: everything listed is still the
 * object that was made, and nothing else is there (the marker itself apart).
 * With `allowGone`, a listed object that has since been removed is not a
 * difference (a discard that is half done may be retried); a reuse wants all
 * of it. Anything else is `stage-ambiguous`, naming the first path.
 */
function checkInventory(destination: string, marker: Marker, allowGone: boolean): void {
  const evidence = {
    files: new Map(marker.owned.files.map(one => [one.path, one] as const)),
    links: new Map(marker.owned.links.map(one => [one.path, one] as const)),
    dirs: new Map(marker.owned.dirs.map(one => [one.path, one] as const)),
  };
  let listing: Listing;
  try { listing = listUnder(destination, "", evidence.files.size + evidence.links.size + evidence.dirs.size + 2); } catch (error) {
    if (error instanceof TransferError && error.code === "limit-entries") throw new TransferError("stage-ambiguous", ".");
    throw error;
  }
  const ambiguous = (path: string) => new TransferError("stage-ambiguous", path);
  for (const [kind, from, known] of [["file", listing.files, evidence.files], ["link", listing.links, evidence.links]] as const) {
    for (const [rel, stat] of from) {
      if (rel === MARKER && kind === "file") continue;
      const one = known.get(rel);
      if (!one || !isMade(stat, one)) throw ambiguous(rel);
    }
  }
  for (const [rel, stat] of listing.dirs) {
    const one = evidence.dirs.get(rel);
    if (!one || !isMade(stat, { dev: one.dev, ino: one.ino, size: null, mtimeMs: null, ctimeMs: null })) throw ambiguous(rel);
  }
  if (!allowGone) {
    for (const rel of [...evidence.files.keys()]) if (!listing.files.has(rel)) throw ambiguous(rel);
    for (const rel of [...evidence.links.keys()]) if (!listing.links.has(rel)) throw ambiguous(rel);
    for (const rel of [...evidence.dirs.keys()]) if (!listing.dirs.has(rel)) throw ambiguous(rel);
  }
}

// ---------------------------------------------------------------------------
// verification

/** Budget refusals and an already named verification failure go out as they are; any other refusal from a read-back is a repository that is not the snapshot. */
function asVerify(error: unknown): unknown {
  if (!(error instanceof TransferError)) return error;
  if (error.code.startsWith("limit-") || error.code === "repo-git-output" || error.code === "materialize-verify") return error;
  return new TransferError("materialize-verify", error.path ?? error.code);
}

/**
 * The written repository against the snapshot, read back independently of how
 * it was written: the index entries are exactly the final index (stage 0 only),
 * every index object is present as a blob and HEAD's commit and whole history
 * are (`rev-list --objects` succeeds in the new repository alone), the only ref
 * is the branch (or none, for a detached HEAD), and a fresh snapshot of the new
 * repository, which re-reads every file, equals the source's changes less the
 * withheld ones, through the same canonical text the metadata digest is taken
 * over. `indexSha256` and the bundle digest are the new repository's own and
 * are not compared: the index file's bytes are not the source's, and the
 * withheld files are not in the bundle.
 */
async function verifyRepo(repoDir: string, snapshot: Pick<RepoSnapshot, "metadata">, plan: Plan, limits: MaterializeLimits): Promise<void> {
  const fail = (part: string) => new TransferError("materialize-verify", part);
  try {
    const { entries, conflicted } = parseIndex(await runGit(repoDir, ["ls-files", "-s", "-z"], limits.maxGitOutputBytes, "ls-files", ISOLATED));
    if (conflicted !== null) throw fail(conflicted);
    if (entries.size !== plan.index.size) throw fail("index");
    for (const [path, side] of plan.index) if (!sameSide(entries.get(path) ?? null, side)) throw fail(path);

    const present = await checkObjects(repoDir, [...new Set([plan.head, ...[...plan.index.values()].map(side => side.oid)])], plan.format);
    if (present.get(plan.head)?.type !== "commit") throw fail("head");
    for (const [path, side] of plan.index) if (present.get(side.oid)?.type !== "blob") throw fail(path);

    const refs = (await runGit(repoDir, ["for-each-ref", "--format=%(refname)"], 65536, "for-each-ref", ISOLATED)).toString("utf8").split("\n").filter(one => one !== "");
    const wanted = plan.branch === null ? [] : [`refs/heads/${plan.branch}`];
    if (refs.length !== wanted.length || refs.some((one, n) => one !== wanted[n])) throw fail("refs");

    // The whole history is in this repository alone: every object HEAD reaches is listed, and every one is present.
    let reachable: string[];
    try { reachable = await closure(repoDir, plan.head, plan.format, limits); } catch (error) {
      if (error instanceof TransferError && error.code === "repo-git-failed") throw fail("objects");
      throw error;
    }
    if (reachable.length < 1 || await missingFrom(repoDir, reachable, plan.format) !== null) throw fail("objects");

    const actual = await snapshotRepo({ repo: repoDir, limits, dependencyFiles: snapshot.metadata.dependencies.map(one => one.path), isolated: true });
    const expected: RepoMetadata = {
      ...snapshot.metadata, bundleDigest: actual.metadata.bundleDigest, indexSha256: actual.metadata.indexSha256,
      changes: snapshot.metadata.changes.filter(one => one.carried !== "withheld"), withheld: [],
    };
    if (metadataDigestOf(expected) !== actual.metadataDigest) {
      const text = (changes: RepoChange[]) => new Map(changes.map(one => [one.path, JSON.stringify(one)] as const));
      const want = text(expected.changes), got = text(actual.metadata.changes);
      const first = [...new Set([...want.keys(), ...got.keys()])].sort(comparePaths).find(path => want.get(path) !== got.get(path));
      throw fail(first ?? "metadata");
    }
  } catch (error) { throw asVerify(error); }
}

// ---------------------------------------------------------------------------
// materialising

function resolveTarget(destination: unknown): string {
  if (typeof destination !== "string" || !isAbsolute(destination) || /[\u0000-\u001f\u007f]/.test(destination)) throw new TransferError("destination-invalid");
  const name = basename(destination);
  if (name === "" || name === "." || name === "..") throw new TransferError("destination-invalid");
  let parent: string;
  try { parent = realpathSync(dirname(destination)); } catch { throw new TransferError("destination-invalid"); }
  return join(parent, name);
}

function resultOf(plan: Plan, metadata: RepoMetadata, receipt: MaterializeReceipt, reused: boolean): MaterializeResult {
  return {
    repo: receipt.repo, head: plan.head, branch: plan.branch, files: plan.files.filter(one => one.kind === "file").length,
    links: plan.files.filter(one => one.kind === "link").length, withheld: metadata.withheld, reused, receipt,
  };
}

/**
 * Materialise a verified snapshot as a self-contained repository in a new
 * directory. See the note at the top of this file for what is read, written,
 * refused and bounded.
 *
 * A destination that already exists is never adopted. One whose marker says
 * `complete` for this snapshot, operation and root is read back (every owned
 * object's identity, nothing else present, then the same verification a fresh
 * one gets) and reported `reused`, with the receipt it was made under; the
 * selected repository is not read again. An unfinished marker, or a lone temp
 * file, is `stage-ambiguous`; a marker for another snapshot, operation or
 * directory is `destination-foreign`; anything else is `destination-exists`.
 *
 * A failed materialisation removes what this call made, each object only if it
 * is still the object that was made, and rethrows. What is left that this call
 * cannot show it made (a foreign file, a replaced one, whatever a failed git
 * call wrote) stays, named, and the call stops with `stage-ambiguous` instead
 * of the error that started it.
 */
export async function materializeRepo(options: MaterializeOptions): Promise<MaterializeResult> {
  const { snapshot, limits } = options;
  assertMaterializeLimits(limits);
  if (typeof options.operation !== "string" || !OPERATION.test(options.operation)) throw new TransferError("operation-invalid");
  verifySnapshot(snapshot, limits);
  const { metadata } = snapshot;
  if (metadata.objectFormat !== "sha1" && metadata.objectFormat !== "sha256") throw new TransferError("repo-object-format");
  if (typeof metadata.head !== "string" || !OID.test(metadata.head) || metadata.head.length !== hashHex(metadata.objectFormat)) throw new TransferError("repo-revision-invalid");
  const destination = resolveTarget(options.destination);

  let existing: Stats | null = null;
  try { existing = lstatSync(destination); } catch (error) { if (errnoOf(error) !== "ENOENT") throw new TransferError("destination-invalid"); }
  if (existing) return reuse(options, destination, existing);

  const source = await readDestination(options, destination);
  assertBudgets(source.plan, source.pack!, source.objects, limits);
  return create(options, destination, source);
}

async function create(options: MaterializeOptions, destination: string, source: Source): Promise<MaterializeResult> {
  const { snapshot, limits } = options;
  const { plan } = source;
  const repoDir = join(destination, REPO);
  const owned = newOwned();
  const step = (name: MaterializeStep) => options.observe?.afterStep?.(name);
  const git = (args: string[], label: string, max: number, stdin?: Uint8Array) => runGit(repoDir, args, max, label, stdin ? { ...ISOLATED, stdin } : ISOLATED);

  try { mkdirSync(destination, { mode: 0o700 }); } catch (error) {
    throw new TransferError(errnoOf(error) === "EEXIST" ? "destination-exists" : "destination-invalid");
  }
  // Made by this call, so it is this call's to remove; if it cannot even be identified it is named and left.
  let rootStat: Stats;
  try { rootStat = lstatSync(destination); } catch { throw new TransferError("stage-ambiguous", "."); }
  if (!rootStat.isDirectory()) throw new TransferError("stage-ambiguous", ".");
  const root: Identity = { dev: rootStat.dev, ino: rootStat.ino };
  const marker: Marker = {
    version: 1, snapshot: snapshot.metadataDigest, operation: options.operation, generation: randomBytes(16).toString("hex"), root,
    state: "staging", head: plan.head, branch: plan.branch, owned: { files: [], dirs: [], links: [] },
  };

  const mkdirOwned = (rel: string) => {
    // Exclusive: a directory that is already there is not ours to reuse.
    mkdirSync(join(destination, rel), { mode: 0o700 });
    owned.dirs.set(rel, null);
    owned.dirs.set(rel, madeOf(lstatSync(join(destination, rel)), false));
  };
  /** What git made in `.git` is claimed only now, after the call that made it succeeded, by reading it back. */
  const checkpoint = () => { owned.git = listUnder(destination, GIT, limits.maxEntries); };
  /**
   * Run before every git call that writes in `.git`, so the checkpoint after it can only be adopting what that call made: `.git` must still be
   * exactly what the last checkpoint recorded. Anything added, replaced or gone since is refused here, before the call, and not adopted.
   */
  const guard = () => {
    const differs = firstDifference(owned.git!, listUnder(destination, GIT, limits.maxEntries));
    if (differs !== null) throw new TransferError("stage-ambiguous", differs);
  };
  /** What one successful `hash-object -w` made: its fan-out directory if that is new, and its loose file unless the object was already held. Nothing else is read. */
  const adoptLoose = (oid: string) => {
    const dir = `${GIT}/objects/${oid.slice(0, 2)}`;
    for (const [rel, kind] of [[dir, "dirs"], [`${dir}/${oid.slice(2)}`, "files"]] as const) {
      let stat: Stats;
      try { stat = lstatSync(join(destination, rel)); } catch (error) {
        if (errnoOf(error) === "ENOENT") continue;
        throw new TransferError("stage-ambiguous", rel);
      }
      const prior = owned.git![kind].get(rel);
      if (!(kind === "dirs" ? stat.isDirectory() : stat.isFile()) || (prior && !isMade(stat, madeOf(prior, kind === "files")))) throw new TransferError("stage-ambiguous", rel);
      owned.git![kind].set(rel, stat);
    }
  };

  try {
    writeMarker(destination, marker, owned);

    // init: an empty template (no hooks, no info/exclude), and the repository's own config is all the config there is.
    mkdirOwned(REPO);
    await git(["init", "--quiet", "--template=", `--object-format=${plan.format}`, `--initial-branch=${plan.branch ?? "main"}`], "init", 4096);
    checkpoint();
    for (const { scope } of configEntries(await git(["config", "--list", "--show-scope", "--name-only", "--no-includes", "-z"], "config", limits.maxGitOutputBytes))) {
      if (scope !== "local" && scope !== "command") throw new TransferError("repo-unsafe-config", scope);
    }
    step("init");

    // objects: HEAD's history in one pack, indexed in place; then the staged objects HEAD's tree does not hold.
    const pack = source.pack!;
    source.pack = null;
    guard();
    await git(["index-pack", "--stdin"], "index-pack", 4096, pack);
    // The pack and its sidecars exist now, made by a call that succeeded: recorded before any later call can fail, so a failure still removes them.
    checkpoint();
    step("pack");
    guard();
    for (const [oid, bytes] of plan.toWrite) {
      const written = (await git(["hash-object", "-w", "--no-filters", "-t", "blob", "--stdin"], "hash-object", 256, bytes)).toString("utf8").trim();
      if (written !== oid) throw new TransferError("materialize-verify", "index-blob");
      // Recorded one by one, so a later object that fails still leaves the earlier loose ones named as ours.
      adoptLoose(oid);
    }
    checkpoint();
    step("objects");

    // worktree: our own exclusive writes, never a checkout. Directories one component at a time, files, then links; nothing is followed.
    const ensureDirs = (path: string) => {
      const parts = path.split("/");
      for (let n = 1; n < parts.length; n++) {
        const dir = `${REPO}/${parts.slice(0, n).join("/")}`;
        if (!owned.dirs.has(dir)) mkdirOwned(dir);
      }
    };
    for (const kind of ["file", "link"] as const) {
      const list = plan.files.filter(one => one.kind === kind);
      for (let at = 0; at < list.length;) {
        const group: Planned[] = [];
        const wanted = new Map<string, Planned>();
        let held = 0;
        while (at < list.length && group.length < BATCH_FILES) {
          const one = list[at];
          const fresh = one.bytes === null && !wanted.has(one.oid);
          if (group.length > 0 && fresh && held + one.size > BATCH_BYTES) break;
          if (fresh) { wanted.set(one.oid, one); held += one.size; }
          group.push(one);
          at++;
        }
        const blobs = wanted.size > 0 ? await readBlobs(repoDir, [...wanted.values()], plan.format) : new Map<string, Buffer>();
        for (const one of group) {
          const bytes = one.bytes ?? blobs.get(one.oid)!;
          const rel = `${REPO}/${one.path}`;
          ensureDirs(one.path);
          if (kind === "file") {
            if (one.sha256 !== null && sha256Hex(bytes) !== one.sha256) throw new TransferError("materialize-verify", one.path);
            writeExclusive(join(destination, rel), bytes, one.mode, made => { owned.files.set(rel, made); });
          } else {
            if (bytes.includes(0)) throw new TransferError("repo-symlink", one.path);
            symlinkSync(Buffer.from(bytes), join(destination, rel));
            owned.links.set(rel, null);
            owned.links.set(rel, madeOf(lstatSync(join(destination, rel)), true));
          }
        }
      }
    }
    step("worktree");

    // index: the final index's entries, with no stat data, so git hashes each file itself the first time it is asked.
    const entries = [...plan.index].sort((a, b) => comparePaths(a[0], b[0])).map(([path, side]) => `${side.mode} ${side.oid}\t${path}\0`).join("");
    guard();
    await git(["update-index", "-z", "--index-info"], "update-index", 4096, Buffer.from(entries));
    checkpoint();
    step("index");

    // refs: HEAD's own, and nothing else. A branch is made and is what HEAD names; a detached HEAD is the commit itself.
    const zero = "0".repeat(hashHex(plan.format));
    guard();
    if (plan.branch !== null) {
      await git(["update-ref", `refs/heads/${plan.branch}`, plan.head, zero], "update-ref", 4096);
      checkpoint();
      await git(["symbolic-ref", "HEAD", `refs/heads/${plan.branch}`], "symbolic-ref", 4096);
    } else await git(["update-ref", "--no-deref", "HEAD", plan.head], "update-ref", 4096);
    checkpoint();
    step("refs");

    await verifyRepo(repoDir, snapshot, plan, limits);

    // The whole tree against what was recorded: nothing but the marker and what this call made, `.git` read back as it is now.
    const listing = listUnder(destination, "", limits.maxEntries + 1);
    const inGit = (rel: string) => isUnder(rel, GIT);
    for (const [kind, from, known] of [["file", listing.files, owned.files], ["link", listing.links, owned.links]] as const) {
      for (const [rel, stat] of from) {
        if (inGit(rel) || (kind === "file" && rel === MARKER)) continue;
        const made = known.get(rel);
        if (!made || !isMade(stat, made)) throw new TransferError("stage-ambiguous", rel);
      }
    }
    for (const [rel, stat] of listing.dirs) {
      if (inGit(rel)) continue;
      const made = owned.dirs.get(rel);
      if (!made || !isMade(stat, made)) throw new TransferError("stage-ambiguous", rel);
    }
    for (const [known, from] of [[owned.files, listing.files], [owned.links, listing.links], [owned.dirs, listing.dirs]] as const) {
      for (const rel of known.keys()) if (!from.has(rel)) throw new TransferError("materialize-verify", rel);
    }
    // Verification only reads, so `.git` must be exactly what the last checkpoint recorded, path for path and object for object. Anything else
    // (a file added, one replaced, one gone) is not adopted: `owned.git` stays as it was recorded, so a rollback removes only what it names.
    const changedGit = firstDifference(owned.git!, within(listing, GIT));
    if (changedGit !== null) throw new TransferError("stage-ambiguous", changedGit);

    const evidence = (from: Map<string, Stats>): FileEvidence[] => [...from]
      .filter(([rel]) => rel !== MARKER)
      .map(([path, stat]) => ({ path, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }))
      .sort((a, b) => comparePaths(a.path, b.path));
    const complete: Marker = {
      ...marker, state: "complete",
      owned: {
        files: evidence(listing.files), links: evidence(listing.links),
        dirs: [...listing.dirs].map(([path, stat]) => ({ path, dev: stat.dev, ino: stat.ino })).sort((a, b) => comparePaths(a.path, b.path)),
      },
    };
    const paths = markerPaths(complete);
    if (paths.length > limits.maxEntries) throw new TransferError("limit-entries", "entries");
    // Every byte on disk, as it is: files and links, and the marker twice over (the old one is still there while the new one is renamed over it).
    let onDisk = 0;
    for (const stat of [...listing.files.values(), ...listing.links.values()]) if (stat !== listing.files.get(MARKER)) onDisk += stat.size;
    const text = Buffer.byteLength(JSON.stringify(complete));
    if (text > markerBytesFor(paths) || onDisk + 2 * text > limits.maxOutputBytes) throw new TransferError("limit-total-bytes", "output");
    writeMarker(destination, complete, owned);
    return resultOf(plan, snapshot.metadata, receiptOf(complete, destination), false);
  } catch (error) {
    const left = removeOwned(destination, root, owned);
    if (left.length > 0) throw new TransferError("stage-ambiguous", left[0]);
    if (error instanceof TransferError) throw error;
    throw new TransferError("stage-io");
  }
}

async function reuse(options: MaterializeOptions, destination: string, rootStat: Stats): Promise<MaterializeResult> {
  const { snapshot, limits } = options;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new TransferError("destination-exists");
  let names: string[];
  try { names = readdirSync(destination); } catch { throw new TransferError("destination-invalid"); }
  if (!names.includes(MARKER)) {
    // A crash between the marker's write and its rename leaves only the temp file. It is this library's name and nobody's proof: it is named and left.
    if (names.length === 1 && names[0] === MARKER_TMP) throw new TransferError("stage-ambiguous", MARKER_TMP);
    throw new TransferError("destination-exists");
  }
  const { marker } = readMarker(destination, { entries: limits.maxEntries, bytes: markerBytesMost(limits.maxEntries) });
  if (marker.snapshot !== snapshot.metadataDigest || marker.operation !== options.operation || marker.root.dev !== rootStat.dev || marker.root.ino !== rootStat.ino ||
      marker.head !== snapshot.metadata.head || marker.branch !== snapshot.metadata.branch || !coherent(marker)) throw new TransferError("destination-foreign");
  if (marker.state !== "complete") {
    const others = names.filter(one => one !== MARKER);
    throw new TransferError("stage-ambiguous", others.sort()[0] ?? MARKER);
  }
  checkInventory(destination, marker, false);
  // The same verification a fresh one gets, against the tree of the materialised repository itself: the selected one is not read.
  const repoDir = join(destination, REPO);
  const plan = await buildPlan(snapshot, limits, repoDir);
  await verifyRepo(repoDir, snapshot, plan, limits);
  return resultOf(plan, snapshot.metadata, receiptOf(marker, destination), true);
}

// ---------------------------------------------------------------------------
// discard

function assertReceipt(receipt: MaterializeReceipt): void {
  const ok = isRecord(receipt) && typeof receipt.destination === "string" && isAbsolute(receipt.destination) && basename(receipt.destination) !== "" &&
    receipt.repo === join(receipt.destination, REPO) &&
    typeof receipt.operation === "string" && OPERATION.test(receipt.operation) &&
    typeof receipt.generation === "string" && /^[0-9a-f]{32}$/.test(receipt.generation) &&
    typeof receipt.metadataDigest === "string" && /^[0-9a-f]{64}$/.test(receipt.metadataDigest) &&
    typeof receipt.head === "string" && OID.test(receipt.head) &&
    isRecord(receipt.root) && isCount(receipt.root.dev) && isCount(receipt.root.ino) &&
    isWhole(receipt.entries) && isWhole(receipt.markerBytes) && receipt.markerBytes >= MARKER_FIXED_BYTES && receipt.markerBytes <= markerBytesMost(receipt.entries);
  if (!ok) throw new TransferError("destination-invalid");
}

/**
 * Remove a materialisation this library made, found by the receipt it gave, and
 * nothing else. Before anything changes: the destination is a real directory
 * reached through no link, it is the directory that was made (identity), and its
 * marker is the one the receipt names (snapshot, operation, generation, root,
 * head). A directory that was replaced, recreated or already discarded is
 * `stage-stale`; a marker for another snapshot is `destination-foreign`;
 * neither is touched. The marker is read under the receipt's bounds and they
 * must be the ones its own listing works out to. Then the whole tree is read
 * without following a link and held against the marker's inventory: a listed
 * object that is now another object, or anything present that the marker does
 * not list (a file someone added, one git made since, a repository in use), is
 * `stage-ambiguous` and nothing whatever has been removed.
 *
 * Only what the marker records is removed, each object by identity, then the
 * marker and the root. It returns only when everything is gone. The caller
 * serialises this with every other use of the destination.
 */
export function discardMaterialized(options: { receipt: MaterializeReceipt }): void {
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
  try { lstatSync(join(destination, MARKER)); } catch (error) {
    throw new TransferError(errnoOf(error) === "ENOENT" ? "stage-stale" : "destination-foreign");
  }
  const { marker, seen } = readMarker(destination, { entries: receipt.entries, bytes: receipt.markerBytes });
  if (marker.snapshot !== receipt.metadataDigest) throw new TransferError("destination-foreign");
  if (marker.operation !== receipt.operation || marker.generation !== receipt.generation || marker.head !== receipt.head ||
      marker.root.dev !== receipt.root.dev || marker.root.ino !== receipt.root.ino) throw new TransferError("stage-stale");
  // The receipt's bounds are the ones this marker's own listing works out to.
  const paths = markerPaths(marker);
  if (paths.length !== receipt.entries || markerBytesFor(paths) !== receipt.markerBytes) throw new TransferError("stage-stale");
  if (!coherent(marker)) throw new TransferError("destination-foreign");
  // The marker read is the marker that is there.
  let now: Stats;
  try { now = lstatSync(join(destination, MARKER)); } catch { throw new TransferError("stage-stale"); }
  if (now.dev !== seen.dev || now.ino !== seen.ino || now.size !== seen.size || now.mtimeMs !== seen.mtimeMs) throw new TransferError("stage-stale");

  if (marker.state === "staging") {
    const others = readdirSync(destination).filter(one => one !== MARKER);
    if (others.length > 0) throw new TransferError("stage-ambiguous", others.sort()[0]);
  } else checkInventory(destination, marker, true);

  const made = (one: FileEvidence): Made => ({ dev: one.dev, ino: one.ino, size: one.size, mtimeMs: one.mtimeMs, ctimeMs: one.ctimeMs });
  const owned: Owned = {
    files: new Map(marker.owned.files.map(one => [one.path, made(one)] as const)),
    links: new Map(marker.owned.links.map(one => [one.path, made(one)] as const)),
    dirs: new Map(marker.owned.dirs.map(one => [one.path, { dev: one.dev, ino: one.ino, size: null, mtimeMs: null, ctimeMs: null }] as const)),
    git: null, tmp: null,
    marker: { dev: seen.dev, ino: seen.ino, size: seen.size, mtimeMs: seen.mtimeMs, ctimeMs: null },
  };
  const left = removeOwned(destination, marker.root, owned);
  if (left.length > 0) throw new TransferError("stage-ambiguous", left[0]);
}
