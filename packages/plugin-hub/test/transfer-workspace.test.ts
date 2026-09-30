// Capturing one supplied workspace and staging it into a directory this
// operation owns. The source is only read, nothing outside the supplied paths
// is looked at, and a stage never replaces a file that is already there.

import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildBundle, contentKey, pathsOf, sha256Hex, TransferError, type Bundle, type BundleLimits } from "../src/transfer/bundle.ts";
import {
  captureWorkspace, confirmStable, discardStaged, readStable, stageBundle, type CaptureOptions, type StageOptions, type StageReceipt,
} from "../src/transfer/workspace.ts";

const L: BundleLimits = { maxFiles: 50, maxFileBytes: 1024, maxTotalBytes: 8192 };

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "transfer-ws-")));
  made.push(dir);
  return dir;
}

function put(root: string, rel: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  chmodSync(join(root, rel), mode);
}

/** Every entry under `dir` with what a read or a write would move, so a source can be shown untouched. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const child = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, child));
      if (stat.isDirectory()) { out[`${child}/`] = `${stat.mtimeMs}`; walk(child); }
      else out[child] = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${sha256Hex(readFileSync(join(dir, child)))}`;
    }
  };
  walk("");
  return out;
}

/** The regular files of a staged tree, marker left out. */
function staged(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const child = rel === "" ? name : `${rel}/${name}`;
      if (lstatSync(join(dir, child)).isDirectory()) walk(child); else if (child !== ".imprnt-transfer.json") out.push(child);
    }
  };
  walk("");
  return out;
}

function caught(run: () => unknown): TransferError | null {
  try { run(); } catch (error) {
    if (error instanceof TransferError) return error;
    throw error;
  }
  return null;
}
const refusal = (run: () => unknown) => caught(run)?.code ?? "none";

const capture = (root: string, paths: string[], extra: Partial<CaptureOptions> = {}) =>
  captureWorkspace({ root, paths, class: "workspace", limits: L, ...extra });
const stage = (bundle: Bundle, destination: string, extra: Partial<StageOptions> = {}) =>
  stageBundle({ bundle, destination, classes: ["workspace"], limits: L, operation: "op-1", ...extra });

const MARKER = ".imprnt-transfer.json";
const markerOf = (dir: string) => JSON.parse(readFileSync(join(dir, MARKER), "utf8"));
const writeMarker = (dir: string, marker: object) => writeFileSync(join(dir, MARKER), JSON.stringify(marker));

/** Another file with the same bytes and mode at the same path, written beside it first so it cannot share the old file's inode. */
function swapFor(path: string, text: string, mode = 0o644): void {
  const beside = `${path}.swap`;
  writeFileSync(beside, text);
  chmodSync(beside, mode);
  renameSync(beside, path);
}

test("a supplied workspace round-trips into a new directory with its bytes and modes, leaving the source as it found it", () => {
  const root = scratch();
  put(root, "src/a.ts", "alpha\n");
  put(root, "src/bin/run.sh", "#!/bin/sh\n", 0o755);
  put(root, "docs/readme.md", "read me\n", 0o600);
  put(root, "src/node_modules/pkg/index.js", "generated\n");
  put(root, "src/notes.md", "password = hunter2 is something a file name cannot tell\n");
  put(root, "src/.env", "KEY=value\n");
  put(root, "outside.txt", "never asked for\n");
  const before = fingerprint(root);

  const { bundle, skipped } = capture(root, ["src", "docs"], { excludeNames: ["node_modules"] });
  expect(fingerprint(root)).toEqual(before);
  expect(bundle.manifest.entries.map(one => one.path)).toEqual(["docs/readme.md", "src/a.ts", "src/bin/run.sh", "src/notes.md"]);
  // Nothing is left out without a name: the generated tree and the dotenv are both listed as stepped over.
  expect(skipped).toEqual([{ path: "src/.env", reason: "credential-shaped-name" }, { path: "src/node_modules", reason: "excluded-tree" }]);

  const destination = join(scratch(), "staged");
  const result = stage(bundle, destination);
  expect(result).toMatchObject({ destination, manifestDigest: bundle.manifest.digest, files: 4, deleted: 0, reused: false });
  expect(result.receipt).toMatchObject({ destination, manifestDigest: bundle.manifest.digest, operation: "op-1", createdRoot: true, files: 4, dirs: 3 });
  expect(result.receipt.markerBytes).toBeGreaterThanOrEqual(statSync(join(destination, ".imprnt-transfer.json")).size);
  expect(staged(destination)).toEqual(["docs/readme.md", "src/a.ts", "src/bin/run.sh", "src/notes.md"]);
  for (const rel of staged(destination)) {
    expect(readFileSync(join(destination, rel))).toEqual(readFileSync(join(root, rel)));
    expect(statSync(join(destination, rel)).mode & 0o777, rel).toBe(statSync(join(root, rel)).mode & 0o777);
  }
  expect(JSON.parse(readFileSync(join(destination, ".imprnt-transfer.json"), "utf8"))).toMatchObject({ state: "complete", manifest: bundle.manifest.digest });
  expect(fingerprint(root)).toEqual(before);
});

