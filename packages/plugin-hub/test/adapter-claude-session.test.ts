// Moving a Claude Code session's transcript between two session directories:
// what the export reads and refuses, what the import stages and refuses, and
// what is checked after a resumed turn. Temporary trees only: no CLI, no model,
// no network, and no session of anyone's is read.
//
// The measured tables are asserted as they are. Tests that run on `tmpdir()`
// paths (macOS puts `_` in them) use a test-only copy of the entries with extra
// `substitute` keys, which exercises the machinery and measures nothing.

import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeCode } from "../src/adapters/claude-code.ts";
import {
  canonicalNativeManifest, claudeSession, encodeProjectDir, makeClaudeSessionPort, nativeManifestDigest, VALIDATED_SESSION_BUILDS, VALIDATED_SESSION_PAIRS,
  type SessionObserve, type SessionRule, type SessionTables,
} from "../src/adapters/claude-session.ts";
import { NativeRefusal, type NativeExport, type NativeManifest, type NativeSessionPort } from "../src/adapters/types.ts";
import { buildBundle, sha256Hex, TransferError, type Bundle, type BundleLimits } from "../src/transfer/bundle.ts";
import { stageBundle } from "../src/transfer/workspace.ts";
import { MOVE_NATIVE_LIMITS, RESUME_CHECK_LIMITS } from "../src/runner/move-handoff.ts";

const L: BundleLimits = { maxFiles: 50, maxFileBytes: 4096, maxTotalBytes: 16384 };
const SESSION = "1e261f87-06a7-4242-b039-ec2a6c7173aa";
const OTHER = "463dd5d9-760b-438a-8b4f-5645c12ce82c";
const MAC = "2.1.286";
const PI = "2.1.285";
const TRANSCRIPT = Buffer.from('{"type":"user","n":1}\n{"type":"assistant","n":2}\n');
const MARKER = ".imprnt-transfer.json";

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ns-")));
  made.push(dir);
  return dir;
}

// The measured entries, copied with the characters a temporary directory can hold. The copies are the only ones a test mutates.
const widen = (entry: SessionRule): SessionRule => ({ ...entry, substitute: { ...entry.substitute, "_": "-", ".": "-" } });
const TEST: SessionTables = {
  builds: { "darwin:2.1.286": widen(VALIDATED_SESSION_BUILDS["darwin:2.1.286"]), "linux:2.1.285": widen(VALIDATED_SESSION_BUILDS["linux:2.1.285"]) },
  pairs: VALIDATED_SESSION_PAIRS,
};
const portOf = (os: "darwin" | "linux", observe?: SessionObserve): NativeSessionPort => makeClaudeSessionPort(TEST, { os }, observe);
const entryOf = (os: "darwin" | "linux") => TEST.builds[os === "darwin" ? "darwin:2.1.286" : "linux:2.1.285"];

function put(root: string, rel: string, bytes: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), bytes);
  chmodSync(join(root, rel), mode);
}

/**
 * A session directory as the engine leaves one: `config/projects/<dir>/<session>.jsonl`, `<dir>` being what the build's
 * rule gives for the directory's realpath (or `projectDir`, to put it somewhere else, or when the path is outside the subset).
 */
function seed(sessionDir: string, os: "darwin" | "linux", options: { session?: string; text?: Uint8Array; projectDir?: string } = {}) {
  mkdirSync(sessionDir, { recursive: true });
  const cwd = realpathSync(sessionDir);
  const projectDir = options.projectDir ?? encodeProjectDir(cwd, entryOf(os)) ?? "-observed";
  const rel = `config/projects/${projectDir}/${options.session ?? SESSION}.jsonl`;
  put(sessionDir, rel, options.text ?? TRANSCRIPT);
  return { sessionDir, cwd, projectDir, rel };
}

/** Every entry under `dir`, with what a read or a write would move, so a tree can be shown untouched. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const child = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, child));
      if (stat.isDirectory()) { out[`${child}/`] = `${stat.mode}`; walk(child); }
      else if (stat.isSymbolicLink()) out[child] = "link";
      else out[child] = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${sha256Hex(readFileSync(join(dir, child)))}`;
    }
  };
  walk("");
  return out;
}

/** What is at `path` as a plain value, whatever it is: a tree, a link's target or a file's text. */
function snapshot(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? fingerprint(path) : readFileSync(path, "utf8");
}

function refused(run: () => unknown): NativeRefusal | TransferError | null {
  try { run(); } catch (error) {
    if (error instanceof NativeRefusal || error instanceof TransferError) return error;
    throw error;
  }
  return null;
}
const codeOf = (run: () => unknown) => refused(run)?.code ?? "none";
const pathOf = (run: () => unknown) => refused(run)?.path;

/** A source seeded and exported on the mac side, ready for the pi side to import into `dst`. */
function exported(root: string, from: "darwin" | "linux" = "darwin", options: Parameters<typeof seed>[2] = {}) {
  const src = seed(join(root, "src"), from, options);
  const out = portOf(from).exportSession({ sessionDir: src.sessionDir, nativeSession: options.session ?? SESSION, version: from === "darwin" ? MAC : PI, limits: L });
  return { src, out };
}

function importInto(port: NativeSessionPort, out: NativeExport, sessionDir: string, version: string, operation = "op-1") {
  return port.importSession({ manifest: out.manifest, digest: out.digest, bundle: out.bundle, sessionDir, version, operation, limits: L });
}

const ceilingOf = (entry: SessionRule) => Math.max(...entry.vectors.map(one => one.project_dir.length));

// ---------------------------------------------------------------------------
// the measured facts

