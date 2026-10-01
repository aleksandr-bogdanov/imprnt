// Materialising a snapshot as a self-contained repository in a new directory,
// from the one selected destination repository and nothing else.
//
// Every repository here is a local scratch repository on plain git, through the
// same fixture wrapper the rollout tests use, with HOME and XDG_CONFIG_HOME
// pointed at a scratch directory. Nothing here reaches a network, reads a
// private repository or writes a user's configuration.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildBundle, contentKey, sha256Hex, TransferError, type EntryInput } from "../src/transfer/bundle.ts";
import { discardMaterialized, materializeRepo, type MaterializeLimits, type MaterializeOptions } from "../src/transfer/materialize.ts";
import { INDEX_BLOB_PREFIX, metadataDigestOf, snapshotRepo, type RepoChange, type RepoMetadata, type RepoSnapshot } from "../src/transfer/repos.ts";
import { fixtureGit } from "./helpers/rollout-git.ts";

const LIM: MaterializeLimits = {
  maxFiles: 50, maxFileBytes: 8192, maxTotalBytes: 65536, maxGitOutputBytes: 1 << 20, maxScanBytes: 1 << 22,
  maxOutputBytes: 1 << 22, maxObjectBytes: 1 << 20, maxEntries: 5000,
};

type Snap = Pick<RepoSnapshot, "metadata" | "metadataDigest" | "bundle">;

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  // A global git config of the machine running the tests is nobody's input here.
  const home = scratch();
  for (const key of ["HOME", "XDG_CONFIG_HOME"]) { saved[key] = process.env[key]; process.env[key] = home; }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "transfer-mat-")));
  made.push(dir);
  return dir;
}

function put(root: string, rel: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  chmodSync(join(root, rel), mode);
}

/** Every entry under `dir`, `.git` included, with what a read or a write would move. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const child = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, child));
      if (stat.isDirectory()) { out[`${child}/`] = `${stat.mtimeMs}`; walk(child); }
      else if (stat.isSymbolicLink()) out[child] = `link:${readlinkSync(join(dir, child))}`;
      else out[child] = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${sha256Hex(readFileSync(join(dir, child)))}`;
    }
  };
  walk("");
  return out;
}

/** The working tree of a repository, `.git` left out: each file's permission bits and bytes, each link's target, exactly. */
function worktreeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (rel === "" && name === ".git") continue;
      const child = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, child));
      if (stat.isDirectory()) walk(child);
      else if (stat.isSymbolicLink()) out[child] = `-> ${readlinkSync(join(dir, child))}`;
      else out[child] = `${(stat.mode & 0o777).toString(8)}:${readFileSync(join(dir, child)).toString("latin1")}`;
    }
  };
  walk("");
  return out;
}

let format: "sha1" | "sha256" = "sha1";
const gitBlob = (text: string) => createHash(format).update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

async function caught(run: () => Promise<unknown>): Promise<TransferError | null> {
  try { await run(); } catch (error) {
    if (error instanceof TransferError) return error;
    throw error;
  }
  return null;
}
function caughtSync(run: () => unknown): TransferError | null {
  try { run(); } catch (error) {
    if (error instanceof TransferError) return error;
    throw error;
  }
  return null;
}

const newTarget = () => join(scratch(), "out");

function run(snapshot: Snap, destinationRepo: string, destination: string, extra: Partial<MaterializeOptions> = {}) {
  return materializeRepo({ snapshot, destinationRepo, destination, operation: "op-1", limits: LIM, ...extra });
}

/** The refusal a materialisation ends in, and whether anything was left behind at the destination. */
async function refusal(snapshot: Snap, destinationRepo: string, extra: Partial<MaterializeOptions> = {}) {
  const target = newTarget();
  const error = await caught(() => run(snapshot, destinationRepo, target, extra));
  return { code: error?.code ?? "none", path: error?.path, created: existsSync(target) };
}

/** A repository with one commit: files of every kind a snapshot has to tell apart, two of them links, two executable. */
function sourceRepo(): { repo: string; outside: string } {
  format = "sha1";
  const outside = scratch();
  put(outside, "secret.txt", "OUTSIDE-SECRET\n");
  const repo = scratch();
  fixtureGit(repo, "init", "--initial-branch=main");
  put(repo, ".gitignore", "ignored.log\n");
  put(repo, "a.txt", "one\n");
  put(repo, "b.sh", "#!/bin/sh\n", 0o755);
  put(repo, "dir/c.txt", "c\n");
  put(repo, "gone.txt", "gone\n");
  put(repo, "staged.txt", "s0\n");
  put(repo, "clean.txt", "clean\n");
  put(repo, "del-staged.txt", "del\n");
  put(repo, "tools/run.sh", "#!/bin/sh\necho run\n", 0o755);
  symlinkSync(join(outside, "secret.txt"), join(repo, "abs-link"));
  symlinkSync("a.txt", join(repo, "rel-link"));
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "base");
  return { repo, outside };
}

/** The selected destination: a copy of the repository as committed, with its own object store. */
function cloneOf(repo: string): string {
  const dest = join(scratch(), "dest");
  fixtureGit(scratch(), "clone", "-q", "--no-hardlinks", repo, dest);
  return dest;
}

/** Staged, unstaged, both, deleted both ways, an index-only blob, a mode change, untracked, an ignored dependency and a credential-shaped file. */
function dirty(repo: string): void {
  put(repo, "a.txt", "one modified\n");
  put(repo, "staged.txt", "s1\n");
  fixtureGit(repo, "add", "staged.txt");
  put(repo, "staged.txt", "s2\n");
  rmSync(join(repo, "gone.txt"));
  chmodSync(join(repo, "b.sh"), 0o644);
  fixtureGit(repo, "rm", "-q", "del-staged.txt");
  // Removed from the index and left on disk: the working file is HEAD's own bytes.
  fixtureGit(repo, "rm", "-q", "--cached", "dir/c.txt");
  put(repo, "new-staged.txt", "ns\n");
  fixtureGit(repo, "add", "new-staged.txt");
  // Staged, then gone from the working tree: only the index holds these bytes.
  put(repo, "idx-only.txt", "idx only\n");
  fixtureGit(repo, "add", "idx-only.txt");
  rmSync(join(repo, "idx-only.txt"));
  put(repo, "notes/todo.md", "todo\n");
  put(repo, "ignored.log", "noise\n");
  put(repo, ".env", "KEY=1\n");
}

/** Three commits, each changing a file of about 2 KB, so the history is larger than HEAD's tree. */
function historyRepo(): string {
  format = "sha1";
  const repo = scratch();
  fixtureGit(repo, "init", "--initial-branch=main");
  put(repo, "old.txt", `v1 ${"x".repeat(2000)}\n`);
  put(repo, "keep.txt", "keep\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "one");
  put(repo, "old.txt", `v2 ${"y".repeat(2000)}\n`);
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "two");
  put(repo, "new.txt", `v3 ${"z".repeat(2000)}\n`);
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "three");
  return repo;
}

/** An object's loose file removed from a repository, or a loud failure if it is not loose. */
function dropObject(repo: string, oid: string): void {
  const path = join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  if (!existsSync(path)) throw new Error("fixture object is not loose");
  chmodSync(path, 0o644);
  unlinkSync(path);
}

const take = (repo: string, dependencyFiles: string[] = []) => snapshotRepo({ repo, limits: LIM, dependencyFiles });

/** A snapshot rebuilt with its bundle edited, and its metadata edited to match: the pair stays a genuine pair, so only what materialising checks can object. */
function rebuild(snap: Snap, edit: { entries?: (entries: EntryInput[]) => EntryInput[]; metadata?: (metadata: RepoMetadata) => RepoMetadata } = {}): Snap {
  const entries: EntryInput[] = snap.bundle.manifest.entries.map(one => one.kind === "delete"
    ? { path: one.path, class: one.class, deleted: true as const }
    : { path: one.path, class: one.class, mode: one.mode, bytes: snap.bundle.contents.get(contentKey(one.class, one.path))! });
  const bundle = buildBundle(edit.entries ? edit.entries(entries) : entries, LIM, { base: snap.bundle.manifest.base! });
  const base = { ...snap.metadata, bundleDigest: bundle.manifest.digest };
  const metadata = edit.metadata ? edit.metadata(base) : base;
  return { metadata, metadataDigest: metadataDigestOf(metadata), bundle };
}