test("a delta carries the change and the deletion, and staging it over its base gives the source's current tree", () => {
  const root = scratch();
  put(root, "app/a.txt", "a");
  put(root, "app/b.txt", "b1");
  put(root, "app/c.txt", "c");
  put(root, "keep/x.txt", "x");
  const base = capture(root, ["app"]).bundle;

  writeFileSync(join(root, "app/b.txt"), "b2");
  rmSync(join(root, "app/c.txt"));
  put(root, "app/d.txt", "d", 0o755);
  const delta = capture(root, ["app"], { base }).bundle;
  expect(delta.manifest.entries.map(one => `${one.kind}:${one.path}`)).toEqual(["file:app/b.txt", "delete:app/c.txt", "file:app/d.txt"]);
  expect(delta.manifest.base).toEqual({ id: base.manifest.digest });

  const destination = join(scratch(), "next");
  expect(stage(delta, destination, { base })).toMatchObject({ files: 3, deleted: 1, reused: false });
  expect(staged(destination)).toEqual(["app/a.txt", "app/b.txt", "app/d.txt"]);
  expect(readFileSync(join(destination, "app/b.txt"), "utf8")).toBe("b2");
  expect(statSync(join(destination, "app/d.txt")).mode & 0o777).toBe(0o755);
  // The same tree a fresh capture of the source would stage.
  const fresh = join(scratch(), "fresh");
  stage(capture(root, ["app"]).bundle, fresh);
  for (const rel of staged(fresh)) expect(readFileSync(join(destination, rel))).toEqual(readFileSync(join(fresh, rel)));
  expect(staged(fresh)).toEqual(staged(destination));

  // A path asked for that is gone is a deletion only if the base had it; otherwise it is a wrong path.
  expect(capture(root, ["app/c.txt"], { base }).bundle.manifest.entries.map(one => `${one.kind}:${one.path}`)).toEqual(["delete:app/c.txt"]);
  expect(refusal(() => capture(root, ["app/c.txt"]))).toBe("path-missing");
  expect(refusal(() => capture(root, ["app/ghost.txt"], { base }))).toBe("path-missing");
});

test("a delta is refused, before any write, without its base, against another base, or for a deletion the base cannot make", () => {
  const root = scratch();
  put(root, "app/a.txt", "a");
  put(root, "app/c.txt", "c");
  const base = capture(root, ["app"]).bundle;
  rmSync(join(root, "app/c.txt"));
  const delta = capture(root, ["app"], { base }).bundle;
  const otherBase = buildBundle([{ path: "app/a.txt", class: "workspace", mode: 0o644, bytes: Buffer.from("not the base") }], L);
  const invented = buildBundle([{ path: "zzz", class: "workspace", deleted: true }], L, { base: { id: base.manifest.digest } });
  const fullAgain = capture(root, ["app"]).bundle;
  for (const [bundle, extra, code] of [
    [delta, {}, "base-required"], [delta, { base: otherBase }, "base-mismatch"],
    [invented, { base }, "tombstone-unknown"], [fullAgain, { base }, "base-mismatch"],
  ] as const) {
    const destination = join(scratch(), "never");
    expect(refusal(() => stage(bundle, destination, extra)), code).toBe(code);
    expect(existsSync(destination), code).toBe(false);
  }
});

test("a file a directory scan stepped over by name is not read as deleted by a delta", () => {
  const root = scratch();
  put(root, "app/a.txt", "a");
  put(root, "app/.env", "S=1");
  // Named outright, so carried.
  const base = capture(root, ["app/a.txt", "app/.env"]).bundle;
  expect(base.manifest.entries.map(one => one.path)).toEqual(["app/.env", "app/a.txt"]);
  const delta = capture(root, ["app"], { base });
  expect(delta.skipped).toEqual([{ path: "app/.env", reason: "credential-shaped-name" }]);
  expect(delta.bundle.manifest).toMatchObject({ files: 0, deletions: 0 });
});

test("a file that changes while it is read, or before the snapshot ends, is source-changed and is never hashed as if it had not", () => {
  const root = scratch();
  const fresh = () => { put(root, "w/a.txt", "0123456789"); put(root, "w/b.txt", "bbbbbbbbbb"); rmSync(join(root, "w/new.txt"), { force: true }); };
  const a = join(root, "w/a.txt"), b = join(root, "w/b.txt");

  fresh();
  expect(refusal(() => capture(root, ["w"], { observe: { afterRead() {}, afterReads() {} } }))).toBe("none");

  fresh();
  const grew = caught(() => capture(root, ["w"], { observe: { afterRead: rel => { if (rel === "w/a.txt") appendFileSync(a, "!"); } } }));
  expect(grew).toMatchObject({ code: "source-changed", path: "w/a.txt" });

  // Same size, same modification time put back: the status change time still moves.
  fresh();
  const rewritten = caught(() => capture(root, ["w"], {
    observe: { afterRead: rel => { if (rel === "w/a.txt") { const was = statSync(a); writeFileSync(a, "9876543210"); utimesSync(a, was.atime, was.mtime); } } },
  }));
  expect(rewritten).toMatchObject({ code: "source-changed", path: "w/a.txt" });

  // A file already read, rewritten before the snapshot is closed.
  fresh();
  expect(caught(() => capture(root, ["w"], { observe: { afterReads: () => writeFileSync(b, "BBBBBBBBBB") } })))
    .toMatchObject({ code: "source-changed", path: "w/b.txt" });

  // A file that appears, or one swapped for a link, after the reads.
  fresh();
  expect(refusal(() => capture(root, ["w"], { observe: { afterReads: () => put(root, "w/new.txt", "late") } }))).toBe("source-changed");
  fresh();
  expect(refusal(() => capture(root, ["w"], { observe: { afterReads: () => { rmSync(a); symlinkSync(b, a); } } }))).toBe("symlink");
});