test("the measured tables reproduce all four vectors exactly, by the one rule, and say nothing beyond them", () => {
  const vectors = Object.values(VALIDATED_SESSION_BUILDS).flatMap(entry => entry.vectors.map(one => ({ entry, one })));
  expect(vectors.length).toBe(4);
  for (const { entry, one } of vectors) {
    expect(encodeProjectDir(one.cwd, entry), one.evidence).toBe(one.project_dir);
    expect(one.project_dir, "each `/` is a `-` and nothing else changed").toBe(one.cwd.replaceAll("/", "-"));
  }
  expect(Object.keys(VALIDATED_SESSION_BUILDS).sort()).toEqual(["darwin:2.1.286", "linux:2.1.285"]);
  expect(Object.keys(VALIDATED_SESSION_PAIRS).sort()).toEqual(["darwin:2.1.286>linux:2.1.285", "linux:2.1.285>darwin:2.1.286"]);
  // No dot, underscore, space or non-ASCII vector exists, so none is encoded: the substitute is the slash and only the slash.
  for (const entry of Object.values(VALIDATED_SESSION_BUILDS)) expect(entry.substitute).toEqual({ "/": "-" });
  // Every character of every vector is one of the observed ones.
  for (const { one } of vectors) expect(one.cwd).toMatch(/^[A-Za-z0-9/-]+$/);
});

test("a path outside the tested subset has no name: a dot, an underscore, a space, a non-ASCII character, the root, a relative or untidy path, and one past the build's longest vector", () => {
  const darwin = VALIDATED_SESSION_BUILDS["darwin:2.1.286"];
  const linux = VALIDATED_SESSION_BUILDS["linux:2.1.285"];
  for (const cwd of ["/Users/owner/.imprnt-hub/p1", "/a_b", "/a b", "/é", "/", "", "a/b", "/a//b", "/a/", "/a/.", "/a/..", "/a\nb", "/a\\b"]) {
    expect(encodeProjectDir(cwd, darwin), JSON.stringify(cwd)).toBeNull();
    expect(encodeProjectDir(cwd, linux), JSON.stringify(cwd)).toBeNull();
  }
  expect(encodeProjectDir("/var/lib/imprnt-hub/p1/sessions/p1-lair/" + SESSION, linux)).toBe("-var-lib-imprnt-hub-p1-sessions-p1-lair-" + SESSION);
  // The bound is the longest vector of the build itself, computed from its table: a tested subset, not a promise.
  expect(ceilingOf(linux)).toBeLessThan(ceilingOf(darwin));
  for (const entry of [darwin, linux]) {
    const ceiling = ceilingOf(entry);
    expect(encodeProjectDir(`/${"a".repeat(ceiling - 1)}`, entry)?.length).toBe(ceiling);
    expect(encodeProjectDir(`/${"a".repeat(ceiling)}`, entry)).toBeNull();
  }
  // A path the shorter bound refuses is one the longer bound takes.
  const between = `/${"a".repeat(ceilingOf(darwin) - 1)}`;
  expect(encodeProjectDir(between, linux)).toBeNull();
  expect(encodeProjectDir(between, darwin)).not.toBeNull();
});

test("a table that does not reproduce its own vectors, or pairs a build it lacks, does not load; the test copies leave the measured tables as they were", () => {
  const darwin = VALIDATED_SESSION_BUILDS["darwin:2.1.286"];
  expect(() => makeClaudeSessionPort({ builds: { "darwin:2.1.286": { ...darwin, substitute: { "/": "_" } } }, pairs: {} })).toThrow("session-table-invalid");
  expect(() => makeClaudeSessionPort({ builds: { "darwin:2.1.286": { ...darwin, vectors: [] } }, pairs: {} })).toThrow("session-table-invalid");
  expect(() => makeClaudeSessionPort({ builds: { "darwin:2.1.285": darwin }, pairs: {} })).toThrow("session-table-invalid");
  expect(() => makeClaudeSessionPort({ builds: { "darwin:2.1.286": darwin }, pairs: { "darwin:2.1.286>linux:2.1.285": { evidence: "x" } } })).toThrow("session-pair-invalid");
  expect(() => makeClaudeSessionPort(TEST)).not.toThrow();
  for (const entry of Object.values(VALIDATED_SESSION_BUILDS)) expect(entry.substitute).toEqual({ "/": "-" });
});

test("the Claude adapter carries the real port, and the five verbs are untouched", () => {
  expect(claudeCode.session).toBe(claudeSession);
  expect(typeof claudeCode.start).toBe("function");
  expect(typeof claudeCode.capabilities).toBe("function");
});

// ---------------------------------------------------------------------------
// gates

test("the build and the pair are gated by name: an unknown build, a build on the wrong host, the same build on both ends, and a bad session id", () => {
  const root = scratch();
  const { src, out } = exported(root);
  const mac = portOf("darwin");
  const pi = portOf("linux");
  const ask = (version: string, port = mac) => () => port.exportSession({ sessionDir: src.sessionDir, nativeSession: SESSION, version, limits: L });
  expect(codeOf(ask("2.1.0"))).toBe("native_build_unvalidated");
  expect(codeOf(ask("2.1.287"))).toBe("native_build_unvalidated");
  expect(codeOf(ask(PI))).toBe("native_build_unvalidated");
  expect(codeOf(ask(MAC, pi))).toBe("native_build_unvalidated");
  expect(codeOf(ask(MAC))).toBe("none");
  expect(codeOf(() => mac.exportSession({ sessionDir: src.sessionDir, nativeSession: "not-a-uuid", version: MAC, limits: L }))).toBe("native_session_invalid");
  expect(codeOf(() => mac.exportSession({ sessionDir: src.sessionDir, nativeSession: SESSION.toUpperCase(), version: MAC, limits: L }))).toBe("native_session_invalid");

  const dst = join(root, "dst", "a");
  expect(codeOf(() => importInto(pi, out, dst, "2.1.0"))).toBe("native_build_unvalidated");
  // darwin 2.1.286 to darwin 2.1.286: both ends are measured builds, the pair never was.
  expect(codeOf(() => importInto(mac, out, dst, MAC))).toBe("native_pair_unvalidated");
  // darwin 2.1.286 to linux 2.1.286 or darwin 2.1.285: no such measured build on that host.
  expect(codeOf(() => importInto(pi, out, dst, MAC))).toBe("native_build_unvalidated");
  expect(existsSync(join(root, "dst")), "nothing was created for any refusal").toBe(false);
});

