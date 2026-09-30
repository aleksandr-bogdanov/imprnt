// A read-only snapshot of one declared repository. The source's HEAD, index
// bytes, tracked files and untracked files come out recorded and exactly as
// they went in, and whatever would make git run a program, or leave a state
// this snapshot cannot describe truthfully, is refused by name first.
//
// The repositories are local scratch repositories on plain git, through the
// same fixture wrapper the rollout tests use. Nothing here reaches a network.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentKey, sha256Hex, TransferError, verifyBundle } from "../src/transfer/bundle.ts";
import {
  INDEX_BLOB_PREFIX, metadataDigestOf, requireLocalRevision, snapshotRepo, verifySnapshot, type RepoLimits, type RepoSnapshotOptions,
} from "../src/transfer/repos.ts";
import { fixtureGit } from "./helpers/rollout-git.ts";

const LIM: RepoLimits = { maxFiles: 50, maxFileBytes: 4096, maxTotalBytes: 65536, maxGitOutputBytes: 1 << 20, maxScanBytes: 1 << 20 };

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "transfer-repo-")));
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
      else if (stat.isSymbolicLink()) out[child] = "link";
      else out[child] = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${sha256Hex(readFileSync(join(dir, child)))}`;
    }
  };
  walk("");
  return out;
}

let format: "sha1" | "sha256" = "sha1";
const gitBlob = (text: string) => createHash(format).update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

/** A repository with one commit holding seven files, one of them executable and one ignored by pattern. */
function baseRepo(): string {
  const repo = scratch();
  fixtureGit(repo, "init", "--initial-branch=main");
  put(repo, ".gitignore", "ignored.log\n");
  put(repo, "a.txt", "one\n");
  put(repo, "b.sh", "#!/bin/sh\n", 0o755);
  put(repo, "dir/c.txt", "c\n");
  put(repo, "gone.txt", "gone\n");
  put(repo, "staged.txt", "s0\n");
  put(repo, "clean.txt", "clean\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "base");
  format = fixtureGit(repo, "rev-parse", "HEAD").length === 64 ? "sha256" : "sha1";
  return repo;
}

async function caught(run: () => Promise<unknown>): Promise<TransferError | null> {
  try { await run(); } catch (error) {
    if (error instanceof TransferError) return error;
    throw error;
  }
  return null;
}
const snap = (repo: string, extra: Partial<RepoSnapshotOptions> = {}) => snapshotRepo({ repo, limits: LIM, ...extra });
const code = async (repo: string, extra: Partial<RepoSnapshotOptions> = {}) => (await caught(() => snap(repo, extra)))?.code ?? "none";

test("dirty, staged, untracked and deleted paths are recorded with hashes and modes, and the source is left exactly as it was", async () => {
  const repo = baseRepo();
  const head = fixtureGit(repo, "rev-parse", "HEAD");
  put(repo, "a.txt", "one modified\n");
  // The same file staged with one content and changed again in the working tree.
  put(repo, "staged.txt", "s1\n");
  fixtureGit(repo, "add", "staged.txt");
  put(repo, "staged.txt", "s2\n");
  rmSync(join(repo, "gone.txt"));
  put(repo, "new-staged.txt", "ns\n");
  fixtureGit(repo, "add", "new-staged.txt");
  put(repo, "untracked.txt", "u\n");
  put(repo, ".env", "KEY=1\n");
  put(repo, "ignored.log", "noise\n");
  chmodSync(join(repo, "b.sh"), 0o644);
  // Hooks an agent could have planted: none of them may run.
  const ran = join(scratch(), "hooks-ran");
  for (const hook of ["post-index-change", "reference-transaction", "pre-commit", "post-checkout"]) {
    put(repo, `.git/hooks/${hook}`, `#!/bin/sh\necho ${hook} >> ${ran}\n`, 0o755);
  }
  const before = fingerprint(repo);
  const indexBefore = sha256Hex(readFileSync(join(repo, ".git/index")));

  // The caller's own GIT_* must not steer git at some other repository or index.
  const steer = { GIT_DIR: "/nonexistent/elsewhere", GIT_INDEX_FILE: "/nonexistent/index", GIT_WORK_TREE: "/nonexistent" };
  Object.assign(process.env, steer);
  let taken: Awaited<ReturnType<typeof snap>>;
  try { taken = await snap(repo); } finally { for (const key of Object.keys(steer)) delete process.env[key]; }

  const { metadata, bundle } = taken;
  const by = Object.fromEntries(metadata.changes.map(change => [change.path, change]));
  expect(Object.keys(by).sort()).toEqual([".env", "a.txt", "b.sh", "gone.txt", "new-staged.txt", "staged.txt", "untracked.txt"]);
  expect(metadata).toMatchObject({ version: 1, head, branch: "main", indexSha256: indexBefore, tracked: 8, clean: 3 });

  expect(by["a.txt"]).toMatchObject({
    status: " M", carried: "worktree", head: { mode: "100644", oid: gitBlob("one\n") }, index: { mode: "100644", oid: gitBlob("one\n") },
    worktree: { mode: 0o644, size: 13, sha256: sha256Hex(Buffer.from("one modified\n")), oid: gitBlob("one modified\n") },
  });
  // Staged and working copies of one file differ from each other and from HEAD, and each is kept.
  expect(by["staged.txt"]).toMatchObject({
    status: "MM", carried: "worktree", indexBlob: "carried",
    head: { oid: gitBlob("s0\n") }, index: { oid: gitBlob("s1\n") }, worktree: { oid: gitBlob("s2\n") },
  });
  expect(by["new-staged.txt"]).toMatchObject({ status: "A ", head: null, carried: "worktree" });
  expect(by["new-staged.txt"].indexBlob).toBeUndefined();
  expect(by["gone.txt"]).toMatchObject({ status: " D", carried: "tombstone", worktree: null });
  expect(by["untracked.txt"]).toMatchObject({ status: " ?", head: null, index: null, carried: "worktree" });
  expect(by["b.sh"]).toMatchObject({ status: " M", head: { mode: "100755" }, worktree: { mode: 0o644 }, carried: "worktree" });
  // Named by its name and held back: the repository's own dotenv is not swept in.
  expect(by[".env"]).toMatchObject({ carried: "withheld" });
  expect(metadata.withheld).toEqual([{ path: ".env", what: "worktree", reason: "credential-shaped-name" }]);

  expect(bundle.manifest.base).toEqual({ id: `git:${format}:${head}` });
  expect(bundle.manifest.entries.map(one => `${one.kind}:${one.path}`)).toEqual([
    `file:${INDEX_BLOB_PREFIX}${gitBlob("s1\n")}`, "file:a.txt", "file:b.sh", "delete:gone.txt", "file:new-staged.txt", "file:staged.txt", "file:untracked.txt",
  ]);
  const bytes = (path: string) => bundle.contents.get(contentKey("workspace", path))?.toString();
  expect(bytes("a.txt")).toBe("one modified\n");
  expect(bytes("staged.txt")).toBe("s2\n");
  expect(bytes(`${INDEX_BLOB_PREFIX}${gitBlob("s1\n")}`)).toBe("s1\n");
  expect(bundle.manifest.entries.find(one => one.path === "b.sh")).toMatchObject({ mode: 0o644 });
  for (const absent of [".env", "ignored.log", "clean.txt", "dir/c.txt"]) expect(bundle.contents.has(contentKey("workspace", absent)), absent).toBe(false);
  expect(() => verifyBundle(bundle, LIM)).not.toThrow();
  expect(taken.source).toEqual({ root: repo, gitDir: join(repo, ".git"), commonDir: join(repo, ".git") });

  // Nothing in the repository moved: not HEAD, not one byte of the index, not a file, not a ref or an object.
  expect(fixtureGit(repo, "rev-parse", "HEAD")).toBe(head);
  expect(sha256Hex(readFileSync(join(repo, ".git/index")))).toBe(indexBefore);
  expect(fingerprint(repo)).toEqual(before);
  expect(existsSync(ran)).toBe(false);

  const again = await snap(repo);
  expect(again.metadataDigest).toBe(taken.metadataDigest);
  expect(again.bundle.manifest.digest).toBe(bundle.manifest.digest);
});