test("a read confirms its bytes by a second read, a captured file is confirmed again by content, and both are charged to a scan budget first", () => {
  const root = scratch();
  const f = join(root, "f.txt");
  put(root, "f.txt", "0123456789");
  // Rewritten inside the read at the same size with the modification time put back: what the file hashes to is the only thing that moved.
  expect(caught(() => readStable(root, "f.txt", {
    retain: false, afterRead: () => { const was = statSync(f); writeFileSync(f, "9876543210"); utimesSync(f, was.atime, was.mtime); },
  }))).toMatchObject({ code: "source-changed", path: "f.txt" });

  put(root, "f.txt", "0123456789");
  const read = readStable(root, "f.txt", { retain: true });
  expect(read.bytes?.toString()).toBe("0123456789");
  expect(() => confirmStable(root, "f.txt", read)).not.toThrow();
  writeFileSync(f, "9876543210");
  expect(caught(() => confirmStable(root, "f.txt", read))).toMatchObject({ code: "source-changed", path: "f.txt" });

  // Two reads to read, one to confirm: a budget of 25 bytes holds the first and refuses the second without opening the file.
  put(root, "f.txt", "0123456789");
  const budget = { limit: 25, used: 0 };
  const scanned = readStable(root, "f.txt", { retain: false, scan: budget });
  expect(budget.used).toBe(20);
  chmodSync(f, 0o000);
  expect(caught(() => confirmStable(root, "f.txt", scanned, { scan: budget }))).toMatchObject({ code: "limit-scan-bytes", path: "f.txt" });
  chmodSync(f, 0o644);
});

test("links and special files are named and never followed, and a traversal or too broad a root is refused before anything is read", () => {
  const root = scratch(), outside = scratch();
  put(outside, "secret.txt", "TOPSECRET");
  put(root, "real/a.txt", "a");
  symlinkSync(join(outside, "secret.txt"), join(root, "real/link.txt"));
  symlinkSync(outside, join(root, "linkdir"));
  mkdirSync(join(root, "fifo"));
  expect(Bun.spawnSync(["mkfifo", join(root, "fifo/pipe")]).exitCode).toBe(0);

  expect(caught(() => capture(root, ["real"]))).toMatchObject({ code: "symlink", path: "real/link.txt" });
  expect(refusal(() => capture(root, ["real/link.txt"]))).toBe("symlink");
  expect(refusal(() => capture(root, ["linkdir"]))).toBe("symlink");
  const through = caught(() => capture(root, ["linkdir/secret.txt"]));
  expect(through?.code).toBe("symlink");
  expect(`${through?.message}${JSON.stringify(through)}`).not.toContain("TOPSECRET");
  expect(caught(() => capture(root, ["fifo"]))).toMatchObject({ code: "special-file", path: "fifo/pipe" });
  expect(refusal(() => capture(root, ["fifo/pipe"]))).toBe("special-file");

  expect(refusal(() => capture(root, ["../x"]))).toBe("path-traversal");
  expect(refusal(() => capture(root, ["real/../../x"]))).toBe("path-traversal");
  expect(refusal(() => capture(root, ["/etc/passwd"]))).toBe("path-absolute");
  expect(refusal(() => capture(root, ["a//b"]))).toBe("path-invalid");
  expect(refusal(() => capture(root, []))).toBe("path-missing");

  expect(refusal(() => capture("relative/dir", ["x"]))).toBe("root-invalid");
  expect(refusal(() => capture(join(root, "absent"), ["x"]))).toBe("root-invalid");
  expect(refusal(() => capture(join(root, "real/a.txt"), ["x"]))).toBe("root-invalid");
  expect(refusal(() => capture(homedir(), ["x"]))).toBe("root-too-broad");
  // A directory above the home, with a descendant selected, would sweep the home all the same.
  expect(refusal(() => capture(dirname(realpathSync(homedir())), [basename(realpathSync(homedir()))]))).toBe("root-too-broad");
  expect(refusal(() => capture("/", ["x"]))).toBe("root-too-broad");

  // The root itself is resolved once; below it nothing is followed.
  const via = join(scratch(), "rootlink");
  symlinkSync(join(root, "real"), via);
  expect(capture(via, ["a.txt"]).bundle.manifest.entries.map(one => one.path)).toEqual(["a.txt"]);
});

test("only the supplied paths are read, credential-shaped names are not swept from a directory, and a file named outright is carried", () => {
  const root = scratch();
  put(root, "proj/main.ts", "main");
  put(root, "proj/notes.md", "password=hunter2");
  put(root, "proj/.env", "KEY=1");
  put(root, "proj/.git/HEAD", "ref");
  put(root, "proj/.ssh/config", "Host x");
  put(root, "proj/id_rsa", "PRIVATE");
  put(root, "proj/keys/server.pem", "PEM");
  put(root, "home/.aws/credentials", "AWS");
  put(root, "other/.env", "OTHER");

  const swept = capture(root, ["proj"]);
  // The name is the only thing judged: a secret in `notes.md` is carried, and that is the caller's scope to have chosen.
  expect(swept.bundle.manifest.entries.map(one => one.path)).toEqual(["proj/main.ts", "proj/notes.md"]);
  expect(swept.skipped).toEqual([
    { path: "proj/.env", reason: "credential-shaped-name" }, { path: "proj/.git", reason: "excluded-tree" },
    { path: "proj/.ssh", reason: "credential-shaped-name" }, { path: "proj/id_rsa", reason: "credential-shaped-name" },
    { path: "proj/keys/server.pem", reason: "credential-shaped-name" },
  ]);
  // Nothing outside the supplied path was enumerated, so nothing outside it is even named.
  expect(JSON.stringify(swept.skipped)).not.toContain("home");
  expect(JSON.stringify(swept.skipped)).not.toContain("other");

  const named = capture(root, ["proj/main.ts", "proj/.env"]);
  expect(named.bundle.contents.get(contentKey("workspace", "proj/.env"))).toEqual(Buffer.from("KEY=1"));

  // A file both required and excluded is a contradiction, not a quiet choice.
  expect(refusal(() => capture(root, ["proj/keys/server.pem"], { exclude: ["proj/keys"] }))).toBe("path-excluded");
  expect(refusal(() => capture(root, ["proj/node_modules/x"], { excludeNames: ["node_modules"] }))).toBe("path-excluded");
});