// ---------------------------------------------------------------------------
// export

test("an export carries the transcript and nothing else: the credential, config, backups and sessions files, home and tmp are listed at most and never read", () => {
  const root = scratch();
  const src = seed(join(root, "src"), "linux");
  put(src.sessionDir, "config/.claude.json", '{"userID":"x"}');
  put(src.sessionDir, "config/backups/x", "backup");
  put(src.sessionDir, "config/sessions/2.json", "{}");
  put(src.sessionDir, "config/.credentials.json", '{"token":"never-read"}');
  put(src.sessionDir, "home/.cache/mcp-logs/2026-10-01.jsonl", "log\n");
  put(src.sessionDir, "tmp/scratch", "scratch");
  put(src.sessionDir, "instructions.md", "instructions");
  const before = fingerprint(src.sessionDir);
  // A second line of defence only, and no proof on its own: root or a permissive mount reads a mode 000 file all the same.
  // What proves the credential was not opened is the recorder below.
  if (process.getuid?.() !== 0) chmodSync(join(src.sessionDir, "config/.credentials.json"), 0);

  const listed: string[] = [];
  const read: string[] = [];
  const out = portOf("linux", { listed: rel => listed.push(rel), read: rel => read.push(rel) })
    .exportSession({ sessionDir: src.sessionDir, nativeSession: SESSION, version: PI, limits: L });

  // The seam sees what the port and the capture opened: the transcript, once, and nothing else.
  expect(read).toEqual([src.rel]);
  // The credential and the other measured-unneeded entries were looked at by lstat alone, and nothing under them was.
  expect(listed).toEqual(expect.arrayContaining(["config/.credentials.json", "config/.claude.json", "config/backups", "config/sessions", "config/projects"]));
  for (const rel of listed) expect(rel.startsWith("config/")).toBe(true);
  expect(listed.some(rel => rel.startsWith("config/backups/") || rel.startsWith("config/sessions/"))).toBe(false);

  expect(out.manifest.files).toEqual([{ path: src.rel, sha256: sha256Hex(TRANSCRIPT), size: TRANSCRIPT.length, mode: 0o600 }]);
  expect(out.manifest.from).toEqual({ version: PI, os: "linux", cwd: src.cwd, project_dir: src.projectDir });
  expect(out.manifest).toMatchObject({ version: 1, adapter: "claude-code", native_session: SESSION, rule: "slash-dash-v1" });
  expect([...out.bundle.manifest.entries.map(one => `${one.class}:${one.path}`)]).toEqual([`native:${src.rel}`]);
  expect(Buffer.from(out.bundle.contents.get(`native\0${src.rel}`)!).equals(TRANSCRIPT)).toBe(true);
  expect(out.digest).toBe(nativeManifestDigest(out.manifest));
  chmodSync(join(src.sessionDir, "config/.credentials.json"), 0o600);
  expect(fingerprint(src.sessionDir), "the source was only read").toEqual(before);
});

test("side state nobody measured a move without is refused by name and path: an extra config entry, a side directory, a second transcript, an entry of the wrong kind", () => {
  const cases: [string, (dir: string, projectDir: string) => void, string][] = [
    ["file-history", dir => put(dir, "config/file-history/a", "x"), "config/file-history"],
    ["todos", dir => put(dir, "config/todos/a.json", "[]"), "config/todos"],
    ["settings", dir => put(dir, "config/settings.json", "{}"), "config/settings.json"],
    ["side dir", (dir, project) => put(dir, `config/projects/${project}/${SESSION}/subagents/a.jsonl`, "x"), `config/projects/`],
    ["second transcript", (dir, project) => put(dir, `config/projects/${project}/${OTHER}.jsonl`, "x"), `/${OTHER}.jsonl`],
    ["claude.json as a directory", dir => mkdirSync(join(dir, "config/.claude.json")), "config/.claude.json"],
    ["backups as a link", dir => symlinkSync("/nonexistent", join(dir, "config/backups")), "config/backups"],
    ["a file among the projects", dir => put(dir, "config/projects/stray", "x"), "config/projects/stray"],
  ];
  for (const [name, plant, path] of cases) {
    const root = scratch();
    const src = seed(join(root, "src"), "darwin");
    plant(src.sessionDir, src.projectDir);
    const run = () => portOf("darwin").exportSession({ sessionDir: src.sessionDir, nativeSession: SESSION, version: MAC, limits: L });
    expect(codeOf(run), name).toBe("native_side_state_unsupported");
    expect(pathOf(run), name).toContain(path);
  }
});

test("a missing or ambiguous transcript is refused: no config, no projects, no folder, a folder without this session, and two folders", () => {
  const run = (dir: string, session = SESSION) => () => portOf("darwin").exportSession({ sessionDir: dir, nativeSession: session, version: MAC, limits: L });
  const bare = join(scratch(), "bare");
  mkdirSync(bare, { recursive: true });
  expect(codeOf(run(bare))).toBe("native_transcript_missing");

  const noProjects = join(scratch(), "a");
  mkdirSync(join(noProjects, "config"), { recursive: true });
  expect(codeOf(run(noProjects))).toBe("native_transcript_missing");

  const emptyProjects = join(scratch(), "a");
  mkdirSync(join(emptyProjects, "config/projects"), { recursive: true });
  expect(codeOf(run(emptyProjects))).toBe("native_transcript_missing");

  const emptyFolder = join(scratch(), "a");
  mkdirSync(join(emptyFolder, "config/projects/-x"), { recursive: true });
  expect(codeOf(run(emptyFolder))).toBe("native_transcript_missing");

  const other = seed(join(scratch(), "a"), "darwin", { session: OTHER });
  expect(codeOf(run(other.sessionDir))).toBe("native_transcript_missing");
  expect(pathOf(run(other.sessionDir))).toBe(`config/projects/${other.projectDir}`);

  const two = seed(join(scratch(), "a"), "darwin");
  mkdirSync(join(two.sessionDir, "config/projects/-second"));
  expect(codeOf(run(two.sessionDir))).toBe("native_locator_ambiguous");
});