test("a detached HEAD is recorded as no branch", async () => {
  const repo = baseRepo();
  const head = fixtureGit(repo, "rev-parse", "HEAD");
  fixtureGit(repo, "checkout", "-q", "--detach");
  expect((await snap(repo)).metadata).toMatchObject({ head, branch: null, changes: [], clean: 7 });
});

test("the caller's dependency files are honoured, each carried, verified equal to HEAD, or refused by name", async () => {
  const repo = baseRepo();
  put(repo, "ignored.log", "noise\n");
  put(repo, ".env", "KEY=1\n");
  const taken = await snap(repo, { dependencyFiles: ["ignored.log", "clean.txt", ".env"] });
  expect(taken.metadata.dependencies.map(one => `${one.path}:${one.state}`)).toEqual([".env:carried", "clean.txt:tracked-clean", "ignored.log:carried"]);
  // Named, so the dotenv is carried and not withheld; the tracked clean file is HEAD's and does not travel.
  expect(taken.bundle.manifest.entries.map(one => one.path)).toEqual([".env", "ignored.log"]);
  expect(taken.metadata.withheld).toEqual([]);

  expect(await caught(() => snap(repo, { dependencyFiles: ["nope.txt"] }))).toMatchObject({ code: "dependency-missing", path: "nope.txt" });
  rmSync(join(repo, "gone.txt"));
  expect(await caught(() => snap(repo, { dependencyFiles: ["gone.txt"] }))).toMatchObject({ code: "dependency-missing", path: "gone.txt" });
  expect(await code(repo, { dependencyFiles: ["../x"] })).toBe("path-traversal");
  expect(await code(repo, { dependencyFiles: [".git/config"] })).toBe("path-reserved");
  expect(await code(repo, { dependencyFiles: [".imprnt-transfer/x"] })).toBe("repo-reserved-path");
});