test("a selected credential directory, a credential-shaped root and a top-level dotenv are not swept by implication, and a file named outright still is", () => {
  const root = scratch();
  put(root, ".env", "TOP=1");
  put(root, "main.ts", "main");
  put(root, ".ssh/config", "Host x");
  put(root, "proj/.kube/ns/cfg", "kube");
  put(root, ".git/HEAD", "ref");

  // A directory the caller selected is held to the rule its children are, at the boundary it starts from.
  expect(caught(() => capture(root, [".ssh"]))).toMatchObject({ code: "path-excluded", path: ".ssh" });
  expect(caught(() => capture(root, ["proj/.kube/ns"]))).toMatchObject({ code: "path-excluded", path: "proj/.kube/ns" });
  // A file named outright is the deliberate choice, in a credential-shaped directory or not.
  expect(capture(root, [".ssh/config"]).bundle.contents.get(contentKey("workspace", ".ssh/config"))).toEqual(Buffer.from("Host x"));
  expect(capture(root, ["proj/.kube/ns/cfg"]).bundle.manifest.entries.map(one => one.path)).toEqual(["proj/.kube/ns/cfg"]);

  // The root walked whole has the same filters, and says what they stepped over.
  const walked = capture(root, ["."]);
  expect(walked.bundle.manifest.entries.map(one => one.path)).toEqual(["main.ts"]);
  expect(walked.skipped).toEqual([
    { path: ".env", reason: "credential-shaped-name" }, { path: ".git", reason: "excluded-tree" },
    { path: ".ssh", reason: "credential-shaped-name" }, { path: "proj/.kube", reason: "credential-shaped-name" },
  ]);
  // `.` is a capture's own spelling: it stands alone, and no manifest may carry it.
  expect(refusal(() => capture(root, [".", "main.ts"]))).toBe("path-duplicate");
  expect(refusal(() => buildBundle([{ path: ".", class: "workspace", mode: 0o644, bytes: Buffer.from("x") }], L))).toBe("path-invalid");

  // A root that is itself credential-shaped is not walked, though a file in it can still be named.
  const cred = join(scratch(), ".ssh");
  put(cred, "config", "Host x");
  put(cred, "sub/known_hosts", "h");
  expect(caught(() => capture(cred, ["."]))).toMatchObject({ code: "path-excluded", path: "." });
  expect(refusal(() => capture(cred, ["sub"]))).toBe("path-excluded");
  expect(capture(cred, ["config"]).bundle.manifest.entries.map(one => one.path)).toEqual(["config"]);
});

test("a root walk against a base tombstones what left it, and never what the walk stepped over", () => {
  const root = scratch();
  put(root, "a.txt", "a");
  put(root, "d/b.txt", "b");
  put(root, "d/c.txt", "c");
  put(root, ".env", "S=1");
  // The dotenv is named outright, so the base carries it; a root walk steps over it and does not read it as deleted.
  const base = capture(root, ["a.txt", "d/b.txt", "d/c.txt", ".env"]).bundle;
  rmSync(join(root, "d/c.txt"));
  writeFileSync(join(root, "a.txt"), "a2");
  const delta = capture(root, ["."], { base });
  expect(delta.bundle.manifest.entries.map(one => `${one.kind}:${one.path}`)).toEqual(["file:a.txt", "delete:d/c.txt"]);
  expect(delta.skipped).toEqual([{ path: ".env", reason: "credential-shaped-name" }]);
});

test("the bounds refuse by name, from sizes, and say which bound it was", () => {
  const root = scratch();
  put(root, "b/one", "x".repeat(600));
  put(root, "b/three", "small");
  put(root, "b/two", "y".repeat(600));
  expect(caught(() => capture(root, ["b"], { limits: { ...L, maxFileBytes: 500 } }))).toMatchObject({ code: "limit-file-bytes", path: "b/one" });
  expect(caught(() => capture(root, ["b"], { limits: { ...L, maxTotalBytes: 1000 } }))).toMatchObject({ code: "limit-total-bytes", path: "b/two" });
  expect(refusal(() => capture(root, ["b"], { limits: { ...L, maxFiles: 2 } }))).toBe("limit-files");
  expect(refusal(() => capture(root, ["b"], { limits: { ...L, maxFiles: -1 } }))).toBe("limits-invalid");
});

test("a bundle that is wrong is refused by name before the destination exists", () => {
  const root = scratch();
  put(root, "src/a.txt", "alpha\n");
  put(root, "src/b.txt", "beta\n");
  const { bundle } = capture(root, ["src"]);
  const key = contentKey("workspace", "src/a.txt");
  const session = buildBundle([
    { path: "a.txt", class: "session", mode: 0o644, bytes: Buffer.from("s") }, { path: "A.txt", class: "workspace", mode: 0o644, bytes: Buffer.from("w") },
  ], L);
  const cases: [string, () => unknown][] = [
    ["entry-hash", () => stage({ manifest: bundle.manifest, contents: new Map(bundle.contents).set(key, Buffer.from("ALPHA\n")) }, join(scratch(), "d"))],
    ["entry-missing", () => { const held = new Map(bundle.contents); held.delete(key); return stage({ manifest: bundle.manifest, contents: held }, join(scratch(), "d")); }],
    ["manifest-digest", () => stage({ manifest: { ...bundle.manifest, digest: "0".repeat(64) }, contents: bundle.contents }, join(scratch(), "d"))],
    ["class-unhandled", () => stage(session, join(scratch(), "d"))],
    ["path-duplicate", () => stage(session, join(scratch(), "d"), { classes: ["session", "workspace"] })],
    ["destination-invalid", () => stage(bundle, "relative/out")],
    ["destination-invalid", () => stage(bundle, join(scratch(), "no-parent", "out"))],
  ];
  for (const [code, run] of cases) {
    const held = made.length;
    expect(refusal(run), code).toBe(code);
    // The refused destination's parent holds nothing: no directory, no marker, no partial file.
    for (const dir of made.slice(held)) expect(readdirSync(dir), code).toEqual([]);
  }
});