test("a folder where the build's rule would not put it is refused; a source outside the subset still exports, its folder observed and not computed", () => {
  const root = scratch();
  const wrong = seed(join(root, "wrong"), "darwin", { projectDir: "-not-where-the-rule-says" });
  const run = (dir: string) => () => portOf("darwin").exportSession({ sessionDir: dir, nativeSession: SESSION, version: MAC, limits: L });
  expect(codeOf(run(wrong.sessionDir))).toBe("native_locator_rule_mismatch");
  expect(pathOf(run(wrong.sessionDir))).toBe("config/projects/-not-where-the-rule-says");

  // A space is outside every table, so the rule has no say and the observed folder is carried.
  const outside = seed(join(root, "has space"), "darwin", { projectDir: "-observed-by-the-engine" });
  expect(encodeProjectDir(outside.cwd, entryOf("darwin"))).toBeNull();
  const out = run(outside.sessionDir)();
  expect(out.manifest.from.project_dir).toBe("-observed-by-the-engine");
  expect(out.manifest.from.cwd).toBe(outside.cwd);
});

test("a transcript over the caller's bound is the library's own named refusal, passed through", () => {
  const root = scratch();
  const src = seed(join(root, "src"), "darwin");
  const run = () => portOf("darwin").exportSession({ sessionDir: src.sessionDir, nativeSession: SESSION, version: MAC, limits: { ...L, maxFileBytes: 8 } });
  expect(codeOf(run)).toBe("limit-file-bytes");
  expect(run).toThrow(TransferError);
});

test("the manifest digest is the sha256 of one canonical text: independent of key order, changed by one byte", () => {
  const root = scratch();
  const { out } = exported(root);
  const reordered = JSON.parse(JSON.stringify({
    files: [{ mode: out.manifest.files[0].mode, size: out.manifest.files[0].size, sha256: out.manifest.files[0].sha256, path: out.manifest.files[0].path }],
    from: { project_dir: out.manifest.from.project_dir, cwd: out.manifest.from.cwd, os: out.manifest.from.os, version: out.manifest.from.version },
    rule: out.manifest.rule, native_session: out.manifest.native_session, adapter: out.manifest.adapter, version: out.manifest.version,
  })) as NativeManifest;
  expect(Object.keys(reordered)).not.toEqual(Object.keys(out.manifest));
  expect(canonicalNativeManifest(reordered)).toBe(canonicalNativeManifest(out.manifest));
  expect(nativeManifestDigest(reordered)).toBe(out.digest);
  expect(out.digest).toBe(sha256Hex(Buffer.from(canonicalNativeManifest(out.manifest))));
  // The import takes the reordered manifest as it takes the original.
  const dst = join(root, "dst", "a");
  expect(importInto(portOf("linux"), { ...out, manifest: reordered }, dst, PI).native_manifest_digest).toBe(out.digest);

  const flipped = structuredClone(out.manifest);
  flipped.files[0].sha256 = (flipped.files[0].sha256[0] === "0" ? "1" : "0") + flipped.files[0].sha256.slice(1);
  expect(nativeManifestDigest(flipped)).not.toBe(out.digest);
  const longer = structuredClone(out.manifest);
  longer.files[0].size += 1;
  expect(nativeManifestDigest(longer)).not.toBe(out.digest);
});

// ---------------------------------------------------------------------------
// import

test("a move in either measured direction puts the transcript byte for byte at the destination's own folder, with nothing else and no login, and the receipt binds the mapping", () => {
  for (const [from, to, toVersion] of [["darwin", "linux", PI], ["linux", "darwin", MAC]] as const) {
    const root = scratch();
    const { src, out } = exported(root, from);
    const sourceBefore = fingerprint(src.sessionDir);
    const dst = join(root, "dst", "deeper", SESSION);
    const imported = importInto(portOf(to), out, dst, toVersion);

    const projectDir = encodeProjectDir(dst, entryOf(to))!;
    const rel = `config/projects/${projectDir}/${SESSION}.jsonl`;
    expect(projectDir).not.toBe(src.projectDir);
    expect(sha256Hex(readFileSync(join(dst, rel)))).toBe(sha256Hex(TRANSCRIPT));
    expect(lstatSync(join(dst, rel)).mode & 0o777).toBe(0o600);
    // The tree is the stage's marker and the engine directory, and in it the one folder and the one file.
    expect(readdirSync(dst).sort()).toEqual([MARKER, "config"]);
    expect(readdirSync(join(dst, "config"))).toEqual(["projects"]);
    expect(readdirSync(join(dst, "config/projects"))).toEqual([projectDir]);
    expect(readdirSync(join(dst, "config/projects", projectDir))).toEqual([`${SESSION}.jsonl`]);

    expect(imported.native_manifest_digest).toBe(out.digest);
    expect(imported.to).toEqual({ version: toVersion, os: to, cwd: dst, project_dir: projectDir });
    expect(imported.transcript).toEqual({ path: rel, sha256: sha256Hex(TRANSCRIPT), size: TRANSCRIPT.length, mode: 0o600 });
    expect(imported.reused).toBe(false);
    expect(imported.receipt).toMatchObject({ destination: dst, createdRoot: true });
    // The staged bundle is the destination's own: same bytes, another path, so another digest than the source's.
    const expected = buildBundle([{ path: rel, class: "native", mode: 0o600, bytes: TRANSCRIPT }], L);
    expect(imported.bundle_digest).toBe(expected.manifest.digest);
    expect(imported.bundle_digest).not.toBe(out.bundle.manifest.digest);
    expect(imported.receipt.manifestDigest).toBe(imported.bundle_digest);
    expect(fingerprint(src.sessionDir), `${from} source untouched`).toEqual(sourceBefore);
  }
});