test("links, special files, nested repositories and submodules are refused by name", async () => {
  const repo = baseRepo();
  symlinkSync("a.txt", join(repo, "link"));
  fixtureGit(repo, "add", "link");
  fixtureGit(repo, "commit", "-m", "a link");
  // A tracked link left as HEAD has it is clean and is fine...
  expect((await snap(repo)).metadata).toMatchObject({ changes: [], clean: 8 });
  // ...and one that changed cannot be carried.
  rmSync(join(repo, "link"));
  symlinkSync("b.sh", join(repo, "link"));
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-symlink", path: "link" });
  rmSync(join(repo, "link"));
  symlinkSync("a.txt", join(repo, "link"));

  symlinkSync("/etc/hosts", join(repo, "untracked-link"));
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-symlink", path: "untracked-link" });
  rmSync(join(repo, "untracked-link"));

  // A tracked path that became a pipe is never opened. (Git does not list an untracked pipe at all, so it is not repository content.)
  rmSync(join(repo, "clean.txt"));
  expect(Bun.spawnSync(["mkfifo", join(repo, "clean.txt")]).exitCode).toBe(0);
  expect(await caught(() => snap(repo))).toMatchObject({ code: "special-file", path: "clean.txt" });
  rmSync(join(repo, "clean.txt"));
  put(repo, "clean.txt", "clean\n");

  const nested = join(repo, "nested");
  mkdirSync(nested);
  fixtureGit(nested, "init", "--initial-branch=main");
  put(nested, "f.txt", "inner\n");
  fixtureGit(nested, "add", ".");
  fixtureGit(nested, "commit", "-m", "inner");
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-nested", path: "nested/" });
  rmSync(nested, { recursive: true, force: true });

  fixtureGit(repo, "update-index", "--add", "--cacheinfo", `160000,${fixtureGit(repo, "rev-parse", "HEAD")},sub`);
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-submodule", path: "sub" });
});