test("a stage never replaces anything already in the destination, and refuses it as it stands", () => {
  const root = scratch();
  put(root, "src/a.ts", "from the source\n");
  const { bundle } = capture(root, ["src"]);

  const project = scratch();
  put(project, "src/a.ts", "MY EDITS\n");
  put(project, "other.txt", "mine");
  const before = fingerprint(project);
  expect(refusal(() => stage(bundle, project))).toBe("destination-exists");
  expect(fingerprint(project)).toEqual(before);

  const file = join(scratch(), "a-file");
  writeFileSync(file, "x");
  expect(refusal(() => stage(bundle, file))).toBe("destination-exists");
  expect(readFileSync(file, "utf8")).toBe("x");

  const target = scratch();
  const link = join(scratch(), "link");
  symlinkSync(target, link);
  expect(refusal(() => stage(bundle, link))).toBe("destination-exists");
  expect(readdirSync(target)).toEqual([]);

  // An existing empty directory is used as handed over, and is still the caller's afterwards.
  const empty = scratch();
  const handed = stage(bundle, empty);
  expect(handed).toMatchObject({ files: 1, reused: false });
  expect(handed.receipt.createdRoot).toBe(false);
  expect(staged(empty)).toEqual(["src/a.ts"]);
  discardStaged({ receipt: handed.receipt });
  expect(existsSync(empty)).toBe(true);
  expect(readdirSync(empty)).toEqual([]);

  // A token that is not shaped like one is refused before anything exists.
  const never = join(scratch(), "never");
  expect(refusal(() => stage(bundle, never, { operation: "not a token!" }))).toBe("operation-invalid");
  expect(existsSync(never)).toBe(false);
});

test("staging twice is one stage, a tree that no longer matches is refused, and another bundle's directory is left alone", () => {
  const root = scratch();
  put(root, "src/a.txt", "alpha");
  put(root, "src/b.txt", "beta");
  const { bundle } = capture(root, ["src"]);
  const destination = join(scratch(), "out");
  const first = stage(bundle, destination);
  expect(first.reused).toBe(false);
  const again = stage(bundle, destination);
  expect(again.reused).toBe(true);
  // The same stage, so the same receipt: the generation is the stage's, not the call's.
  expect(again.receipt).toEqual(first.receipt);

  const other = buildBundle([{ path: "src/a.txt", class: "workspace", mode: 0o644, bytes: Buffer.from("different") }], L);
  const before = fingerprint(destination);
  expect(refusal(() => stage(other, destination))).toBe("destination-foreign");
  // Another operation's name on the same bundle is not the owner of this stage either.
  expect(refusal(() => stage(bundle, destination, { operation: "op-2" }))).toBe("destination-foreign");
  expect(fingerprint(destination)).toEqual(before);

  // The same bytes in a different file, at the same path, are not the file this stage made.
  const clone = join(scratch(), "clone");
  stage(bundle, clone);
  swapFor(join(clone, "src/b.txt"), "beta");
  expect(caught(() => stage(bundle, clone))).toMatchObject({ code: "stage-ambiguous", path: "src/b.txt" });

  writeFileSync(join(destination, "src/a.txt"), "tampered");
  expect(refusal(() => stage(bundle, destination))).toBe("stage-verify");
});

test("a delta staged over a larger base is reused and retried on the resolved plan, not on the delta's own size", () => {
  const big: BundleLimits = { maxFiles: 50, maxFileBytes: 1024, maxTotalBytes: 8192 };
  const small: BundleLimits = { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 8192 };
  const base = buildBundle([1, 2, 3, 4, 5, 6].map(n => ({ path: `d/f${n}.txt`, class: "workspace" as const, mode: 0o644, bytes: Buffer.from(`v${n}`) })), big);
  const delta = buildBundle([{ path: "d/f3.txt", class: "workspace", mode: 0o644, bytes: Buffer.from("v3 changed") }], small,
    { base: { id: base.manifest.digest }, basePaths: pathsOf(base.manifest) });
  const at = (destination: string) => stage(delta, destination, { base, limits: small, baseLimits: big });

  const destination = join(scratch(), "out");
  const made = at(destination);
  expect(made).toMatchObject({ files: 6, reused: false });
  expect(made.receipt).toMatchObject({ files: 6, dirs: 1 });
  expect(readFileSync(join(destination, "d/f3.txt"), "utf8")).toBe("v3 changed");
  // Six files in the plan against a delta that may hold two: the marker is still this stage's and is read back whole.
  expect(at(destination)).toMatchObject({ files: 6, reused: true });
  discardStaged({ receipt: made.receipt });
  expect(existsSync(destination)).toBe(false);

  // A crash that left only the marker continues over the same large plan.
  const donor = at(join(scratch(), "donor"));
  const crashed = join(scratch(), "crashed");
  mkdirSync(crashed);
  const dir = lstatSync(crashed);
  writeMarker(crashed, { ...markerOf(donor.destination), state: "staging", createdRoot: false, root: { dev: dir.dev, ino: dir.ino }, owned: { files: [], dirs: [] } });
  expect(at(crashed)).toMatchObject({ files: 6, reused: false });
  expect(readdirSync(join(crashed, "d")).sort()).toEqual(["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt"]);
});

const oneFile = (path: string) => ({ path, class: "workspace" as const, mode: 0o644, bytes: Buffer.from("x") });

/**
 * `count` file paths, each four long directory names and a file name. Every name
 * carries a quote, which JSON escapes, and a two-byte letter, so the path as the
 * marker serialises it is longer than the path's own bytes. Each path is about
 * 830 bytes: valid (the limit is 1024) and still short enough to join to a
 * destination under the system's own path limit.
 */
function longPaths(count: number): string[] {
  const name = (id: string, repeats: number) => `${id}-${"q\"é".repeat(repeats)}`;
  return Array.from({ length: count }, (_, n) => {
    const dirs = [0, 1, 2, 3].map(d => name(`f${n}d${d}`, 45));
    return [...dirs, name(`f${n}-file`, 20)].join("/");
  });
}