test("a destination outside the tested subset is refused before anything is created, parent directories included", () => {
  const root = scratch();
  const { out } = exported(root);
  for (const name of ["has space", "café"]) {
    const parent = join(root, name);
    expect(codeOf(() => importInto(portOf("linux"), out, join(parent, "a"), PI)), name).toBe("native_locator_unsupported_path");
    expect(existsSync(parent), name).toBe(false);
  }
  // The measured tables take no dot or underscore: a state directory that has one is an open gate, not a guess.
  const real = makeClaudeSessionPort(undefined, { os: "linux" });
  const parent = join(root, "dot.dir");
  expect(codeOf(() => importInto(real, out, join(parent, "a"), PI))).toBe("native_locator_unsupported_path");
  expect(existsSync(parent)).toBe(false);
  // Not absolute, or not tidy: the library's own refusal.
  expect(codeOf(() => importInto(portOf("linux"), out, "relative/a", PI))).toBe("destination-invalid");
  expect(codeOf(() => importInto(portOf("linux"), out, `${root}/x/../a`, PI))).toBe("destination-invalid");
});

test("an existing destination, empty or not, is a collision and is left exactly as it was", () => {
  const root = scratch();
  const { out } = exported(root);
  const pi = portOf("linux");
  const cases: [string, (dst: string) => void][] = [
    ["empty directory", dst => mkdirSync(dst, { recursive: true })],
    ["foreign contents", dst => put(dst, "keep.txt", "mine")],
    ["foreign engine directory", dst => put(dst, "config/projects/-x/a.jsonl", "mine")],
    ["a file", dst => { mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, "file"); }],
    ["a link to a directory", dst => { mkdirSync(join(dirname(dst), "target"), { recursive: true }); symlinkSync(join(dirname(dst), "target"), dst); }],
    ["a marker that is not a complete stage", dst => put(dst, MARKER, '{"state":"staging"}')],
    ["junk where the marker is", dst => put(dst, MARKER, "not json")],
  ];
  for (const [name, plant] of cases) {
    const dst = join(scratch(), "dst", "a");
    plant(dst);
    const before = snapshot(dst);
    expect(codeOf(() => importInto(pi, out, dst, PI)), name).toBe("native_dest_session_collision");
    expect(snapshot(dst), name).toEqual(before);
  }
});

test("a directory that appears between the check and the stage is never kept: an empty one has what was staged removed and stays, a foreign one is left whole", () => {
  const root = scratch();
  const { out } = exported(root);

  const emptied = join(root, "dst", "empty");
  const raced = portOf("linux", { beforeStage: dir => mkdirSync(dir) });
  expect(codeOf(() => importInto(raced, out, emptied, PI))).toBe("native_dest_session_collision");
  expect(existsSync(emptied), "the directory that appeared is not ours to remove").toBe(true);
  expect(readdirSync(emptied), "and nothing of the stage is left in it").toEqual([]);

  const foreign = join(root, "dst", "foreign");
  const raced2 = portOf("linux", { beforeStage: dir => { mkdirSync(dir); writeFileSync(join(dir, "keep.txt"), "mine"); } });
  expect(codeOf(() => importInto(raced2, out, foreign, PI))).toBe("native_dest_session_collision");
  expect(readdirSync(foreign)).toEqual(["keep.txt"]);
  expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("mine");
});

test("a retry of the same operation after a complete stage is reused and writes nothing; any other operation or bundle, and a stage into a foreign empty directory, are collisions", () => {
  const root = scratch();
  const { out } = exported(root);
  const pi = portOf("linux");
  const dst = join(root, "dst", "a");
  const first = importInto(pi, out, dst, PI, "op-1");
  const before = fingerprint(dst);

  const again = importInto(pi, out, dst, PI, "op-1");
  expect(again.reused).toBe(true);
  expect(again.receipt.generation).toBe(first.receipt.generation);
  expect(again.to).toEqual(first.to);
  expect(again.bundle_digest).toBe(first.bundle_digest);
  expect(fingerprint(dst), "nothing was written").toEqual(before);

  // Not this operation, and not this bundle: the directory is somebody else's.
  expect(codeOf(() => importInto(pi, out, dst, PI, "op-2"))).toBe("native_dest_session_collision");
  const changed = exported(scratch(), "darwin", { text: Buffer.from("another transcript\n") }).out;
  expect(codeOf(() => importInto(pi, changed, dst, PI, "op-1"))).toBe("native_dest_session_collision");
  expect(fingerprint(dst)).toEqual(before);

  // A complete stage of this very bundle and operation that went into a directory somebody else made is not a crash retry.
  const adopted = join(root, "dst", "adopted");
  mkdirSync(adopted, { recursive: true });
  const rel = first.transcript.path.replace(first.to.project_dir, encodeProjectDir(adopted, entryOf("linux"))!);
  stageBundle({ bundle: buildBundle([{ path: rel, class: "native", mode: 0o600, bytes: TRANSCRIPT }], L), destination: adopted, classes: ["native"], operation: "op-1", limits: L });
  const staged = fingerprint(adopted);
  expect(codeOf(() => importInto(pi, out, adopted, PI, "op-1"))).toBe("native_dest_session_collision");
  expect(fingerprint(adopted)).toEqual(staged);
});