test("a half-done operation, a conflicted path, an unborn HEAD and a state the index cannot vouch for are named, not recovered", async () => {
  const repo = baseRepo();
  fixtureGit(repo, "checkout", "-q", "-b", "topic");
  put(repo, "a.txt", "topic\n");
  fixtureGit(repo, "commit", "-qam", "topic change");
  fixtureGit(repo, "checkout", "-q", "main");
  put(repo, "a.txt", "main\n");
  fixtureGit(repo, "commit", "-qam", "main change");
  expect(() => fixtureGit(repo, "merge", "topic")).toThrow();
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-operation", path: "MERGE_HEAD" });
  // With the marker gone, the conflicted index entry is still refused, and the conflict markers in the file were never read.
  rmSync(join(repo, ".git/MERGE_HEAD"));
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-conflict", path: "a.txt" });

  const fresh = scratch();
  fixtureGit(fresh, "init", "--initial-branch=main");
  expect(await code(fresh)).toBe("repo-head-unborn");

  const flags = baseRepo();
  fixtureGit(flags, "update-index", "--assume-unchanged", "a.txt");
  expect(await caught(() => snap(flags))).toMatchObject({ code: "repo-index-flags", path: "a.txt" });
  fixtureGit(flags, "update-index", "--no-assume-unchanged", "a.txt");
  fixtureGit(flags, "update-index", "--skip-worktree", "a.txt");
  expect(await caught(() => snap(flags))).toMatchObject({ code: "repo-index-flags", path: "a.txt" });

  const reserved = baseRepo();
  put(reserved, ".imprnt-transfer/x", "x");
  fixtureGit(reserved, "add", "-f", ".imprnt-transfer/x");
  fixtureGit(reserved, "commit", "-m", "reserved");
  expect(await caught(() => snap(reserved))).toMatchObject({ code: "repo-reserved-path" });
});

test("a subdirectory or a directory that is no repository is not a declared repository", async () => {
  const repo = baseRepo();
  expect(await code(join(repo, "dir"))).toBe("repo-not-toplevel");
  expect(await code(scratch())).toBe("repo-git-failed");
  expect(await code("relative/repo")).toBe("root-invalid");
});

test("config that would start a program or fetch is refused by key before any command that could run it", async () => {
  const repo = baseRepo();
  const marker = join(scratch(), "filter-ran");
  fixtureGit(repo, "config", "filter.leak.clean", `sh -c 'echo clean >> ${marker}; cat'`);
  fixtureGit(repo, "config", "filter.leak.smudge", `sh -c 'echo smudge >> ${marker}; cat'`);
  put(repo, ".gitattributes", "* filter=leak\n");
  put(repo, "a.txt", "changed, so a status or add would have to run the filter\n");
  const refused = await caught(() => snap(repo));
  expect(refused?.code).toBe("repo-unsafe-config");
  // The key is said by its section and variable; what sits between them is the repository's own text and is not repeated.
  expect(refused?.path).toBe("filter.<subsection>.clean");
  expect(existsSync(marker)).toBe(false);
  // The control: the same filter is live, and plain git runs it on the same file.
  fixtureGit(repo, "add", "a.txt");
  expect(existsSync(marker)).toBe(true);

  const other = baseRepo();
  const keys: [string, string][] = [
    ["core.fsmonitor", "/bin/true"], ["core.hooksPath", "/tmp/elsewhere"], ["core.sshCommand", "/bin/true"], ["credential.helper", "store"],
    ["diff.external", "/bin/true"], ["merge.x.driver", "/bin/true"], ["alias.st", "status"], ["include.path", "../other"],
    ["remote.origin.proxy", "http://x"], ["remote.origin.promisor", "true"],
  ];
  // A key with a subsection is said as section, `<subsection>`, variable; one without is said whole.
  const said = (key: string) => key.split(".").length > 2 ? `${key.split(".")[0]}.<subsection>.${key.split(".").pop()}` : key;
  for (const [key, value] of keys) {
    fixtureGit(other, "config", key, value);
    const error = await caught(() => snap(other));
    expect(error?.code, key).toBe("repo-unsafe-config");
    expect(error?.path?.toLowerCase(), key).toBe(said(key).toLowerCase());
    fixtureGit(other, "config", "--unset-all", key);
  }
  // A key that starts nothing is no reason to refuse.
  fixtureGit(other, "config", "user.name", "someone");
  expect(await code(other)).toBe("none");
});