test("a plan with more directories than files is staged, reused and discarded by its own receipt", () => {
  for (const path of ["a/b/c.txt", "a/b/c/d/e.txt"]) {
    const bundle = buildBundle([oneFile(path)], L);
    const destination = join(scratch(), "deep");
    const dirs = path.split("/").length - 1;
    const made = stage(bundle, destination);
    expect(made).toMatchObject({ files: 1, reused: false });
    expect(made.receipt).toMatchObject({ files: 1, dirs });
    expect(markerOf(destination).owned.dirs).toHaveLength(dirs);
    expect(statSync(join(destination, MARKER)).size).toBeLessThanOrEqual(made.receipt.markerBytes);

    const again = stage(bundle, destination);
    expect(again).toMatchObject({ files: 1, reused: true });
    expect(again.receipt).toEqual(made.receipt);
    discardStaged({ receipt: made.receipt });
    expect(existsSync(destination)).toBe(false);
  }
});

test("a plan of long, escaped and multibyte paths is read back under bounds worked out from those paths", () => {
  const paths = longPaths(10);
  for (const path of paths) {
    expect(Buffer.byteLength(path)).toBeGreaterThan(800);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(1024);
  }
  const bundle = buildBundle(paths.map(oneFile), L);
  const destination = join(scratch(), "long");
  const made = stage(bundle, destination);
  expect(made).toMatchObject({ files: 10, reused: false });
  expect(made.receipt).toMatchObject({ files: 10, dirs: 40 });

  // The marker is well past what a per-file allowance would have held, and inside the bound its own paths work out to.
  const size = statSync(join(destination, MARKER)).size;
  expect(size).toBeGreaterThan(10 * 2400 + 4096);
  expect(size).toBeLessThanOrEqual(made.receipt.markerBytes);

  expect(stage(bundle, destination)).toMatchObject({ files: 10, reused: true });
  discardStaged({ receipt: made.receipt });
  expect(existsSync(destination)).toBe(false);
});

test("a receipt's bounds must be whole and must be the plan's, and a marker past them is foreign to stage and discard alike", () => {
  const bundle = buildBundle(longPaths(3).map(oneFile), L);
  const destination = join(scratch(), "bounded");
  const { receipt } = stage(bundle, destination);
  expect(receipt).toMatchObject({ files: 3, dirs: 12 });
  const before = fingerprint(destination);
  const refused = (forged: object, code: string) => {
    expect(refusal(() => discardStaged({ receipt: forged as StageReceipt })), JSON.stringify(forged)).toBe(code);
    expect(fingerprint(destination)).toEqual(before);
  };

  // Not a count, not whole, or more than any plan of that many files could need: refused before the directory is looked at.
  for (const forged of [
    { ...receipt, dirs: -1 }, { ...receipt, dirs: 1.5 }, { ...receipt, dirs: "12" }, { ...receipt, dirs: Number.NaN }, { ...receipt, dirs: undefined },
    { ...receipt, dirs: receipt.files * 511 + 1 }, { ...receipt, files: 0 },
    { ...receipt, markerBytes: 0 }, { ...receipt, markerBytes: 1.5 }, { ...receipt, markerBytes: Number.MAX_SAFE_INTEGER },
    { ...receipt, markerBytes: Number.POSITIVE_INFINITY }, { ...receipt, markerBytes: undefined },
  ]) refused(forged, "destination-invalid");

  // Plausible but smaller than what this stage recorded: the marker does not fit them.
  refused({ ...receipt, markerBytes: 4096 }, "destination-foreign");
  refused({ ...receipt, dirs: receipt.dirs - 1 }, "destination-foreign");
  refused({ ...receipt, files: receipt.files - 1 }, "destination-foreign");
  // Plausible and large enough, but not the bounds this marker's own plan works out to.
  refused({ ...receipt, markerBytes: receipt.markerBytes - 1 }, "stage-stale");
  refused({ ...receipt, dirs: receipt.dirs + 1 }, "stage-stale");

  // A marker past the bounds: padded past its size, or recording a directory or a file the plan has not got.
  const marker = markerOf(destination);
  const extraDir = { path: "zzz", dev: 1, ino: 1 };
  const extraFile = { path: "zzz.txt", dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 };
  for (const [tampered, text] of [
    [marker, JSON.stringify(marker) + " ".repeat(receipt.markerBytes)],
    [{ ...marker, owned: { ...marker.owned, dirs: [...marker.owned.dirs, extraDir] } }, null],
    [{ ...marker, owned: { ...marker.owned, files: [...marker.owned.files, extraFile] } }, null],
  ] as [object, string | null][]) {
    writeFileSync(join(destination, MARKER), text ?? JSON.stringify(tampered));
    expect(refusal(() => stage(bundle, destination))).toBe("destination-foreign");
    expect(refusal(() => discardStaged({ receipt }))).toBe("destination-foreign");
    expect(staged(destination)).toHaveLength(3);
  }

  // The marker as it was written is still the stage's own, and discards.
  writeFileSync(join(destination, MARKER), JSON.stringify(marker));
  discardStaged({ receipt });
  expect(existsSync(destination)).toBe(false);
});