test("a discard removes what the stage made and the directory it created, and nothing of anyone else's", () => {
  const root = scratch();
  const { src, out } = exported(root);
  const pi = portOf("linux");

  const clean = join(root, "dst", "clean");
  const imported = importInto(pi, out, clean, PI);
  pi.discardImport(imported.receipt);
  expect(existsSync(clean)).toBe(false);
  expect(existsSync(join(root, "dst")), "the parent was there to be made, not the stage's to remove").toBe(true);
  expect(readFileSync(join(src.sessionDir, src.rel)).equals(TRANSCRIPT), "the source is not touched").toBe(true);

  // Something else in the directory (here a launch's own file): the stage's files go, the other stays, the refusal is named.
  const busy = join(root, "dst", "busy");
  const second = importInto(pi, out, busy, PI, "op-2");
  writeFileSync(join(busy, "box.sb"), "launched");
  const run = () => pi.discardImport(second.receipt);
  expect(codeOf(run)).toBe("stage-ambiguous");
  expect(readFileSync(join(busy, "box.sb"), "utf8")).toBe("launched");
  // The library does not stop for what a directory gained: the unchanged transcript and the marker were removed first, so nothing records it.
  expect(existsSync(join(busy, second.transcript.path))).toBe(false);
  expect(codeOf(run)).toBe("stage-stale");

  // A listed file that is no longer what the stage wrote (a resume appended to it): nothing is removed at all.
  const grown = join(root, "dst", "grown");
  const third = importInto(pi, out, grown, PI, "op-3");
  appendFileSync(join(grown, third.transcript.path), '{"type":"user","n":3}\n');
  const kept = fingerprint(grown);
  expect(codeOf(() => pi.discardImport(third.receipt))).toBe("stage-ambiguous");
  expect(pathOf(() => pi.discardImport(third.receipt))).toBe(third.transcript.path);
  expect(fingerprint(grown)).toEqual(kept);
});

// ---------------------------------------------------------------------------
// tampering

test("an export that is not what its manifest says is refused before a byte is staged: a changed byte, a swapped manifest or bundle, an unknown key, a folder that disagrees with the bundle's path, a forged rule", () => {
  const root = scratch();
  const { out } = exported(root);
  const other = exported(scratch(), "darwin", { session: OTHER, text: Buffer.from("other\n") }).out;
  const pi = portOf("linux");
  const dst = join(root, "dst", "a");
  const attempt = (over: Partial<Parameters<NativeSessionPort["importSession"]>[0]>) => () =>
    pi.importSession({ manifest: out.manifest, digest: out.digest, bundle: out.bundle, sessionDir: dst, version: PI, operation: "op-1", limits: L, ...over });
  const forged = (change: (manifest: NativeManifest) => void, bundle?: Bundle) => {
    const manifest = structuredClone(out.manifest);
    change(manifest);
    return attempt({ manifest, digest: nativeManifestDigest(manifest), ...(bundle ? { bundle } : {}) });
  };

  const bytes = new Map(out.bundle.contents);
  const key = [...bytes.keys()][0];
  const flipped = Buffer.from(bytes.get(key)!);
  flipped[0] ^= 1;
  expect(codeOf(attempt({ bundle: { manifest: out.bundle.manifest, contents: new Map([[key, flipped]]) } }))).toBe("native_export_mismatch");
  expect(codeOf(attempt({ bundle: { manifest: out.bundle.manifest, contents: new Map() } }))).toBe("native_export_mismatch");
  expect(codeOf(attempt({ bundle: { manifest: out.bundle.manifest, contents: new Map([...bytes, ["native\0extra", Buffer.from("x")]]) } }))).toBe("native_export_mismatch");
  // Another session's manifest under this digest, and another session's bundle under this manifest.
  expect(codeOf(attempt({ manifest: other.manifest }))).toBe("native_export_mismatch");
  expect(codeOf(attempt({ bundle: other.bundle }))).toBe("native_export_mismatch");
  expect(codeOf(attempt({ digest: "0".repeat(64) }))).toBe("native_export_mismatch");
  expect(codeOf(attempt({ manifest: { ...out.manifest, extra: 1 } }))).toBe("native_export_mismatch");
  expect(codeOf(attempt({ manifest: "nonsense" }))).toBe("native_export_mismatch");
  // The manifest and its digest agree with each other and not with the bundle's path.
  expect(codeOf(forged(manifest => {
    manifest.from.project_dir = "-elsewhere";
    manifest.files[0].path = `config/projects/-elsewhere/${SESSION}.jsonl`;
  }))).toBe("native_export_mismatch");
  expect(codeOf(forged(manifest => { manifest.files[0].mode = 0o644; }))).toBe("native_export_mismatch");
  expect(codeOf(forged(manifest => { manifest.native_session = OTHER; manifest.files[0].path = manifest.files[0].path.replace(SESSION, OTHER); }))).toBe("native_export_mismatch");
  // A consistent export whose recorded folder is not the one the source's rule gives for its recorded directory, and one naming another rule.
  const lie = structuredClone(out.manifest);
  lie.from.cwd = "/tmp/abc";
  lie.from.project_dir = "-wrong";
  lie.files[0].path = `config/projects/-wrong/${SESSION}.jsonl`;
  const lied = buildBundle([{ path: lie.files[0].path, class: "native", mode: 0o600, bytes: TRANSCRIPT }], L);
  expect(codeOf(attempt({ manifest: lie, digest: nativeManifestDigest(lie), bundle: lied }))).toBe("native_locator_rule_mismatch");
  expect(codeOf(forged(manifest => { manifest.rule = "something-else"; }))).toBe("native_locator_rule_mismatch");
  expect(existsSync(join(root, "dst")), "nothing was created for any of it").toBe(false);
});

// ---------------------------------------------------------------------------
// after a resumed turn

/** An imported session, and what a resume that kept the layout would leave in it. */
function imported() {
  const root = scratch();
  const { out } = exported(root);
  const pi = portOf("linux");
  const dst = join(root, "dst", "a");
  const done = importInto(pi, out, dst, PI);
  const check = (reported: string | null = SESSION, over: Partial<Parameters<NativeSessionPort["checkResumed"]>[0]> = {}) => () =>
    pi.checkResumed({ sessionDir: dst, imported: done, nativeSession: SESSION, reportedSessionId: reported, limits: L, ...over });
  return { dst, done, check, transcript: join(dst, done.transcript.path), folder: join(dst, "config/projects", done.to.project_dir) };
}