test("a change to the source while it is being read is refused, so a snapshot never claims a state that was not there", async () => {
  const modified = () => { const repo = baseRepo(); put(repo, "a.txt", "one changed\n"); return repo; };

  const moved = modified();
  expect(await code(moved, { observe: { afterReads: () => { fixtureGit(moved, "commit", "--allow-empty", "-m", "moved"); } } })).toBe("source-changed");

  const staged = modified();
  put(staged, "late.txt", "late\n");
  expect(await code(staged, { observe: { afterReads: () => { fixtureGit(staged, "add", "late.txt"); } } })).toBe("source-changed");

  const appeared = modified();
  expect(await code(appeared, { observe: { afterReads: () => { put(appeared, "appeared.txt", "new\n"); } } })).toBe("source-changed");

  const rewritten = modified();
  expect(await caught(() => snap(rewritten, { observe: { afterReads: () => { put(rewritten, "a.txt", "one CHANGED\n"); } } })))
    .toMatchObject({ code: "source-changed", path: "a.txt" });

  // A clean file is read and never carried, and rewritten at the same size: what it hashes to is not what was read, whatever its times say.
  const clean = modified();
  expect(await caught(() => snap(clean, { observe: { afterReads: () => { put(clean, "clean.txt", "CLEAN\n"); } } })))
    .toMatchObject({ code: "source-changed", path: "clean.txt" });

  // A file of the same content in another file is not the file that was read either: a swap by rename, at the same size and bytes.
  const swapped = modified();
  expect(await caught(() => snap(swapped, { observe: { afterReads: () => {
    writeFileSync(join(swapped, "clean.swap"), "clean\n");
    chmodSync(join(swapped, "clean.swap"), 0o644);
    renameSync(join(swapped, "clean.swap"), join(swapped, "clean.txt"));
  } } }))).toMatchObject({ code: "source-changed", path: "clean.txt" });

  // Another branch at the same commit: HEAD's id is unchanged and the branch that was recorded no longer is.
  const switched = modified();
  fixtureGit(switched, "branch", "other");
  expect(await code(switched, { observe: { afterReads: () => { fixtureGit(switched, "symbolic-ref", "HEAD", "refs/heads/other"); } } })).toBe("source-changed");

  const still = modified();
  expect(await code(still, { observe: { afterReads: () => {} } })).toBe("none");
});

test("the bounds refuse by name, including what a single git command may print", async () => {
  const repo = baseRepo();
  put(repo, "big.txt", "x".repeat(3000));
  put(repo, "staged.txt", "y".repeat(3000));
  fixtureGit(repo, "add", "staged.txt");
  put(repo, "staged.txt", "z");
  expect(await caught(() => snap(repo, { limits: { ...LIM, maxFileBytes: 1000 } }))).toMatchObject({ code: "limit-file-bytes", path: "big.txt" });
  rmSync(join(repo, "big.txt"));
  // The worktree file is small, the staged blob is not: the index's bytes are bounded too.
  expect(await caught(() => snap(repo, { limits: { ...LIM, maxFileBytes: 1000 } }))).toMatchObject({ code: "limit-file-bytes", path: "staged.txt" });
  put(repo, "p.txt", "p");
  put(repo, "q.txt", "q");
  expect(await code(repo, { limits: { ...LIM, maxFiles: 2 } })).toBe("limit-files");
  expect(await code(repo, { limits: { ...LIM, maxGitOutputBytes: 10 } })).toBe("repo-git-output");
  expect(await code(repo, { limits: { ...LIM, maxGitOutputBytes: -1 } })).toBe("limits-invalid");
  expect(await code(repo, { limits: { ...LIM, maxScanBytes: -1 } })).toBe("limits-invalid");
});