test("an interrupted stage holding only its marker is continued, or discarded, under the same bounds for a deep plan", () => {
  const bundle = buildBundle(longPaths(3).map(oneFile), L);
  const donor = stage(bundle, join(scratch(), "donor"));
  /** What a crash leaves in a directory handed to this operation: an unfinished marker of this stage, bound to the directory. */
  const crashed = (name: string) => {
    const dir = join(scratch(), name);
    mkdirSync(dir);
    const at = lstatSync(dir);
    writeMarker(dir, { ...markerOf(donor.destination), state: "staging", createdRoot: false, root: { dev: at.dev, ino: at.ino }, owned: { files: [], dirs: [] } });
    return { dir, at };
  };

  const retry = crashed("retry");
  expect(stage(bundle, retry.dir)).toMatchObject({ files: 3, reused: false, receipt: { dirs: 12, markerBytes: donor.receipt.markerBytes } });
  expect(staged(retry.dir)).toHaveLength(3);

  const abandoned = crashed("abandoned");
  const receipt: StageReceipt = { ...donor.receipt, destination: abandoned.dir, generation: markerOf(abandoned.dir).generation, createdRoot: false,
    root: { dev: abandoned.at.dev, ino: abandoned.at.ino } };
  discardStaged({ receipt });
  // Only the marker was the stage's: it is gone, and the directory that was handed over is still there.
  expect(readdirSync(abandoned.dir)).toEqual([]);
});

test("a failed stage removes what it made and nothing else, and names what it leaves instead of calling itself clean", () => {
  const root = scratch();
  put(root, "src/a.txt", "alpha");
  put(root, "src/b.txt", "beta");
  put(root, "top.txt", "top");
  const { bundle } = capture(root, ["src", "top.txt"]);

  // Somebody else's file at a name this stage means to create: the exclusive create fails, the stage's own files go, the foreign one stays.
  const collided = join(scratch(), "collided");
  const hit = caught(() => stage(bundle, collided, { observe: { beforeCreate: rel => { if (rel === "src/b.txt") writeFileSync(join(collided, rel), "FOREIGN"); } } }));
  expect(hit).toMatchObject({ code: "stage-ambiguous", path: "src" });
  expect(readFileSync(join(collided, "src/b.txt"), "utf8")).toBe("FOREIGN");
  expect(existsSync(join(collided, "src/a.txt"))).toBe(false);
  // The directory is still marked, so what is left is still named by something, and a retry does not touch it.
  expect(existsSync(join(collided, ".imprnt-transfer.json"))).toBe(true);
  expect(refusal(() => stage(bundle, collided))).toBe("stage-ambiguous");
  expect(readFileSync(join(collided, "src/b.txt"), "utf8")).toBe("FOREIGN");

  // A file this stage made, replaced by another file with the same bytes at the same planned name: not its file any more, so it stays.
  const replaced = join(scratch(), "replaced");
  const swapped = caught(() => stage(bundle, replaced, { observe: { afterCreate: rel => {
    if (rel === "src/a.txt") swapFor(join(replaced, rel), "alpha");
    if (rel === "src/b.txt") throw new Error("injected");
  } } }));
  expect(swapped).toMatchObject({ code: "stage-ambiguous", path: "src/a.txt" });
  expect(readFileSync(join(replaced, "src/a.txt"), "utf8")).toBe("alpha");
  expect(existsSync(join(replaced, "src/b.txt"))).toBe(false);

  // A failure with nothing foreign anywhere is cleaned up whole, and is still the error that started it: a new directory goes, a handed-over one is left empty.
  const plain = join(scratch(), "plain");
  const failAtTop = { observe: { afterCreate: (rel: string) => { if (rel === "top.txt") throw new Error("injected"); } } };
  expect(refusal(() => stage(bundle, plain, failAtTop))).toBe("stage-io");
  expect(existsSync(plain)).toBe(false);
  const handed = scratch();
  expect(refusal(() => stage(bundle, handed, failAtTop))).toBe("stage-io");
  expect(readdirSync(handed)).toEqual([]);
  expect(stage(bundle, plain)).toMatchObject({ files: 3, reused: false });
});

test("an interrupted stage continues only from its marker alone, and anything else is named and left exactly as it is", () => {
  const root = scratch();
  put(root, "src/a.txt", "alpha");
  put(root, "src/b.txt", "beta");
  const { bundle } = capture(root, ["src"]);
  const donor = stage(bundle, join(scratch(), "donor"));
  /** What a crash leaves in a directory this operation made: an unfinished marker of this stage, bound to this directory. */
  const crashed = (dir: string, marker: object = {}) => {
    mkdirSync(dir);
    const at = lstatSync(dir);
    writeMarker(dir, { ...markerOf(donor.destination), state: "staging", createdRoot: true, root: { dev: at.dev, ino: at.ino }, owned: { files: [], dirs: [] }, ...marker });
  };

  // The marker alone: nothing else could be anyone's, so the stage goes on from it, under a generation of its own.
  const retry = join(scratch(), "retry");
  crashed(retry);
  const continued = stage(bundle, retry);
  expect(continued).toMatchObject({ files: 2, reused: false });
  expect(continued.receipt.generation).not.toBe(markerOf(donor.destination).generation);
  expect(staged(retry)).toEqual(["src/a.txt", "src/b.txt"]);
  expect(markerOf(retry).state).toBe("complete");
  discardStaged({ receipt: continued.receipt });
  expect(existsSync(retry)).toBe(false);

  // Files left by an unfinished stage cannot be shown to be this operation's, so the retry stops and deletes nothing.
  const partial = join(scratch(), "partial");
  crashed(partial);
  put(partial, "src/a.txt", "alpha");
  const marker = readFileSync(join(partial, MARKER), "utf8");
  expect(caught(() => stage(bundle, partial))).toMatchObject({ code: "stage-ambiguous", path: "src" });
  expect(staged(partial)).toEqual(["src/a.txt"]);
  expect(readFileSync(join(partial, MARKER), "utf8")).toBe(marker);

  // A lone temp file has the marker's temp name and proves nothing: named, and left.
  const temp = join(scratch(), "temp");
  mkdirSync(temp);
  writeFileSync(join(temp, `${MARKER}.tmp`), "x");
  expect(caught(() => stage(bundle, temp))).toMatchObject({ code: "stage-ambiguous", path: `${MARKER}.tmp` });
  expect(readFileSync(join(temp, `${MARKER}.tmp`), "utf8")).toBe("x");

  // A marker that says more than the plan, or lists a path outside the directory, or was made for another directory, removes nothing and is not continued.
  const parent = scratch();
  put(parent, "victim.txt", "keep me");
  const extra = join(parent, "extra");
  stage(bundle, extra);
  put(extra, "src/victim.txt", "mine");
  writeMarker(extra, { ...markerOf(extra), files: [...markerOf(extra).files, "src/victim.txt"] });
  expect(refusal(() => stage(bundle, extra))).toBe("destination-foreign");
  expect(readFileSync(join(extra, "src/victim.txt"), "utf8")).toBe("mine");
  const outside = join(parent, "outside");
  crashed(outside, { files: ["../victim.txt", "src/a.txt", "src/b.txt"] });
  expect(refusal(() => stage(bundle, outside))).toBe("destination-foreign");
  const twin = join(parent, "twin");
  mkdirSync(twin);
  writeMarker(twin, markerOf(donor.destination));
  expect(refusal(() => stage(bundle, twin))).toBe("destination-foreign");
  expect(readFileSync(join(parent, "victim.txt"), "utf8")).toBe("keep me");
  expect(staged(donor.destination)).toEqual(["src/a.txt", "src/b.txt"]);
});