test("a resumed session that appended to the imported transcript is verified, whatever else the engine wrote around it", () => {
  const { dst, check, transcript } = imported();
  // Right after the import nothing was recorded, and a transcript that did not grow is not evidence of a turn; after a turn that appended it is.
  expect(codeOf(check())).toBe("native_resume_unverified");
  appendFileSync(transcript, '{"type":"user","n":3}\n{"type":"assistant","n":4}\n');
  // What a resume was measured to leave besides: a fresh config file, backups and session files, and a server log under home.
  put(dst, "config/.claude.json", "{}");
  put(dst, "config/backups/x", "b");
  put(dst, "config/sessions/9.json", "{}");
  put(dst, "home/.cache/mcp-logs/2026-10-01T10-00-00.jsonl", "log\n");
  put(dst, "home/Library/Caches/mcp.jsonl", "log\n");
  expect(codeOf(check())).toBe("none");
});

test("a resume that does not leave the measured layout is refused by name: an unchanged, truncated or rewritten transcript, another transcript, another id, a missing or relinked file", () => {
  // Each case on a fresh import whose transcript a turn appended to; none of them starts a turn, retries or changes the tree.
  const fails = (name: string, spoil: (i: ReturnType<typeof imported>) => void, expectPath?: (i: ReturnType<typeof imported>) => string, reported: string | null = SESSION) => {
    const i = imported();
    appendFileSync(i.transcript, '{"type":"user","n":3}\n');
    spoil(i);
    const before = fingerprint(i.dst);
    expect(codeOf(i.check(reported)), name).toBe("native_resume_unverified");
    if (expectPath) expect(pathOf(i.check(reported)), name).toBe(expectPath(i));
    expect(fingerprint(i.dst), `${name}: the check changes nothing`).toEqual(before);
  };
  fails("unchanged size: the imported bytes and no turn", i => writeFileSync(i.transcript, TRANSCRIPT), i => i.done.transcript.path);
  fails("truncated", i => writeFileSync(i.transcript, TRANSCRIPT.subarray(0, 10)), i => i.done.transcript.path);
  fails("rewritten, same size", i => writeFileSync(i.transcript, Buffer.from(TRANSCRIPT).fill(0x78)), i => i.done.transcript.path);
  fails("rewritten, longer", i => writeFileSync(i.transcript, Buffer.concat([Buffer.from("compacted\n"), TRANSCRIPT])), i => i.done.transcript.path);
  fails("a new transcript beside it", i => put(i.folder, `${OTHER}.jsonl`, "new\n"), i => `config/projects/${i.done.to.project_dir}/${OTHER}.jsonl`);
  fails("a new transcript in another folder", i => put(i.dst, `config/projects/-elsewhere/${OTHER}.jsonl`, "new\n"), () => `config/projects/-elsewhere/${OTHER}.jsonl`);
  fails("a subagent transcript", i => put(i.folder, `${SESSION}/subagents/a.jsonl`, "new\n"), i => `config/projects/${i.done.to.project_dir}/${SESSION}/subagents/a.jsonl`);
  fails("the transcript is gone", i => rmSync(i.transcript), i => i.done.transcript.path);
  fails("the transcript is a link", i => { rmSync(i.transcript); symlinkSync(join(i.dst, "elsewhere"), i.transcript); writeFileSync(join(i.dst, "elsewhere"), TRANSCRIPT); }, i => i.done.transcript.path);
  fails("the engine reported no id", () => {}, undefined, null);
  fails("the engine reported another id", () => {}, undefined, OTHER);
});

test("the runner's resume-check bound admits a resumed session; the one-file move bound refused every one; past the bound is still refused", () => {
  const { check, transcript, folder } = imported();
  appendFileSync(transcript, '{"type":"user","n":3}\n{"type":"assistant","n":4}\n');
  // The walk counts entries: the project folder and the transcript are two, so the move's own bound refused a genuine resume.
  expect(MOVE_NATIVE_LIMITS.maxFiles).toBe(1);
  expect(codeOf(check(SESSION, { limits: MOVE_NATIVE_LIMITS }))).toBe("native_resume_unverified");
  expect(codeOf(check(SESSION, { limits: RESUME_CHECK_LIMITS }))).toBe("none");
  // Only the entry cap differs; the byte bounds are the move's.
  expect(RESUME_CHECK_LIMITS).toEqual({ ...MOVE_NATIVE_LIMITS, maxFiles: RESUME_CHECK_LIMITS.maxFiles });
  // Folder + transcript + fillers: exactly at the bound passes, one more entry is refused.
  for (let n = 0; n < RESUME_CHECK_LIMITS.maxFiles - 2; n++) writeFileSync(join(folder, `f${n}.txt`), "");
  expect(codeOf(check(SESSION, { limits: RESUME_CHECK_LIMITS }))).toBe("none");
  writeFileSync(join(folder, "over.txt"), "");
  expect(codeOf(check(SESSION, { limits: RESUME_CHECK_LIMITS }))).toBe("native_resume_unverified");
});

test("a check that is handed something other than the import is refused: a path that is not the mapped one, another session, a moved directory", () => {
  const i = imported();
  // The transcript grew, so each refusal below is for what was handed in and not for a turn that left no trace.
  appendFileSync(i.transcript, '{"type":"user","n":3}\n');
  expect(codeOf(i.check(SESSION, { imported: { ...i.done, transcript: { ...i.done.transcript, path: `config/projects/-x/${SESSION}.jsonl` } } }))).toBe("native_resume_unverified");
  expect(codeOf(i.check(OTHER, { nativeSession: OTHER }))).toBe("native_resume_unverified");
  expect(codeOf(i.check(SESSION, { nativeSession: "nope" }))).toBe("native_resume_unverified");
  expect(codeOf(i.check(SESSION, { imported: { ...i.done, to: { ...i.done.to, cwd: `${i.done.to.cwd}x` } } }))).toBe("native_resume_unverified");
  expect(codeOf(i.check(SESSION, { imported: { ...i.done, transcript: { ...i.done.transcript, sha256: "0".repeat(64) } } }))).toBe("native_resume_unverified");
  expect(codeOf(i.check(SESSION, { limits: { ...L, maxFiles: 0 } })), "an entry count past the bound is not scanned past").toBe("native_resume_unverified");
  expect(codeOf(i.check())).toBe("none");
});