/** Untracked files the source never had, carried by a snapshot that is otherwise genuine. */
function withUntracked(snap: Snap, files: Record<string, string>): Snap {
  return rebuild(snap, {
    entries: entries => [...entries, ...Object.entries(files).map(([path, text]) => ({ path, class: "workspace" as const, mode: 0o644, bytes: Buffer.from(text) }))],
    metadata: metadata => ({
      ...metadata,
      changes: [...metadata.changes, ...Object.entries(files).map(([path, text]): RepoChange => ({
        path, status: " ?", head: null, index: null,
        worktree: { mode: 0o644, size: Buffer.byteLength(text), sha256: sha256Hex(Buffer.from(text)), oid: gitBlob(text) }, carried: "worktree",
      }))],
    }),
  });
}

// ---------------------------------------------------------------------------

test("a dirty snapshot becomes a self-contained repository with the source's HEAD, index entries and working files", async () => {
  const { repo, outside } = sourceRepo();
  const dest = cloneOf(repo);
  dirty(repo);
  const head = fixtureGit(repo, "rev-parse", "HEAD");
  const snapshot = await take(repo, ["ignored.log"]);
  const target = newTarget();
  const outsideBefore = fingerprint(outside);

  const result = await run(snapshot, dest, target);
  const out = join(target, "repo");
  expect(result).toMatchObject({
    repo: out, head, branch: "main", reused: false, files: 10, links: 2,
    withheld: [{ path: ".env", what: "worktree", reason: "credential-shaped-name" }],
  });
  expect(readdirSync(target).sort()).toEqual([".imprnt-materialize.json", "repo"]);

  // Raw bytes and modes, every file: staged-and-changed, deleted, mode-only, kept-on-disk, untracked, ignored-but-named; `.env` is left out, and no index blob became a file.
  const expected = worktreeOf(repo);
  delete expected[".env"];
  expect(worktreeOf(out)).toEqual(expected);
  expect(worktreeOf(out)["staged.txt"]).toBe("644:s2\n");
  expect(worktreeOf(out)["b.sh"]).toBe("644:#!/bin/sh\n");
  expect(worktreeOf(out)["tools/run.sh"]).toBe("755:#!/bin/sh\necho run\n");
  expect(worktreeOf(out)["dir/c.txt"]).toBe("644:c\n");
  expect(worktreeOf(out)).not.toHaveProperty("idx-only.txt");
  expect(Object.keys(worktreeOf(out)).some(path => path.startsWith(".imprnt-transfer"))).toBe(false);
  // The links are links, kept as they are and never followed: nothing of the file one points at outside was copied in.
  expect(lstatSync(join(out, "abs-link")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(out, "abs-link"))).toBe(join(outside, "secret.txt"));
  expect(readlinkSync(join(out, "rel-link"))).toBe("a.txt");
  expect(Object.values(worktreeOf(out)).some(value => value.includes("OUTSIDE-SECRET"))).toBe(false);
  expect(fingerprint(outside)).toEqual(outsideBefore);

  // The index entries are the source's, path for path, mode for mode, object for object.
  expect(fixtureGit(out, "ls-files", "-s")).toBe(fixtureGit(repo, "ls-files", "-s"));
  // HEAD, the branch and the whole history, and the objects only the index holds, written from the carried bytes (the selected repository never had them).
  expect(fixtureGit(out, "rev-parse", "HEAD")).toBe(head);
  expect(fixtureGit(out, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(fixtureGit(out, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  expect(fixtureGit(out, "cat-file", "-p", gitBlob("s1\n"))).toBe("s1");
  expect(fixtureGit(out, "cat-file", "-p", gitBlob("idx only\n"))).toBe("idx only");
  expect(() => fixtureGit(dest, "cat-file", "-e", gitBlob("s1\n"))).toThrow();
  expect(fixtureGit(out, "rev-list", "--count", "HEAD")).toBe(fixtureGit(repo, "rev-list", "--count", "HEAD"));
  expect(() => fixtureGit(out, "fsck", "--full")).not.toThrow();
  // Self-contained by construction: no alternates, no shallow file, nothing pointing back at the selected repository.
  expect(existsSync(join(out, ".git/objects/info/alternates"))).toBe(false);
  expect(existsSync(join(out, ".git/shallow"))).toBe(false);

  // An independent reading by plain git agrees with what was snapshotted, less the withheld file.
  const lines = (repoDir: string) => fixtureGit(repoDir, "status", "--porcelain", "--untracked-files=all").split("\n").filter(one => one !== "").sort();
  expect(lines(out)).toEqual(lines(repo).filter(one => one !== "?? .env"));
});

test("a detached HEAD stays detached, carries its whole history, and a clean snapshot leaves git nothing to report", async () => {
  const repo = historyRepo();
  fixtureGit(repo, "checkout", "-q", "--detach");
  const dest = cloneOf(repo);
  fixtureGit(dest, "checkout", "-q", "--detach");
  const snapshot = await take(repo);
  expect(snapshot.metadata.branch).toBeNull();
  const target = newTarget();
  const result = await run(snapshot, dest, target);
  const out = join(target, "repo");
  expect(result).toMatchObject({ branch: null, head: fixtureGit(repo, "rev-parse", "HEAD"), files: 3, links: 0, withheld: [] });
  expect(() => fixtureGit(out, "symbolic-ref", "-q", "HEAD")).toThrow();
  expect(fixtureGit(out, "rev-parse", "HEAD")).toBe(fixtureGit(repo, "rev-parse", "HEAD"));
  expect(fixtureGit(out, "for-each-ref", "--format=%(refname)")).toBe("");
  expect(fixtureGit(out, "rev-list", "--count", "HEAD")).toBe("3");
  expect(fixtureGit(out, "status", "--porcelain")).toBe("");
  expect(worktreeOf(out)).toEqual(worktreeOf(repo));
});

test("only HEAD's own history is copied: the selected repository's other branches and tags are not", async () => {
  const repo = historyRepo();
  fixtureGit(repo, "branch", "side", "HEAD~1");
  fixtureGit(repo, "tag", "-a", "-m", "tagged", "v1", "HEAD~2");
  put(repo, "side-only.txt", "side\n");
  fixtureGit(repo, "checkout", "-q", "-b", "other");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "only on other");
  const otherHead = fixtureGit(repo, "rev-parse", "HEAD");
  fixtureGit(repo, "checkout", "-q", "main");
  const dest = cloneOf(repo);
  // The destination also holds `other`, `side` and the tag in its object store; the clone keeps them as remote-tracking refs.
  expect(() => fixtureGit(dest, "cat-file", "-e", otherHead)).not.toThrow();
  const target = newTarget();
  await run(await take(repo), dest, target);
  const out = join(target, "repo");
  expect(fixtureGit(out, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  expect(() => fixtureGit(out, "cat-file", "-e", otherHead)).toThrow();
  expect(fixtureGit(out, "rev-list", "--count", "HEAD")).toBe("3");
  expect(fixtureGit(out, "config", "--local", "--list")).not.toContain("remote");
});

test("the result stays whole after the selected repository's object storage and the source are gone", async () => {
  const { repo } = sourceRepo();
  const dest = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);
  const target = newTarget();
  const { repo: out } = await run(snapshot, dest, target);
  const commits = fixtureGit(repo, "rev-list", "--count", "HEAD");
  const index = fixtureGit(repo, "ls-files", "-s");

  // Both the selected repository's objects and the source path are made to not exist: nothing the new repository holds may come from either.
  rmSync(join(dest, ".git", "objects"), { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  expect(() => fixtureGit(dest, "cat-file", "-e", "HEAD")).toThrow();
  expect(() => fixtureGit(out, "fsck", "--full")).not.toThrow();
  expect(fixtureGit(out, "rev-list", "--count", "HEAD")).toBe(commits);
  expect(fixtureGit(out, "rev-list", "--objects", "--all").split("\n").length).toBeGreaterThan(5);
  expect(fixtureGit(out, "cat-file", "-p", "HEAD:clean.txt")).toBe("clean");
  expect(fixtureGit(out, "cat-file", "-p", gitBlob("idx only\n"))).toBe("idx only");
  expect(fixtureGit(out, "ls-files", "-s")).toBe(index);
  // And it is still the materialisation it was: the selected repository is not read again to reuse it.
  const again = await run(snapshot, join(scratch(), "nowhere"), target);
  expect(again.reused).toBe(true);
});

test("a repository written from a sha256 destination keeps its object format", async () => {
  const probe = scratch();
  let supported = true;
  try { fixtureGit(probe, "init", "--object-format=sha256", "--initial-branch=main"); } catch { supported = false; }
  if (!supported) return;
  const repo = scratch();
  fixtureGit(repo, "init", "--object-format=sha256", "--initial-branch=main");
  put(repo, "a.txt", "one\n");
  put(repo, "b.txt", "two\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "base");
  const dest = cloneOf(repo);
  put(repo, "a.txt", "one modified\n");
  put(repo, "staged.txt", "staged\n");
  fixtureGit(repo, "add", "staged.txt");
  rmSync(join(repo, "staged.txt"));
  format = "sha256";
  try {
    const snapshot = await take(repo);
    expect(snapshot.metadata.objectFormat).toBe("sha256");
    const target = newTarget();
    const result = await run(snapshot, dest, target);
    expect(fixtureGit(result.repo, "rev-parse", "--show-object-format")).toBe("sha256");
    expect(fixtureGit(result.repo, "ls-files", "-s")).toBe(fixtureGit(repo, "ls-files", "-s"));
    expect(fixtureGit(result.repo, "cat-file", "-p", gitBlob("staged\n"))).toBe("staged");
    expect(() => fixtureGit(result.repo, "fsck", "--full")).not.toThrow();
    // A sha1 destination cannot supply a sha256 snapshot's commit.
    const { repo: other } = sourceRepo();
    expect(await refusal(snapshot, other)).toMatchObject({ code: "repo-object-format", created: false });
  } finally { format = "sha1"; }
});

// ---------------------------------------------------------------------------

test("the source and the selected repository are left exactly as they were, and an object the destination already holds is not freshened", async () => {
  const { repo } = sourceRepo();
  const dest = cloneOf(repo);
  // The destination has a life of its own: a staged change, a dirty file, an untracked one.
  put(dest, "a.txt", "destination edit\n");
  fixtureGit(dest, "add", "a.txt");
  put(dest, "clean.txt", "destination dirty\n");
  put(dest, "destination-only.txt", "d\n");
  dirty(repo);
  // It already holds one blob the snapshot carries, long ago.
  const staged = join(scratch(), "s1.txt");
  writeFileSync(staged, "s1\n");
  const oid = fixtureGit(dest, "hash-object", "-w", staged);
  expect(oid).toBe(gitBlob("s1\n"));
  const loose = join(dest, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  utimesSync(loose, 1_000_000_000, 1_000_000_000);

  const snapshot = await take(repo, ["ignored.log"]);
  const sourceBefore = fingerprint(repo);
  const destBefore = fingerprint(dest);
  const target = newTarget();
  await run(snapshot, dest, target);
  expect(fingerprint(dest)).toEqual(destBefore);
  expect(fingerprint(repo)).toEqual(sourceBefore);
  expect(statSync(loose).mtimeMs).toBe(1_000_000_000_000);
  // The index blob it already held is nonetheless in the new repository's own object store.
  expect(fixtureGit(join(target, "repo"), "cat-file", "-p", oid)).toBe("s1");

  // A refusal is as read-only as a success.
  const refused = await refusal({ ...snapshot, metadataDigest: "0".repeat(64) }, dest);
  expect(refused).toMatchObject({ code: "snapshot-mismatch", created: false });
  expect(fingerprint(dest)).toEqual(destBefore);
});

test("no program runs: hooks, filters, templates and steering variables are all inert, and the new repository carries none of them", async () => {
  const { repo } = sourceRepo();
  put(repo, ".gitattributes", "* filter=x\n");
  fixtureGit(repo, "add", ".gitattributes");
  fixtureGit(repo, "commit", "-m", "attributes");
  const dest = cloneOf(repo);
  dirty(repo);

  const sentinel = join(scratch(), "ran");
  const hooks = scratch();
  const template = scratch();
  for (const hook of ["post-checkout", "reference-transaction", "post-index-change", "pre-commit", "post-commit", "post-merge"]) {
    put(hooks, hook, `#!/bin/sh\necho ${hook} >> ${sentinel}\n`, 0o755);
    put(template, `hooks/${hook}`, `#!/bin/sh\necho template-${hook} >> ${sentinel}\n`, 0o755);
  }
  const globalConfig = join(process.env.HOME!, ".gitconfig");
  writeFileSync(globalConfig, [
    '[filter "x"]', `\tclean = sh -c 'echo clean >> ${sentinel}; cat'`, `\tsmudge = sh -c 'echo smudge >> ${sentinel}; cat'`,
    "[core]", `\thooksPath = ${hooks}`, "[init]", `\ttemplateDir = ${template}`, "",
  ].join("\n"));
  const steer = {
    GIT_DIR: "/nonexistent/elsewhere", GIT_INDEX_FILE: "/nonexistent/index", GIT_WORK_TREE: "/nonexistent", GIT_OBJECT_DIRECTORY: "/nonexistent/objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/nonexistent/alternates", GIT_NAMESPACE: "elsewhere", GIT_TEMPLATE_DIR: template,
  };
  try {
    const snapshot = await take(repo, ["ignored.log"]);
    Object.assign(process.env, steer);
    const target = newTarget();
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run(snapshot, dest, target); } finally { for (const key of Object.keys(steer)) delete process.env[key]; }
    const out = result.repo;
    expect(existsSync(sentinel)).toBe(false);
    // The working tree is the snapshot's, with the attributes file and its filter neither run nor applied.
    expect(worktreeOf(out)[".gitattributes"]).toBe("644:* filter=x\n");
    expect(fixtureGit(out, "ls-files", "-s")).toBe(fixtureGit(repo, "ls-files", "-s"));

    const hooksDir = join(out, ".git", "hooks");
    expect(existsSync(hooksDir) ? readdirSync(hooksDir) : []).toEqual([]);
    expect(existsSync(join(out, ".git", "info", "exclude"))).toBe(false);
    // Config: only the repository's own (and the command line's, which fixtureGit itself adds), no remote, no filter.
    const scopes = fixtureGit(out, "config", "--list", "--show-scope").split("\n").map(one => one.split("\t")[0]);
    expect(scopes.every(scope => scope === "local" || scope === "command")).toBe(true);
    const local = fixtureGit(out, "config", "--local", "--list");
    for (const word of ["remote", "filter", "hookspath", "url", "credential", "alias"]) expect(local.toLowerCase()).not.toContain(word);

    // The control: the same hook and filter are live for plain git under this global config, so the sentinel would have been written.
    const probe = scratch();
    const plain = Bun.spawnSync(["git", "init", "--quiet", probe], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(plain.exitCode).toBe(0);
    expect(existsSync(join(probe, ".git", "hooks", "post-index-change"))).toBe(true);
  } finally { rmSync(globalConfig, { force: true }); }
});

test("a destination whose own config would start a program or fetch is refused before anything exists", async () => {
  const { repo } = sourceRepo();
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);
  const marker = join(scratch(), "filter-ran");
  for (const [key, value, path] of [
    ["filter.x.clean", `sh -c 'echo clean >> ${marker}; cat'`, "filter.<subsection>.clean"],
    ["core.hooksPath", "/tmp/elsewhere", "core.hookspath"],
    ["remote.origin.promisor", "true", "remote.<subsection>.promisor"],
  ] as const) {
    const dest = cloneOf(repo);
    fixtureGit(dest, "config", key, value);
    const refused = await refusal(snapshot, dest);
    expect(refused, key).toMatchObject({ code: "repo-unsafe-config", created: false });
    expect(refused.path?.toLowerCase(), key).toBe(path.toLowerCase());
  }
  expect(existsSync(marker)).toBe(false);
});

// ---------------------------------------------------------------------------

test("everything that can be refused is refused before the destination exists", async () => {
  const { repo } = sourceRepo();
  const dest = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);
  const head = snapshot.metadata.head;

  // A destination that lacks the commit.
  const unrelated = scratch();
  fixtureGit(unrelated, "init", "--initial-branch=main");
  put(unrelated, "other.txt", "a different history\n");
  fixtureGit(unrelated, "add", ".");
  fixtureGit(unrelated, "commit", "-m", "elsewhere");
  expect(await refusal(snapshot, unrelated)).toMatchObject({ code: "repo-revision-missing", path: head, created: false });
  // Not a repository, not a top level.
  expect(await refusal(snapshot, scratch())).toMatchObject({ code: "repo-git-failed", created: false });
  expect(await refusal(snapshot, join(dest, "dir"))).toMatchObject({ code: "repo-not-toplevel", created: false });
  expect(await refusal(snapshot, "relative/repo")).toMatchObject({ code: "root-invalid", created: false });

  // A tree, and a blob HEAD's tree needs, that the destination's store does not hold. These are missing objects and not budgets.
  const noTree = cloneOf(repo);
  dropObject(noTree, fixtureGit(noTree, "rev-parse", "HEAD:dir"));
  expect(await refusal(snapshot, noTree)).toMatchObject({ code: "repo-object-missing", created: false });
  const noBlob = cloneOf(repo);
  dropObject(noBlob, fixtureGit(noBlob, "rev-parse", "HEAD:clean.txt"));
  expect(await refusal(snapshot, noBlob)).toMatchObject({ code: "repo-object-missing", created: false });

  // A branch git cannot hold, or one that could be read as another ref.
  for (const branch of ["refs/heads/main", "refs/remotes/origin/main", "a..b", "x.lock", "", "has space", "x".repeat(2000)]) {
    const forged = rebuild(snapshot, { metadata: metadata => ({ ...metadata, branch }) });
    expect(await refusal(forged, dest), JSON.stringify(branch.slice(0, 20))).toMatchObject({ code: "repo-branch-invalid", created: false });
  }

  // A carried path that folds onto a file the bundle already carries is the bundle's own refusal, before materialising is reached: `dirty()` changed `a.txt`.
  expect(caughtSync(() => withUntracked(snapshot, { "A.TXT": "1" }))).toMatchObject({ code: "path-duplicate" });
  // A carried path that folds onto HEAD's clean `clean.txt` (a clean file is not in the bundle, so the bundle holds no collision and materialising is what refuses it),
  // and one under that clean file.
  expect(await refusal(withUntracked(snapshot, { "CLEAN.TXT": "1" }), dest)).toMatchObject({ code: "path-duplicate", created: false });
  expect(await refusal(withUntracked(snapshot, { "clean.txt/y": "under a file" }), dest)).toMatchObject({ code: "path-conflict", created: false });
  // A name that could read as `.git` on some disk is never written, whatever its spelling.
  expect(await refusal(withUntracked(snapshot, { ".git‌/config": "x" }), dest)).toMatchObject({ code: "path-reserved", created: false });
  expect(await refusal(withUntracked(snapshot, { "GIT~1/config": "x" }), dest)).toMatchObject({ code: "path-reserved", created: false });

  // A tampered snapshot: a bundle entry no change names, an index blob under the wrong object id, an index blob a change claims and the bundle lacks.
  const extra = rebuild(snapshot, { entries: entries => [...entries, { path: "extra.txt", class: "workspace", mode: 0o644, bytes: Buffer.from("extra\n") }] });
  expect(await refusal(extra, dest)).toMatchObject({ code: "snapshot-mismatch", path: "extra.txt", created: false });
  const wrongOid = rebuild(snapshot, { entries: entries => entries.map(one => "bytes" in one && one.path.startsWith(INDEX_BLOB_PREFIX) ? { ...one, bytes: Buffer.from("tampered\n") } : one) });
  expect(await refusal(wrongOid, dest)).toMatchObject({ code: "snapshot-mismatch", created: false });
  expect((await refusal(wrongOid, dest)).path?.startsWith(INDEX_BLOB_PREFIX)).toBe(true);
  const lacking = rebuild(snapshot, { entries: entries => entries.filter(one => !one.path.startsWith(INDEX_BLOB_PREFIX)) });
  expect(await refusal(lacking, dest)).toMatchObject({ code: "snapshot-mismatch", created: false });
  // A claim about HEAD's tree that the destination's tree does not bear out.
  const liar = rebuild(snapshot, { metadata: metadata => ({ ...metadata, clean: metadata.clean + 1 }) });
  expect(await refusal(liar, dest)).toMatchObject({ code: "snapshot-mismatch", path: "clean", created: false });
  // A genuine pair is a genuine pair only as a whole.
  expect(await refusal({ ...snapshot, metadataDigest: "0".repeat(64) }, dest)).toMatchObject({ code: "snapshot-mismatch", created: false });

  // A staged object that is neither in HEAD's tree nor carried cannot be conjured, and is not fetched from anywhere.
  const ghost = rebuild(snapshot, { metadata: metadata => ({
    ...metadata, tracked: metadata.tracked + 1,
    changes: [...metadata.changes, { path: "ghost.txt", status: "A ", head: null, index: { mode: "100644", oid: "1".repeat(metadata.head.length) }, worktree: null, carried: "none" }],
  }) });
  expect(await refusal(ghost, dest)).toMatchObject({ code: "repo-object-missing", path: "ghost.txt", created: false });

  // The destination named must not contain, or be inside, the selected repository.
  expect(await caught(() => run(snapshot, dest, join(dest, "inside")))).toMatchObject({ code: "destination-invalid" });
  expect(existsSync(join(dest, "inside"))).toBe(false);
  expect(await caught(() => run(snapshot, dest, "relative/out"))).toMatchObject({ code: "destination-invalid" });
  expect(await caught(() => run(snapshot, dest, join(scratch(), "missing-parent", "out")))).toMatchObject({ code: "destination-invalid" });
  expect(await caught(() => run(snapshot, dest, newTarget(), { operation: "not a token" }))).toMatchObject({ code: "operation-invalid" });
  expect(await caught(() => run(snapshot, dest, newTarget(), { limits: { ...LIM, maxEntries: -1 } }))).toMatchObject({ code: "limits-invalid" });
});

test("a history that would not copy faithfully is named, never copied short", async () => {
  const repo = historyRepo();
  const snapshot = await take(repo);

  const shallow = join(scratch(), "shallow");
  fixtureGit(scratch(), "clone", "-q", "--depth", "1", `file://${repo}`, shallow);
  expect(existsSync(join(shallow, ".git", "shallow"))).toBe(true);
  expect(await refusal(snapshot, shallow)).toMatchObject({ code: "repo-history-unsupported", path: "shallow", created: false });

  const grafted = cloneOf(repo);
  mkdirSync(join(grafted, ".git", "info"), { recursive: true });
  writeFileSync(join(grafted, ".git", "info", "grafts"), "");
  expect(await refusal(snapshot, grafted)).toMatchObject({ code: "repo-history-unsupported", path: "grafts", created: false });

  const replaced = cloneOf(repo);
  fixtureGit(replaced, "replace", fixtureGit(replaced, "rev-parse", "HEAD~1"), fixtureGit(replaced, "rev-parse", "HEAD~2"));
  expect(await refusal(snapshot, replaced)).toMatchObject({ code: "repo-history-unsupported", path: "replace", created: false });

  // A blob only an older commit needs is missing: HEAD's tree is whole, and the pack cannot be.
  const hollow = cloneOf(repo);
  dropObject(hollow, fixtureGit(hollow, "rev-parse", "HEAD~2:old.txt"));
  expect(await refusal(snapshot, hollow)).toMatchObject({ code: "repo-object-missing", path: "history", created: false });
});

// ---------------------------------------------------------------------------

test("a failure at any step removes what was made, and only that", async () => {
  const { repo } = sourceRepo();
  const dest = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);

  for (const step of ["init", "pack", "objects", "worktree", "index", "refs"] as const) {
    const target = newTarget();
    const error = await caught(() => run(snapshot, dest, target, { observe: { afterStep: reached => { if (reached === step) throw new Error("stop here"); } } }));
    expect(error?.code, step).toBe("stage-io");
    expect(existsSync(target), step).toBe(false);
  }

  // A foreign file appears in the new repository and then something fails: it is left, named, with the marker that still names the rest.
  const foreign = newTarget();
  const inserted = await caught(() => run(snapshot, dest, foreign, { observe: { afterStep: step => {
    if (step === "worktree") { writeFileSync(join(foreign, "repo", "foreign.txt"), "not ours\n"); throw new Error("stop here"); }
  } } }));
  expect(inserted).toMatchObject({ code: "stage-ambiguous" });
  expect(readFileSync(join(foreign, "repo", "foreign.txt"), "utf8")).toBe("not ours\n");
  expect(existsSync(join(foreign, ".imprnt-materialize.json"))).toBe(true);
  // Everything this call did make was removed, by identity.
  expect(existsSync(join(foreign, "repo", ".git"))).toBe(false);
  expect(existsSync(join(foreign, "repo", "a.txt"))).toBe(false);
  expect(readdirSync(join(foreign, "repo"))).toEqual(["foreign.txt"]);

  // A file of ours replaced by another object (same bytes or not) is not ours to remove.
  const replaced = newTarget();
  const swapped = await caught(() => run(snapshot, dest, replaced, { observe: { afterStep: step => {
    if (step === "worktree") { unlinkSync(join(replaced, "repo", "a.txt")); writeFileSync(join(replaced, "repo", "a.txt"), "replaced\n"); throw new Error("stop here"); }
  } } }));
  expect(swapped).toMatchObject({ code: "stage-ambiguous" });
  expect(readFileSync(join(replaced, "repo", "a.txt"), "utf8")).toBe("replaced\n");

  // A git call that fails leaves what it made unrecorded: the lock someone else holds stops update-index, and is left where it is.
  const locked = newTarget();
  const failed = await caught(() => run(snapshot, dest, locked, { observe: { afterStep: step => {
    if (step === "worktree") writeFileSync(join(locked, "repo", ".git", "index.lock"), "held\n");
  } } }));
  expect(failed).toMatchObject({ code: "stage-ambiguous" });
  expect(readFileSync(join(locked, "repo", ".git", "index.lock"), "utf8")).toBe("held\n");
  expect(existsSync(join(locked, ".imprnt-materialize.json"))).toBe(true);
});

test("a completed materialisation is reused only as the same operation for the same snapshot, and only while nothing in it has changed", async () => {
  const { repo } = sourceRepo();
  const dest = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);
  const target = newTarget();
  const first = await run(snapshot, dest, target);
  const before = fingerprint(target);

  // Reuse reads the directory and the new repository, never the selected one.
  const again = await run(snapshot, join(scratch(), "nowhere"), target);
  expect(again).toMatchObject({ reused: true, repo: first.repo, head: first.head, files: first.files, links: first.links });
  expect(again.receipt).toEqual(first.receipt);
  expect(fingerprint(target)).toEqual(before);

  expect(await caught(() => run(snapshot, dest, target, { operation: "op-2" }))).toMatchObject({ code: "destination-foreign" });
  put(repo, "a.txt", "another state\n");
  const other = await take(repo, ["ignored.log"]);
  expect(await caught(() => run(other, dest, target))).toMatchObject({ code: "destination-foreign" });
  expect(fingerprint(target)).toEqual(before);

  // Something added to the tree, then a recorded file changed: neither is reused and neither is touched.
  put(target, "repo/zzz.txt", "added\n");
  expect(await caught(() => run(snapshot, dest, target))).toMatchObject({ code: "stage-ambiguous", path: "repo/zzz.txt" });
  expect(readFileSync(join(target, "repo", "zzz.txt"), "utf8")).toBe("added\n");
  unlinkSync(join(target, "repo", "zzz.txt"));
  appendFileSync(join(target, "repo", "a.txt"), "tampered\n");
  expect(await caught(() => run(snapshot, dest, target))).toMatchObject({ code: "stage-ambiguous", path: "repo/a.txt" });
  expect(readFileSync(join(target, "repo", "a.txt"), "utf8")).toBe("one modified\ntampered\n");

  // Directories this call did not make are never adopted.
  const empty = newTarget();
  mkdirSync(empty);
  expect(await caught(() => run(snapshot, dest, empty))).toMatchObject({ code: "destination-exists" });
  const occupied = newTarget();
  put(occupied, "keep.txt", "mine\n");
  expect(await caught(() => run(snapshot, dest, occupied))).toMatchObject({ code: "destination-exists" });
  expect(readdirSync(occupied)).toEqual(["keep.txt"]);
  const lone = newTarget();
  put(lone, ".imprnt-materialize.json.tmp", "{}");
  expect(await caught(() => run(snapshot, dest, lone))).toMatchObject({ code: "stage-ambiguous", path: ".imprnt-materialize.json.tmp" });
  const forged = newTarget();
  put(forged, ".imprnt-materialize.json", "not a marker");
  expect(await caught(() => run(snapshot, dest, forged))).toMatchObject({ code: "destination-foreign" });
  const linked = newTarget();
  symlinkSync(scratch(), linked);
  expect(await caught(() => run(snapshot, dest, linked))).toMatchObject({ code: "destination-exists" });
});

test("discard removes exactly what the receipt's marker lists, and nothing it cannot show was made", async () => {
  const { repo } = sourceRepo();
  const dest = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);

  const target = newTarget();
  const { receipt } = await run(snapshot, dest, target);
  expect(receipt).toMatchObject({ destination: target, repo: join(target, "repo"), operation: "op-1", metadataDigest: snapshot.metadataDigest });
  discardMaterialized({ receipt });
  expect(existsSync(target)).toBe(false);
  // The destination is gone, and a receipt for it is stale, not an error that removes something else.
  expect(caughtSync(() => discardMaterialized({ receipt }))).toMatchObject({ code: "stage-stale" });

  // A new materialisation at the same path is a new generation: the old receipt does not reach it.
  const again = await run(snapshot, dest, target);
  expect(again.receipt.generation).not.toBe(receipt.generation);
  const untouched = fingerprint(target);
  expect(caughtSync(() => discardMaterialized({ receipt }))).toMatchObject({ code: "stage-stale" });
  expect(fingerprint(target)).toEqual(untouched);

  // A file someone added: nothing at all is removed.
  put(target, "repo/added.txt", "not ours\n");
  const withAddition = fingerprint(target);
  expect(caughtSync(() => discardMaterialized({ receipt: again.receipt }))).toMatchObject({ code: "stage-ambiguous", path: "repo/added.txt" });
  expect(fingerprint(target)).toEqual(withAddition);
  unlinkSync(join(target, "repo", "added.txt"));

  // A recorded file changed, or git used in the repository since (a commit moves a ref and adds objects): neither is discarded.
  appendFileSync(join(target, "repo", "a.txt"), "edited\n");
  const edited = fingerprint(target);
  expect(caughtSync(() => discardMaterialized({ receipt: again.receipt }))).toMatchObject({ code: "stage-ambiguous", path: "repo/a.txt" });
  expect(fingerprint(target)).toEqual(edited);

  const used = newTarget();
  const usedResult = await run(snapshot, dest, used);
  fixtureGit(usedResult.repo, "commit", "--allow-empty", "-m", "work done here");
  const afterUse = fingerprint(used);
  expect(caughtSync(() => discardMaterialized({ receipt: usedResult.receipt }))?.code).toBe("stage-ambiguous");
  expect(fingerprint(used)).toEqual(afterUse);

  // A receipt that is not one, a link for the destination, a marker of another snapshot.
  expect(caughtSync(() => discardMaterialized({ receipt: { ...again.receipt, destination: "relative" } }))).toMatchObject({ code: "destination-invalid" });
  expect(caughtSync(() => discardMaterialized({ receipt: { ...again.receipt, generation: "nope" } }))).toMatchObject({ code: "destination-invalid" });
  expect(caughtSync(() => discardMaterialized({ receipt: { ...again.receipt, entries: again.receipt.entries + 1 } }))).toMatchObject({ code: "stage-stale" });
  expect(caughtSync(() => discardMaterialized({ receipt: { ...again.receipt, metadataDigest: "0".repeat(64) } }))).toMatchObject({ code: "destination-foreign" });
  const link = join(scratch(), "link");
  symlinkSync(scratch(), link);
  expect(caughtSync(() => discardMaterialized({ receipt: { ...again.receipt, destination: link, repo: join(link, "repo") } }))).toMatchObject({ code: "destination-invalid" });
});

// ---------------------------------------------------------------------------

test("every bound refuses by name, and what can be measured beforehand leaves nothing created", async () => {
  const { repo } = sourceRepo();
  put(repo, "big.txt", "x".repeat(3000));
  fixtureGit(repo, "add", "big.txt");
  fixtureGit(repo, "commit", "-m", "a big clean file");
  const dest = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);
  const limited = (extra: Partial<MaterializeLimits>) => ({ limits: { ...LIM, ...extra } });

  // Everything written, pack and marker included.
  expect(await refusal(snapshot, dest, limited({ maxOutputBytes: 10 }))).toMatchObject({ code: "limit-total-bytes", created: false });
  // A clean file over the per-file bound, though no carried file is.
  expect(await refusal(snapshot, dest, limited({ maxFileBytes: 1000 }))).toMatchObject({ code: "limit-file-bytes", path: "big.txt", created: false });
  // A single git command's output.
  expect(await refusal(snapshot, dest, limited({ maxGitOutputBytes: 10 }))).toMatchObject({ code: "repo-git-output", created: false });
  // The history's pack, and the objects and entries it and the new repository hold.
  expect(await refusal(snapshot, dest, limited({ maxObjectBytes: 100 }))).toMatchObject({ code: "limit-object-bytes", created: false });
  expect(await refusal(snapshot, dest, limited({ maxEntries: 3 }))).toMatchObject({ code: "limit-entries", created: false });
  expect(await refusal(snapshot, dest, limited({ maxEntries: 40 }))).toMatchObject({ code: "limit-entries", created: false });
  // The scan in verification is only reached once the repository is written, and it is taken back down entirely.
  expect(await refusal(snapshot, dest, limited({ maxScanBytes: 100 }))).toMatchObject({ code: "limit-scan-bytes", created: false });
  // Bounds that are not bounds.
  for (const key of ["maxOutputBytes", "maxObjectBytes", "maxEntries", "maxGitOutputBytes", "maxScanBytes"] as const) {
    expect(await refusal(snapshot, dest, limited({ [key]: -1 } as Partial<MaterializeLimits>)), key).toMatchObject({ code: "limits-invalid", created: false });
    expect(await refusal(snapshot, dest, limited({ [key]: 1.5 } as Partial<MaterializeLimits>)), key).toMatchObject({ code: "limits-invalid", created: false });
  }
  // Generous bounds are not refused, so the refusals above were the bounds'.
  expect((await refusal(snapshot, dest)).code).toBe("none");
});

test("a history larger than the pack bound is refused and never copied short", async () => {
  const repo = historyRepo();
  const dest = cloneOf(repo);
  const snapshot = await take(repo);

  const whole = newTarget();
  const { repo: out } = await run(snapshot, dest, whole);
  const packs = readdirSync(join(out, ".git", "objects", "pack")).filter(name => name.endsWith(".pack"));
  expect(packs.length).toBe(1);
  const size = statSync(join(out, ".git", "objects", "pack", packs[0])).size;
  expect(fixtureGit(out, "rev-list", "--count", "HEAD")).toBe("3");

  // Too small for the history: refused by name, with nothing created, and not a shorter history.
  for (const maxObjectBytes of [100, Math.floor(size / 2)]) {
    const target = newTarget();
    expect(await caught(() => run(snapshot, dest, target, { limits: { ...LIM, maxObjectBytes } }))).toMatchObject({ code: "limit-object-bytes" });
    expect(existsSync(target)).toBe(false);
  }
  // The bound on the objects themselves, apart from their bytes.
  const crowded = newTarget();
  expect(await caught(() => run(snapshot, dest, crowded, { limits: { ...LIM, maxEntries: 5 } }))).toMatchObject({ code: "limit-entries" });
  expect(existsSync(crowded)).toBe(false);
  // Room to spare: the same history, whole.
  const roomy = newTarget();
  const copy = await run(snapshot, dest, roomy, { limits: { ...LIM, maxObjectBytes: size * 4 } });
  expect(fixtureGit(copy.repo, "rev-list", "--count", "HEAD")).toBe("3");
  expect(() => fixtureGit(copy.repo, "fsck", "--full")).not.toThrow();
});

// ---------------------------------------------------------------------------

test("a tracked clean dependency keeps the mode, size and hash the snapshot recorded, and an inconsistent record is refused", async () => {
  const { repo } = sourceRepo();
  // Tracked, clean and not 644/755: a credential file at 0600, a umask-002 file at 0664, an owner-only executable, and one that is also out of the index.
  put(repo, "private.env", "TOKEN=1\n", 0o600);
  put(repo, "group.txt", "g\n", 0o664);
  put(repo, "run-private.sh", "#!/bin/sh\necho p\n", 0o700);
  put(repo, "indexless.txt", "i\n", 0o664);
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "named dependencies");
  const dest = cloneOf(repo);
  dirty(repo);
  // An index-only change to a named dependency: its working file is HEAD's own bytes, and the index no longer has it.
  fixtureGit(repo, "rm", "-q", "--cached", "indexless.txt");
  const snapshot = await take(repo, ["private.env", "group.txt", "run-private.sh", "indexless.txt", "ignored.log"]);
  expect(Object.fromEntries(snapshot.metadata.dependencies.map(one => [one.path, `${one.state}:${one.mode.toString(8)}`]))).toEqual({
    "private.env": "tracked-clean:600", "group.txt": "tracked-clean:664", "run-private.sh": "tracked-clean:700", "indexless.txt": "tracked-clean:664", "ignored.log": "carried:644",
  });
  // Plain reads only: an asymmetric matcher (`expect.anything()`) inside `toMatchObject` rewrites the actual object under Bun, and this snapshot is what is materialised.
  const indexless = snapshot.metadata.changes.find(one => one.path === "indexless.txt");
  expect(indexless?.head?.mode).toBe("100644");
  expect(indexless?.index).toBeNull();
  expect(indexless?.carried).toBe("none");
  const digest = snapshot.metadataDigest;

  const target = newTarget();
  const first = await run(snapshot, dest, target);
  const out = first.repo;
  expect(snapshot.metadataDigest).toBe(digest);
  expect(metadataDigestOf(snapshot.metadata)).toBe(digest);
  // The exact modes on disk, not the 644/755 a clean file otherwise gets, and everything else as the source has it.
  for (const [path, mode] of [["private.env", 0o600], ["group.txt", 0o664], ["run-private.sh", 0o700], ["indexless.txt", 0o664]] as const) {
    expect(statSync(join(out, path)).mode & 0o777, path).toBe(mode);
  }
  expect(worktreeOf(out)["private.env"]).toBe("600:TOKEN=1\n");
  const expected = worktreeOf(repo);
  delete expected[".env"];
  expect(worktreeOf(out)).toEqual(expected);
  expect(fixtureGit(out, "ls-files", "-s")).toBe(fixtureGit(repo, "ls-files", "-s"));
  // The same verification a reuse gets passes, and reads the new repository alone.
  const before = fingerprint(target);
  expect(await run(snapshot, join(scratch(), "nowhere"), target)).toMatchObject({ reused: true, head: first.head });
  expect(fingerprint(target)).toEqual(before);

  // Records that do not agree with the tree or the changes are refused, and nothing is created.
  const edited = (path: string, change: (dep: RepoMetadata["dependencies"][number]) => RepoMetadata["dependencies"][number]) => rebuild(snapshot, {
    metadata: metadata => ({ ...metadata, dependencies: metadata.dependencies.map(dep => dep.path === path ? change(dep) : dep) }),
  });
  const mismatches: [string, Snap][] = [
    ["group.txt", edited("group.txt", dep => ({ ...dep, mode: 0o775 }))],              // executable, where HEAD's entry is not
    ["run-private.sh", edited("run-private.sh", dep => ({ ...dep, mode: 0o600 }))],    // not executable, where HEAD's entry is
    ["private.env", edited("private.env", dep => ({ ...dep, mode: 0 }))],              // not a permission a readable file has
    ["group.txt", edited("group.txt", dep => ({ ...dep, size: dep.size + 1 }))],       // not the blob's size
    ["private.env", edited("private.env", dep => ({ ...dep, state: "carried" }))],     // carried, and no change carries it
    ["ignored.log", edited("ignored.log", dep => ({ ...dep, state: "tracked-clean" }))], // tracked-clean, and a change carries it
    ["ignored.log", edited("ignored.log", dep => ({ ...dep, size: dep.size + 1 }))],   // not the carried file's size
    ["indexless.txt", edited("indexless.txt", dep => ({ ...dep, size: dep.size + 1 }))],
    ["indexless.txt", edited("indexless.txt", dep => ({ ...dep, mode: 0o755 }))],
    ["nowhere.txt", rebuild(snapshot, { metadata: metadata => ({ ...metadata, dependencies: [...metadata.dependencies, { path: "nowhere.txt", state: "tracked-clean", mode: 0o644, size: 1, sha256: "0".repeat(64) }] }) })],
    ["group.txt", rebuild(snapshot, { metadata: metadata => ({ ...metadata, dependencies: [...metadata.dependencies, metadata.dependencies.find(dep => dep.path === "group.txt")!] }) })],
  ];
  for (const [path, forged] of mismatches) {
    expect(await refusal(forged, dest), path).toMatchObject({ code: "snapshot-mismatch", path, created: false });
  }
  // A hash that is well formed but is not the file's: only the bytes can say so, and they are read back before anything is reported done, then all taken down.
  const wrongHash = await refusal(edited("private.env", dep => ({ ...dep, sha256: "1".repeat(64) })), dest);
  expect(wrongHash).toMatchObject({ code: "materialize-verify", path: "private.env", created: false });
});

// ---------------------------------------------------------------------------

test("a selected repository that reaches into another object store is refused by name before anything exists, and a linked worktree is not one", async () => {
  const { repo } = sourceRepo();
  const plain = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);

  // Fixtures of this test's own: a shared clone, a reference clone, a hand-written http alternates file, and a dangling link where the alternates file would be.
  const shared = join(scratch(), "shared");
  fixtureGit(scratch(), "clone", "-q", "--shared", repo, shared);
  const referenced = join(scratch(), "referenced");
  fixtureGit(scratch(), "clone", "-q", "--reference", repo, repo, referenced);
  const http = cloneOf(repo);
  mkdirSync(join(http, ".git", "objects", "info"), { recursive: true });
  writeFileSync(join(http, ".git", "objects", "info", "http-alternates"), "https://example.invalid/objects\n");
  const dangling = cloneOf(repo);
  mkdirSync(join(dangling, ".git", "objects", "info"), { recursive: true });
  symlinkSync(join(scratch(), "nowhere"), join(dangling, ".git", "objects", "info", "alternates"));

  for (const [name, dir, file] of [["shared", shared, "alternates"], ["reference", referenced, "alternates"], ["http", http, "http-alternates"], ["dangling", dangling, "alternates"]] as const) {
    expect(() => lstatSync(join(dir, ".git", "objects", "info", file)), name).not.toThrow();
    const before = fingerprint(dir);
    expect(await refusal(snapshot, dir), name).toMatchObject({ code: "repo-history-unsupported", path: "alternates", created: false });
    expect(fingerprint(dir), name).toEqual(before);
  }

  // A linked worktree shares its main repository's ordinary object store, which has no alternates file: it is used as it is.
  const linked = join(scratch(), "linked");
  fixtureGit(plain, "worktree", "add", "-q", "--detach", linked);
  expect(existsSync(join(plain, ".git", "worktrees"))).toBe(true);
  expect(existsSync(join(plain, ".git", "objects", "info", "alternates"))).toBe(false);
  const target = newTarget();
  expect(await run(snapshot, linked, target)).toMatchObject({ reused: false, branch: "main", head: snapshot.metadata.head });
  expect(fixtureGit(join(target, "repo"), "ls-files", "-s")).toBe(fixtureGit(repo, "ls-files", "-s"));
});