test("the scan bound refuses by name before an oversized clean file or the index is read, and counts every read", async () => {
  const repo = baseRepo();
  put(repo, "big.bin", "x".repeat(12000));
  fixtureGit(repo, "add", "big.bin");
  fixtureGit(repo, "commit", "-m", "a big clean asset");
  // Unreadable: any attempt to hash it would be `unreadable`, so the refusal below can only have come from its size alone.
  chmodSync(join(repo, "big.bin"), 0o000);
  // A clean file is over no carried-bytes bound, and is still not hashed without limit.
  expect(await caught(() => snap(repo, { limits: { ...LIM, maxScanBytes: 20000 } }))).toMatchObject({ code: "limit-scan-bytes", path: "big.bin" });
  // The index file is charged like any other read, and the refusal names it.
  expect(await caught(() => snap(repo, { limits: { ...LIM, maxScanBytes: 100 } }))).toMatchObject({ code: "limit-scan-bytes", path: "index" });
  chmodSync(join(repo, "big.bin"), 0o644);
  // Within the bound the same repository is taken: three reads of the asset and four of the index fit in this.
  expect(await code(repo, { limits: { ...LIM, maxScanBytes: 3 * 12000 + 4 * 4096 + 4096 } })).toBe("none");
  // A carried file is read more often than a clean one, and the bound says so: the asset alone, carried, is five reads.
  put(repo, "big.bin", "y".repeat(12000));
  expect(await caught(() => snap(repo, { limits: { ...LIM, maxFileBytes: 12000, maxTotalBytes: 12000, maxScanBytes: 4 * 12000 } })))
    .toMatchObject({ code: "limit-scan-bytes" });
});

test("untracked credential-shaped paths are withheld by name, directories included, and naming one carries it", async () => {
  const repo = baseRepo();
  put(repo, ".kube/config", "kube");
  put(repo, ".docker/config.json", "{}");
  put(repo, ".config/gh/hosts.yml", "h");
  put(repo, "plain.txt", "p");
  const taken = await snap(repo);
  expect(taken.metadata.withheld.map(one => one.path)).toEqual([".config/gh/hosts.yml", ".docker/config.json", ".kube/config"]);
  expect(taken.bundle.manifest.entries.map(one => one.path)).toEqual(["plain.txt"]);

  const named = await snap(repo, { dependencyFiles: [".kube/config"] });
  expect(named.metadata.withheld.map(one => one.path)).toEqual([".config/gh/hosts.yml", ".docker/config.json"]);
  expect(named.bundle.contents.get(contentKey("workspace", ".kube/config"))?.toString()).toBe("kube");
});