// ---------------------------------------------------------------------------
// the pure preflight a handoff asks before any byte moves

test("destination() answers by the rule importSession applies and creates nothing: the measured subset is accepted, a dot, an underscore, an over-long path and an unknown build are not", () => {
  const root = scratch();
  const linux = makeClaudeSessionPort(undefined, { os: "linux" });
  const darwin = makeClaudeSessionPort(undefined, { os: "darwin" });
  const entry = VALIDATED_SESSION_BUILDS["linux:2.1.285"];

  // A directory that does not exist yet is answered from its deepest existing ancestor's realpath; nothing is made for the answer.
  const tidy = join(root, "state-p1", "sessions", "p1-lair", SESSION);
  const wideLinux = portOf("linux");
  const side = wideLinux.destination({ sessionDir: tidy, version: PI });
  const tidyProjectDir = encodeProjectDir(tidy, entryOf("linux"));
  if (tidyProjectDir === null) throw new Error("the tidy path must encode under the linux entry");
  expect(side).toEqual({ version: PI, os: "linux", cwd: tidy, project_dir: tidyProjectDir });
  expect(existsSync(join(root, "state-p1")), "nothing was created").toBe(false);
  // The same answer is the one the import then acts on.
  const { out } = exported(scratch());
  expect(importInto(wideLinux, out, tidy, PI).to).toEqual(side);

  const real = linux.destination({ sessionDir: `/tmp/imprnt-hub-none/p1/sessions/p1-lair/${SESSION}`, version: PI });
  expect(real).toMatchObject({ version: PI, os: "linux" });
  expect(real.project_dir).toBe(real.cwd.replaceAll("/", "-"));

  const ask = (port: NativeSessionPort, sessionDir: string, version: string) => codeOf(() => port.destination({ sessionDir, version }));
  expect(ask(linux, "/tmp/dot.dir/a", PI)).toBe("native_locator_unsupported_path");
  expect(ask(linux, "/tmp/under_score/a", PI)).toBe("native_locator_unsupported_path");
  expect(ask(linux, "/tmp/has space/a", PI)).toBe("native_locator_unsupported_path");
  const ceiling = ceilingOf(entry);
  expect(ask(linux, `/${"a".repeat(ceiling - 1)}`, PI)).toBe("none");
  expect(ask(linux, `/${"a".repeat(ceiling)}`, PI)).toBe("native_locator_unsupported_path");
  expect(ask(linux, "/tmp/a", "2.1.0")).toBe("native_build_unvalidated");
  expect(ask(linux, "/tmp/a", MAC), "a build the other host measured").toBe("native_build_unvalidated");
  expect(ask(darwin, "/tmp/a", MAC)).toBe("none");
  expect(ask(linux, "relative/a", PI)).toBe("destination-invalid");
  expect(ask(linux, `${root}/x/../a`, PI)).toBe("destination-invalid");
});

test("portability() is the table's own entry for the pair, from either host, and refuses a pair nobody moved between", () => {
  const mac = portOf("darwin");
  const pi = portOf("linux");
  for (const port of [mac, pi]) {
    expect(port.portability({ from: { os: "darwin", version: MAC }, to: { os: "linux", version: PI } })).toEqual({
      adapter: "claude-code", from: `darwin:${MAC}`, to: `linux:${PI}`, evidence: VALIDATED_SESSION_PAIRS[`darwin:${MAC}>linux:${PI}`].evidence,
    });
    expect(port.portability({ from: { os: "linux", version: PI }, to: { os: "darwin", version: MAC } }).evidence).toBe(VALIDATED_SESSION_PAIRS[`linux:${PI}>darwin:${MAC}`].evidence);
  }
  const ask = (from: { os: string; version: string }, to: { os: string; version: string }) => codeOf(() => mac.portability({ from, to }));
  expect(ask({ os: "darwin", version: MAC }, { os: "darwin", version: MAC }), "two builds on one host").toBe("native_pair_unvalidated");
  expect(ask({ os: "linux", version: PI }, { os: "linux", version: PI })).toBe("native_pair_unvalidated");
  expect(ask({ os: "darwin", version: "2.1.0" }, { os: "linux", version: PI })).toBe("native_build_unvalidated");
  expect(ask({ os: "darwin", version: MAC }, { os: "linux", version: MAC })).toBe("native_build_unvalidated");
  expect(ask({ os: "plan9", version: MAC }, { os: "linux", version: PI })).toBe("native_build_unvalidated");
});

test("G1: with the measured tables a macOS state directory with a dot, the registry's own example, is refused: the gate stays open and nothing here claims it covered", () => {
  const registryExample = `/Users/owner/.imprnt-hub/p1/sessions/p1-lair/${SESSION}`;
  expect(codeOf(() => makeClaudeSessionPort(undefined, { os: "darwin" }).destination({ sessionDir: registryExample, version: MAC }))).toBe("native_locator_unsupported_path");
  // The dot is the whole reason: on the other host's build too, and the same path without it is inside the measured subset.
  expect(codeOf(() => makeClaudeSessionPort(undefined, { os: "linux" }).destination({ sessionDir: registryExample, version: PI }))).toBe("native_locator_unsupported_path");
  expect(codeOf(() => makeClaudeSessionPort(undefined, { os: "darwin" }).destination({ sessionDir: registryExample.replace(".imprnt-hub", "imprnt-hub"), version: MAC }))).toBe("none");
});