// ---------------------------------------------------------------------------

test("`.git` is held to what the last checkpoint recorded before every git call that writes in it: nothing foreign or replaced is adopted, and a pack made before a later failure is still ours", async () => {
  const { repo } = sourceRepo();
  const dest = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);
  const markerOf = (target: string) => JSON.parse(readFileSync(join(target, ".imprnt-materialize.json"), "utf8"));

  // A file appears in `.git` after the refs are recorded and nothing throws: verification and completion must not adopt it.
  const added = newTarget();
  const addedError = await caught(() => run(snapshot, dest, added, { observe: { afterStep: step => {
    if (step === "refs") writeFileSync(join(added, "repo", ".git", "foreign"), "not ours\n");
  } } }));
  expect(addedError).toMatchObject({ code: "stage-ambiguous" });
  expect(readFileSync(join(added, "repo", ".git", "foreign"), "utf8")).toBe("not ours\n");
  // Never marked complete; what this call made is gone, by identity, and only the foreign file is left in `.git`.
  expect(markerOf(added).state).toBe("staging");
  expect(readdirSync(join(added, "repo", ".git"))).toEqual(["foreign"]);
  expect(readdirSync(join(added, "repo"))).toEqual([".git"]);

  // One of the files git made is replaced by another object with the same bytes: the recorded identity no longer matches, and it is left where it is.
  const replaced = newTarget();
  const headFile = join(replaced, "repo", ".git", "HEAD");
  const replacedError = await caught(() => run(snapshot, dest, replaced, { observe: { afterStep: step => {
    if (step !== "refs") return;
    const bytes = readFileSync(headFile);
    unlinkSync(headFile);
    writeFileSync(headFile, bytes);
    utimesSync(headFile, 1_000_000_000, 1_000_000_000);
  } } }));
  expect(replacedError).toMatchObject({ code: "stage-ambiguous" });
  expect(readFileSync(headFile, "utf8")).toBe("ref: refs/heads/main\n");
  expect(markerOf(replaced).state).toBe("staging");
  expect(readdirSync(join(replaced, "repo", ".git"))).toEqual(["HEAD"]);

  // The control: nothing touched, the same call completes.
  const fine = newTarget();
  expect((await run(snapshot, dest, fine)).reused).toBe(false);
  expect(markerOf(fine).state).toBe("complete");

  // Files that are not ours appear right after `init` (regular files where an object's fan-out directory would be made) and nothing throws: the next
  // git call is not run, so its checkpoint can never adopt them. It is refused before `index-pack`, nothing is packed, what `init` made is removed
  // and the blockers are left as they were.
  const prefixes = new Set(["s1\n", "ns\n", "idx only\n"].map(text => gitBlob(text).slice(0, 2)));
  const blockers = (target: string) => { for (const prefix of prefixes) writeFileSync(join(target, "repo", ".git", "objects", prefix), "blocked\n"); };
  const blockersLeft = (target: string) => {
    const objects = join(target, "repo", ".git", "objects");
    expect(readdirSync(objects).sort()).toEqual([...prefixes].sort());
    for (const prefix of prefixes) expect(readFileSync(join(objects, prefix), "utf8")).toBe("blocked\n");
  };
  const blocked = newTarget();
  let reachedPack = false;
  const blockedError = await caught(() => run(snapshot, dest, blocked, { observe: { afterStep: step => {
    if (step === "init") blockers(blocked);
    if (step === "pack") reachedPack = true;
  } } }));
  expect(blockedError).toMatchObject({ code: "stage-ambiguous" });
  expect(blockedError?.path).toBe("repo/.git/objects");
  expect(reachedPack).toBe(false);
  blockersLeft(blocked);
  expect(markerOf(blocked).state).toBe("staging");

  // `index-pack` succeeds and is recorded, then the blockers appear: the loose writes are never attempted, the pack and its sidecars (made by a call
  // that succeeded) are removed by identity, and the files that are not ours are not.
  const afterPack = newTarget();
  let sawPack = false;
  const afterPackError = await caught(() => run(snapshot, dest, afterPack, { observe: { afterStep: step => {
    if (step !== "pack") return;
    sawPack = readdirSync(join(afterPack, "repo", ".git", "objects", "pack")).some(name => name.endsWith(".pack"));
    blockers(afterPack);
  } } }));
  expect(sawPack).toBe(true);
  expect(afterPackError).toMatchObject({ code: "stage-ambiguous" });
  blockersLeft(afterPack);

  // An earlier file of ours replaced by another object (same bytes) before a later git call that would succeed: that call's checkpoint must not
  // adopt the replacement, so it is refused before the call, and the replacement is left with its bytes.
  const swapped = newTarget();
  const swappedHead = join(swapped, "repo", ".git", "HEAD");
  const swappedError = await caught(() => run(snapshot, dest, swapped, { observe: { afterStep: step => {
    if (step !== "pack") return;
    const bytes = readFileSync(swappedHead);
    unlinkSync(swappedHead);
    writeFileSync(swappedHead, bytes);
    utimesSync(swappedHead, 1_000_000_000, 1_000_000_000);
  } } }));
  expect(swappedError).toMatchObject({ code: "stage-ambiguous", path: "repo/.git/HEAD" });
  expect(readFileSync(swappedHead, "utf8")).toBe("ref: refs/heads/main\n");
  expect(markerOf(swapped).state).toBe("staging");
  expect(readdirSync(join(swapped, "repo", ".git"))).toEqual(["HEAD"]);

  // The same between the index and the refs: a file that appears after the index was recorded is not adopted by the ref writes, which never run.
  const late = newTarget();
  const lateError = await caught(() => run(snapshot, dest, late, { observe: { afterStep: step => {
    if (step === "index") writeFileSync(join(late, "repo", ".git", "foreign-late"), "not ours\n");
  } } }));
  expect(lateError).toMatchObject({ code: "stage-ambiguous", path: "repo/.git" });
  expect(readFileSync(join(late, "repo", ".git", "foreign-late"), "utf8")).toBe("not ours\n");
  expect(readdirSync(join(late, "repo", ".git"))).toEqual(["foreign-late"]);
  expect(readdirSync(join(late, "repo"))).toEqual([".git"]);
});