test("discarding removes what the receipt's stage recorded, by identity, and names everything it leaves", () => {
  const root = scratch();
  put(root, "src/a.txt", "alpha");
  put(root, "src/b.txt", "beta");
  const { bundle } = capture(root, ["src"]);

  const whole = join(scratch(), "whole");
  const receipt: StageReceipt = stage(bundle, whole).receipt;
  discardStaged({ receipt });
  expect(existsSync(whole)).toBe(false);
  // Discarded already: the receipt no longer describes anything.
  expect(refusal(() => discardStaged({ receipt }))).toBe("stage-stale");

  // Somebody else's file in a directory of the stage: the stage's own files go, the directory and the file stay, and it is not called discarded.
  const shared = join(scratch(), "shared");
  const sharedReceipt = stage(bundle, shared).receipt;
  put(shared, "src/mine.txt", "not ours");
  expect(caught(() => discardStaged({ receipt: sharedReceipt }))).toMatchObject({ code: "stage-ambiguous", path: "src" });
  expect(staged(shared)).toEqual(["src/mine.txt"]);

  // A file replaced by another with the same bytes is not the stage's: nothing is removed at all.
  const swapped = join(scratch(), "swapped");
  const swappedReceipt = stage(bundle, swapped).receipt;
  swapFor(join(swapped, "src/b.txt"), "beta");
  expect(caught(() => discardStaged({ receipt: swappedReceipt }))).toMatchObject({ code: "stage-ambiguous", path: "src/b.txt" });
  expect(staged(swapped)).toEqual(["src/a.txt", "src/b.txt"]);

  // A receipt that is not this stage's: another bundle, another generation, a directory promoted (marker gone) or replaced, a project it never staged.
  const live = join(scratch(), "live");
  const held = stage(bundle, live).receipt;
  const fingerprintLive = fingerprint(live);
  for (const [forged, code] of [
    [{ ...held, manifestDigest: "1".repeat(64) }, "destination-foreign"],
    [{ ...held, planDigest: "1".repeat(64) }, "destination-foreign"],
    [{ ...held, generation: "0".repeat(32) }, "stage-stale"],
    [{ ...held, operation: "op-2" }, "stage-stale"],
    [{ ...held, root: { dev: held.root.dev, ino: held.root.ino + 1 } }, "stage-stale"],
    [{ ...held, destination: "relative/live" }, "destination-invalid"],
  ] as [StageReceipt, string][]) {
    expect(refusal(() => discardStaged({ receipt: forged })), code).toBe(code);
    expect(fingerprint(live)).toEqual(fingerprintLive);
  }
  // A marker of a later generation (the stage was replaced) is not the one this receipt names.
  const marker = markerOf(live);
  writeMarker(live, { ...marker, generation: "f".repeat(32) });
  expect(refusal(() => discardStaged({ receipt: held }))).toBe("stage-stale");
  writeMarker(live, marker);
  rmSync(join(live, MARKER));
  expect(refusal(() => discardStaged({ receipt: held }))).toBe("stage-stale");
  expect(staged(live)).toEqual(["src/a.txt", "src/b.txt"]);

  const project = scratch();
  put(project, "src/a.txt", "a project");
  expect(refusal(() => discardStaged({ receipt: { ...held, destination: project } }))).toBe("stage-stale");
  expect(readFileSync(join(project, "src/a.txt"), "utf8")).toBe("a project");
});

test("a link is never followed into its target to discard it, as the destination or anywhere on the way", () => {
  const root = scratch();
  put(root, "src/a.txt", "alpha");
  const { bundle } = capture(root, ["src"]);
  const real = join(scratch(), "real");
  const { receipt } = stage(bundle, real);

  const links = scratch();
  const link = join(links, "link");
  symlinkSync(real, link);
  expect(refusal(() => discardStaged({ receipt: { ...receipt, destination: link } }))).toBe("destination-invalid");
  const alias = join(links, "alias");
  symlinkSync(dirname(real), alias);
  expect(refusal(() => discardStaged({ receipt: { ...receipt, destination: join(alias, "real") } }))).toBe("destination-invalid");
  expect(staged(real)).toEqual(["src/a.txt"]);

  // A stage into a link is refused for the same reason, and nothing is written through it.
  const target = scratch();
  symlinkSync(target, join(links, "through"));
  expect(refusal(() => stage(bundle, join(links, "through")))).toBe("destination-exists");
  expect(readdirSync(target)).toEqual([]);

  // The real path still discards by its own receipt.
  discardStaged({ receipt });
  expect(existsSync(real)).toBe(false);
});