test("a tracked credential-shaped path whose changed bytes would be withheld is refused, not snapshotted as HEAD's, unless it is named", async () => {
  const repo = baseRepo();
  put(repo, ".env.example", "v0\n");
  put(repo, ".aws/config", "c0\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "tracked, credential-shaped names");
  // Unchanged, they are simply HEAD's.
  expect((await snap(repo)).metadata).toMatchObject({ changes: [], withheld: [] });

  // A dirty working file: the destination would be given v0.
  put(repo, ".env.example", "v1\n");
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-withheld", path: ".env.example" });
  // Named, the exact path is the caller's choice and travels.
  const named = await snap(repo, { dependencyFiles: [".env.example"] });
  expect(named.metadata.changes.find(one => one.path === ".env.example")).toMatchObject({ status: " M", carried: "worktree" });
  expect(named.bundle.contents.get(contentKey("workspace", ".env.example"))?.toString()).toBe("v1\n");
  expect(named.metadata.withheld).toEqual([]);
  // Naming one path does not open another.
  expect(await caught(() => snap(repo, { dependencyFiles: [".aws/config"] }))).toMatchObject({ code: "repo-withheld", path: ".env.example" });

  // Staged content that differs from HEAD and from the working file: the index's own bytes are needed, and are withheld just the same.
  fixtureGit(repo, "add", ".env.example");
  put(repo, ".env.example", "v2\n");
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-withheld", path: ".env.example" });
  // Staged, with the working file back at HEAD's bytes: nothing of the working tree differs from HEAD, and only the index holds v1.
  put(repo, ".env.example", "v0\n");
  expect(await caught(() => snap(repo))).toMatchObject({ code: "repo-withheld", path: ".env.example" });
  const staged = await snap(repo, { dependencyFiles: [".env.example"] });
  expect(staged.metadata.changes.find(one => one.path === ".env.example")).toMatchObject({ status: "MM", carried: "none", indexBlob: "carried" });
  expect(staged.bundle.contents.get(contentKey("workspace", `${INDEX_BLOB_PREFIX}${gitBlob("v1\n")}`))?.toString()).toBe("v1\n");

  // A credential-shaped directory above the file is enough, not only the file's own name.
  const nested = baseRepo();
  put(nested, ".aws/config", "c0\n");
  fixtureGit(nested, "add", ".");
  fixtureGit(nested, "commit", "-m", "a file in a credential-shaped directory");
  put(nested, ".aws/config", "c1\n");
  expect(await caught(() => snap(nested))).toMatchObject({ code: "repo-withheld", path: ".aws/config" });

  // A deletion carries no bytes, so it is a tombstone like any other.
  const gone = baseRepo();
  put(gone, ".env.example", "v0\n");
  fixtureGit(gone, "add", ".");
  fixtureGit(gone, "commit", "-m", "tracked");
  rmSync(join(gone, ".env.example"));
  const taken = await snap(gone);
  expect(taken.metadata.changes.find(one => one.path === ".env.example")).toMatchObject({ status: " D", carried: "tombstone" });
  expect(taken.bundle.manifest.entries.map(one => `${one.kind}:${one.path}`)).toEqual(["delete:.env.example"]);
});

test("an intent-to-add entry is refused by name, and a file really staged empty, which git lists the same way, is carried", async () => {
  const ordinary = baseRepo();
  put(ordinary, "empty.txt", "");
  fixtureGit(ordinary, "add", "empty.txt");
  const intent = baseRepo();
  put(intent, "empty.txt", "");
  fixtureGit(intent, "add", "-N", "empty.txt");
  // Nothing in what git lists tells them apart: the same mode, the same empty blob, stage 0.
  expect(fixtureGit(intent, "ls-files", "-s")).toBe(fixtureGit(ordinary, "ls-files", "-s"));
  expect(fixtureGit(ordinary, "ls-files", "-s", "empty.txt")).toContain(gitBlob(""));

  const taken = await snap(ordinary);
  expect(taken.metadata.changes.find(one => one.path === "empty.txt")).toMatchObject({ status: "A ", carried: "worktree", index: { oid: gitBlob("") } });
  expect(taken.bundle.contents.get(contentKey("workspace", "empty.txt"))?.length).toBe(0);

  const indexBefore = sha256Hex(readFileSync(join(intent, ".git/index")));
  expect(await caught(() => snap(intent))).toMatchObject({ code: "repo-index-state", path: "empty.txt" });
  // Read-only: the index is the bytes it was, and the intent is still recorded.
  expect(sha256Hex(readFileSync(join(intent, ".git/index")))).toBe(indexBefore);

  // With content in the working file, the intent is the same refusal, and is found among other staged-empty files.
  const mixed = baseRepo();
  put(mixed, "a-empty.txt", "");
  fixtureGit(mixed, "add", "a-empty.txt");
  put(mixed, "later.txt", "not staged\n");
  fixtureGit(mixed, "add", "-N", "later.txt");
  expect(await caught(() => snap(mixed))).toMatchObject({ code: "repo-index-state", path: "later.txt" });
});

test("a metadata and a bundle from two snapshots of one HEAD are not a pair, and the check says which part is wrong", async () => {
  const repo = baseRepo();
  put(repo, "a.txt", "first\n");
  const one = await snap(repo);
  put(repo, "a.txt", "other\n");
  const two = await snap(repo);
  expect(one.metadata.head).toBe(two.metadata.head);
  expect(one.metadata.bundleDigest).toBe(one.bundle.manifest.digest);
  expect(one.metadata.bundleDigest).not.toBe(two.metadata.bundleDigest);
  expect(one.metadataDigest).not.toBe(two.metadataDigest);

  const pairing = (snapshot: Parameters<typeof verifySnapshot>[0]) => {
    try { verifySnapshot(snapshot, LIM); return "none"; } catch (error) {
      if (error instanceof TransferError) return `${error.code}:${error.path}`;
      throw error;
    }
  };
  expect(pairing(one)).toBe("none");
  expect(pairing(two)).toBe("none");
  // Each half is genuine and the pair is not.
  expect(pairing({ metadata: one.metadata, metadataDigest: one.metadataDigest, bundle: two.bundle })).toBe("snapshot-mismatch:bundle");
  // A metadata whose digest is another's.
  expect(pairing({ metadata: two.metadata, metadataDigest: one.metadataDigest, bundle: two.bundle })).toBe("snapshot-mismatch:metadata");
  // A metadata edited to name the other bundle, its digest made to match, still does not describe that bundle's files.
  const forged = { ...one.metadata, bundleDigest: two.bundle.manifest.digest };
  expect(pairing({ metadata: forged, metadataDigest: metadataDigestOf(forged), bundle: two.bundle })).toBe("snapshot-mismatch:a.txt");
  // A revision the bundle is not a delta against.
  const moved = { ...one.metadata, head: "1".repeat(one.metadata.head.length) };
  expect(pairing({ metadata: moved, metadataDigest: metadataDigestOf(moved), bundle: one.bundle })).toBe("snapshot-mismatch:base");
  // The bytes themselves are checked against the manifest first.
  const broken = { manifest: one.bundle.manifest, contents: new Map(one.bundle.contents).set(contentKey("workspace", "a.txt"), Buffer.from("FIRST\n")) };
  expect(pairing({ metadata: one.metadata, metadataDigest: one.metadataDigest, bundle: broken })).toBe("entry-hash:a.txt");
});

test("a config key is read without ambiguity and is refused without repeating a credential-bearing subsection", async () => {
  const repo = baseRepo();
  // A tab inside a subsection split the key in two for a reader that cut at tabs, and the program key behind it went unseen.
  appendFileSync(join(repo, ".git/config"), '[url "https://user:tok3n@host.invalid/\tx/"]\n\tinsteadOf = https://elsewhere.invalid/\n');
  const error = await caught(() => snap(repo));
  expect(error).toMatchObject({ code: "repo-unsafe-config", path: "url.<subsection>.insteadof" });
  expect(`${error?.message}|${error?.path}|${JSON.stringify(error)}`).not.toContain("tok3n");
  expect(`${error?.path}`).not.toContain("host.invalid");
  // The destination's precondition reads config the same way.
  expect(await caught(() => requireLocalRevision({ repo, revision: fixtureGit(repo, "rev-parse", "HEAD"), maxGitOutputBytes: LIM.maxGitOutputBytes })))
    .toMatchObject({ code: "repo-unsafe-config", path: "url.<subsection>.insteadof" });
});

test("a revision the destination does not hold blocks by name and is never fetched", async () => {
  const upstream = baseRepo();
  const local = join(scratch(), "local");
  fixtureGit(upstream, "clone", "-q", upstream, local);
  const held = fixtureGit(local, "rev-parse", "HEAD");
  await requireLocalRevision({ repo: local, revision: held, maxGitOutputBytes: LIM.maxGitOutputBytes });

  put(upstream, "later.txt", "later\n");
  fixtureGit(upstream, "add", "later.txt");
  fixtureGit(upstream, "commit", "-m", "later");
  const later = fixtureGit(upstream, "rev-parse", "HEAD");
  const need = (revision: string, repo = local) => caught(() => requireLocalRevision({ repo, revision, maxGitOutputBytes: LIM.maxGitOutputBytes }));
  expect(await need(later)).toMatchObject({ code: "repo-revision-missing" });
  expect(await need("1".repeat(held.length))).toMatchObject({ code: "repo-revision-missing" });
  // Still missing afterwards: nothing was fetched, and git never wrote a FETCH_HEAD.
  expect(() => fixtureGit(local, "cat-file", "-e", `${later}^{commit}`)).toThrow();
  expect(existsSync(join(local, ".git/FETCH_HEAD"))).toBe(false);

  for (const bad of ["HEAD", "main", "abc", "--upload-pack=x", `${held};x`, held.toUpperCase()]) {
    expect(await need(bad), bad).toMatchObject({ code: "repo-revision-invalid" });
  }
  fixtureGit(local, "config", "core.fsmonitor", "/bin/true");
  expect(await need(held)).toMatchObject({ code: "repo-unsafe-config" });
});