// ---------------------------------------------------------------------------

test("the complete marker replaces only the marker this call wrote and settled: a replaced or edited one is refused, kept with its bytes, and never overwritten", async () => {
  const { repo } = sourceRepo();
  const dest = cloneOf(repo);
  dirty(repo);
  const snapshot = await take(repo, ["ignored.log"]);
  const name = ".imprnt-materialize.json";
  /** Past one clock tick, so a change made after the marker settled cannot share its change time. */
  const tick = () => { const until = Date.now() + 30; while (Date.now() < until) { /* wait */ } };

  /** The marker is changed after the refs are recorded and nothing throws: the operation must refuse, and leave exactly the changed marker. */
  const refused = async (label: string, change: (marker: string) => void, bytes: (marker: string) => Buffer | string) => {
    const target = newTarget();
    const marker = join(target, name);
    let result: unknown = null;
    let wanted: Buffer | string = "";
    const error = await caught(async () => {
      result = await run(snapshot, dest, target, { observe: { afterStep: step => {
        if (step !== "refs") return;
        change(marker);
        wanted = bytes(marker);
      } } });
    });
    expect(error, label).toMatchObject({ code: "stage-ambiguous", path: name });
    expect(result, label).toBeNull();
    // The changed marker is exactly as it was left, still one regular file, and it is all that is left: what this call made is gone, by identity.
    expect(lstatSync(marker).isFile(), label).toBe(true);
    expect(readFileSync(marker).equals(Buffer.from(wanted)), label).toBe(true);
    expect(readdirSync(target), label).toEqual([name]);
    return target;
  };

  // Replaced by another regular file (unlinked, then written anew) with other bytes.
  await refused("replaced", marker => { unlinkSync(marker); writeFileSync(marker, "not ours\n"); }, () => "not ours\n");

  // Replaced by a file that holds the very bytes the marker had: still another object.
  await refused("replaced, same bytes", marker => {
    const bytes = readFileSync(marker);
    unlinkSync(marker);
    writeFileSync(marker, bytes);
  }, marker => readFileSync(marker));

  // Edited in place (same file, other size).
  await refused("edited in place", marker => { writeFileSync(marker, "not ours\n"); }, () => "not ours\n");

  // Edited in place to the same size, with its modification time put back: only the change time tells, which the settled identity holds.
  await refused("edited in place, same size and mtime", marker => {
    const before = lstatSync(marker);
    tick();
    writeFileSync(marker, Buffer.alloc(before.size, "x"));
    utimesSync(marker, before.atimeMs / 1000, before.mtimeMs / 1000);
    expect(lstatSync(marker).size).toBe(before.size);
    expect(lstatSync(marker).ino).toBe(before.ino);
  }, marker => Buffer.alloc(lstatSync(marker).size, "x"));

  // Replaced by a link: not a regular file, not ours, and the link is left where it is.
  const outside = join(scratch(), "elsewhere");
  writeFileSync(outside, "kept\n");
  const linked = newTarget();
  const linkedError = await caught(() => run(snapshot, dest, linked, { observe: { afterStep: step => {
    if (step !== "refs") return;
    unlinkSync(join(linked, name));
    symlinkSync(outside, join(linked, name));
  } } }));
  expect(linkedError).toMatchObject({ code: "stage-ambiguous", path: name });
  expect(lstatSync(join(linked, name)).isSymbolicLink()).toBe(true);
  expect(readFileSync(outside, "utf8")).toBe("kept\n");
  expect(readdirSync(linked)).toEqual([name]);

  // The control: nothing touched, the same call completes, is reused as it is, and is discarded by its receipt.
  const fine = newTarget();
  const first = await run(snapshot, dest, fine);
  expect(first.reused).toBe(false);
  expect(JSON.parse(readFileSync(join(fine, name), "utf8")).state).toBe("complete");
  expect((await run(snapshot, dest, fine)).reused).toBe(true);
  discardMaterialized({ receipt: first.receipt });
  expect(existsSync(fine)).toBe(false);
});
