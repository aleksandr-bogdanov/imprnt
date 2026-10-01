import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildBundle, contentKey, exactKeys, pathProblem, sha256Hex, STAGE_MARKER, TransferError, verifyBundle,
} from "../transfer/bundle.ts";
import { captureWorkspace, discardStaged, errnoOf, lstatBelow, stageBundle, type StageResult } from "../transfer/workspace.ts";
import {
  NativeRefusal, type NativeExport, type NativeFile, type NativeImport, type NativeManifest, type NativeSessionPort, type NativeSide,
} from "./types.ts";

/**
 * Moving a Claude Code session between two machines: its one transcript, taken
 * from `<sessionDir>/config/projects/<dir>/<uuid>.jsonl` and put at the same
 * place under another session directory, with `<dir>` worked out for the new
 * directory. The transcript's bytes are carried verbatim: nothing in them is
 * parsed, and no absolute path inside them is rewritten.
 *
 * What this is, and is not. It is the one layout somebody measured, and only
 * that: a short synthetic session whose tool calls had all completed, moved in
 * both directions between darwin 2.1.286 and linux 2.1.285, each resumed once
 * under its new realpath. It is NOT the engine's general rule for naming a
 * project folder, and it does not say that longer, compacted or tool-heavy
 * sessions resume, or that any other build, host or pair does. Everything
 * outside it is refused by name rather than guessed at, and no model is started
 * here: no calibration turn, no probe, no fresh session in place of a refused
 * one.
 *
 * Where the facts live. `VALIDATED_SESSION_BUILDS` and `VALIDATED_SESSION_PAIRS`
 * are written like `VALIDATED_SAFE_RESUME`: an entry is there for what was
 * actually run, a build that is not there is refused, and a CLI auto-update
 * blocks moves until somebody measures it. Each entry carries its own vectors
 * (a working directory and the folder name the engine was seen to make for it),
 * and a table is checked against its vectors when a port is made, so a rule
 * that no longer reproduces what was measured does not load.
 *
 * What the caller owns. Every call on one session directory is serialised by
 * the caller. Export reads a source the caller has proved quiet: capture
 * refuses a change it can see while it reads, and nothing more is claimed.
 * Import and discard are not atomic beyond what the transfer library's staging
 * says of itself (a marker, then files created exclusively, then a marker that
 * says complete), and the final directory is created by the stage at its final
 * name: there is no rename into place, so nothing here makes a session
 * invisible until it is activated. That ownership change is the caller's, and
 * nothing may launch the conversation at the destination before it.
 *
 * Also the caller's, and an integration gate rather than anything checked here: comparing the export's `digest` with
 * its own record of the export (the check in `importSession` only shows the manifest agrees with the digest it was
 * sent with), and recovering a stage that was interrupted before its marker said complete (it has no receipt, so
 * `discardImport` cannot reach it and a retry refuses it as a collision).
 */

const ADAPTER = "claude-code";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CHUNK = 64 * 1024;
/** A stage marker for one file is a few hundred bytes; this only bounds what is read to look at it. */
const MARKER_READ_BYTES = 64 * 1024;
const PROJECTS = "config/projects";

// ---------------------------------------------------------------------------
// the measured facts

/** One working directory and the folder name the engine was SEEN to make for it. */
export interface SessionVector { cwd: string; project_dir: string; evidence: string }

/** One engine build on one host, and the rule that reproduced its vectors. */
export interface SessionRule {
  os: "darwin" | "linux";
  version: string;
  rule: string;
  /** Characters of a working directory that the build was seen to write as another one. A character in neither this nor `[A-Za-z0-9-]` is not encoded at all. */
  substitute: Readonly<Record<string, string>>;
  vectors: readonly SessionVector[];
}

export interface SessionPair { evidence: string }

export interface SessionTables {
  /** Keyed `os:version`. */
  builds: Readonly<Record<string, SessionRule>>;
  /** Keyed `fromOs:fromVersion>toOs:toVersion`. Both ends must be in `builds`. */
  pairs: Readonly<Record<string, SessionPair>>;
}

/**
 * The builds whose project-folder naming was OBSERVED, per host: the realpath of
 * a session's working directory against the folder the engine created for it
 * under `config/projects/`, each `/` written as `-`.
 *
 * Four vectors, all from one synthetic fixture:
 * - darwin 2.1.286, source (`native-reviewed-manifest-v1.json`);
 * - linux 2.1.285, destination, calibrated and resumed (`native-resume-pi-v1-result.json`);
 * - linux 2.1.285, source (`reverse-prepare-run-v1-results/pi-source-report.json`);
 * - darwin 2.1.286, destination, calibrated and resumed (`reverse-prepare-run-v1-results/mac-calibration-report.json`,
 *   `reverse-resume-v1-result.json`).
 *
 * The only characters in them are `/`, `a-z`, `0-9`, `-` and the capitals `T` and `Z`. THERE IS NO VECTOR WITH A
 * DOT, AN UNDERSCORE, A SPACE OR A NON-ASCII CHARACTER, so none of them is encoded here, by any build: a
 * destination whose realpath has one is refused (`native_locator_unsupported_path`) until one is measured. That
 * includes the macOS registry example's `/Users/owner/.imprnt-hub`, so a production state directory with a dot is an
 * OPEN GATE and nothing here claims a deployment covered. Linux 2.1.286 and darwin 2.1.285 have no vector either.
 *
 * Each build's length bound is the longest folder name among its own vectors. It is a conservative bound on the
 * tested subset and not a statement of what the engine supports: the engine may encode a longer path another way,
 * and nobody measured where.
 */
export const VALIDATED_SESSION_BUILDS: Readonly<Record<string, SessionRule>> = {
  "darwin:2.1.286": {
    os: "darwin",
    version: "2.1.286",
    rule: "slash-dash-v1",
    substitute: { "/": "-" },
    vectors: [
      {
        cwd: "/private/tmp/hub-move-native-mac-20261001T015203Z/source-20261001-015203-d904dfb9/state/p1/sessions/p1-lair/df5fb5fd-32eb-45b1-9d35-c59ccaa2a97c",
        project_dir: "-private-tmp-hub-move-native-mac-20261001T015203Z-source-20261001-015203-d904dfb9-state-p1-sessions-p1-lair-df5fb5fd-32eb-45b1-9d35-c59ccaa2a97c",
        evidence: "native-reviewed-manifest-v1.json",
      },
      {
        cwd: "/private/tmp/hub-move-native-mac-rev-20261001T022958Z-4176cf/evidence/dest-20261001-023006-d99c8aba/state/p1/sessions/p1-lair/1e261f87-06a7-4242-b039-ec2a6c7173aa",
        project_dir: "-private-tmp-hub-move-native-mac-rev-20261001T022958Z-4176cf-evidence-dest-20261001-023006-d99c8aba-state-p1-sessions-p1-lair-1e261f87-06a7-4242-b039-ec2a6c7173aa",
        evidence: "mac-calibration-report.json, reverse-resume-v1-result.json",
      },
    ],
  },
  "linux:2.1.285": {
    os: "linux",
    version: "2.1.285",
    rule: "slash-dash-v1",
    substitute: { "/": "-" },
    vectors: [
      {
        cwd: "/tmp/hub-move-native-pi-20261001T015446Z/evidence/dest-20261001-015449-99f2b7d0/state/p1/sessions/p1-lair/df5fb5fd-32eb-45b1-9d35-c59ccaa2a97c",
        project_dir: "-tmp-hub-move-native-pi-20261001T015446Z-evidence-dest-20261001-015449-99f2b7d0-state-p1-sessions-p1-lair-df5fb5fd-32eb-45b1-9d35-c59ccaa2a97c",
        evidence: "native-resume-pi-v1-result.json",
      },
      {
        cwd: "/tmp/hub-move-native-pi-rev-20261001T022958Z-4176cf/evidence/source-20261001-023000-8cf90829/state/p1/sessions/p1-lair/1e261f87-06a7-4242-b039-ec2a6c7173aa",
        project_dir: "-tmp-hub-move-native-pi-rev-20261001T022958Z-4176cf-evidence-source-20261001-023000-8cf90829-state-p1-sessions-p1-lair-1e261f87-06a7-4242-b039-ec2a6c7173aa",
        evidence: "pi-source-report.json",
      },
    ],
  },
};

/**
 * The pairs of host and build between which a session was moved and resumed,
 * once each, with the evidence. Same limits as the builds: one short synthetic
 * completed-tool session, one resume. Neither pair says anything about the pair
 * of two builds on one host, or about any build not named.
 */
export const VALIDATED_SESSION_PAIRS: Readonly<Record<string, SessionPair>> = {
  "darwin:2.1.286>linux:2.1.285": { evidence: "native-resume-pi-v1-result.json (corrected classification PASS_SCOPED)" },
  "linux:2.1.285>darwin:2.1.286": { evidence: "reverse-resume-v1-result.json (PASS_SCOPED, sha256 daafcaffdc22b254bea32f5d4875bb733df3036e17087faa2c254c401e359eb2)" },
};

const DEFAULT_TABLES: SessionTables = { builds: VALIDATED_SESSION_BUILDS, pairs: VALIDATED_SESSION_PAIRS };

/** What a session's engine directory may hold beside `projects/` and still have been measured to resume when it was left out. They are never opened. */
const NOT_CARRIED = new Map<string, "file" | "dir">([[".claude.json", "file"], [".credentials.json", "file"], ["backups", "dir"], ["sessions", "dir"]]);

const BASE_CHARACTER = /^[A-Za-z0-9-]$/;

/** The longest folder name among a build's own vectors: the bound of its tested subset, computed from the table. */
function testedLength(entry: SessionRule): number {
  return entry.vectors.reduce((most, one) => Math.max(most, one.project_dir.length), 0);
}

/**
 * The folder name the build is known to make for `cwd`, or null.
 *
 * A VALIDATED SUBSET, NOT THE ENGINE'S GENERAL ENCODING. A name comes back only
 * for an absolute path of non-empty segments whose characters are `[A-Za-z0-9-]`
 * or keys of the entry's `substitute`, no longer than the build's longest vector
 * (see `VALIDATED_SESSION_BUILDS`), and whose result is one safe path segment.
 * Anything else, a dot or an underscore included, is null: it is not worked out
 * by analogy.
 */
export function encodeProjectDir(cwd: string, entry: SessionRule): string | null {
  if (typeof cwd !== "string" || cwd.length < 2 || !cwd.startsWith("/") || cwd.endsWith("/") || cwd.includes("//")) return null;
  if (typeof entry.substitute["/"] !== "string") return null;
  let out = "";
  for (const ch of cwd) {
    const swapped = entry.substitute[ch];
    if (typeof swapped === "string") out += swapped;
    else if (BASE_CHARACTER.test(ch)) out += ch;
    else return null;
  }
  if (out.length > testedLength(entry) || out.includes("/") || pathProblem(out) !== null) return null;
  return out;
}

/** A table is only loaded if its own vectors reproduce under its own rule, and every pair is between two builds it has. */
function assertTables(tables: SessionTables): void {
  for (const [key, entry] of Object.entries(tables.builds)) {
    if (key !== `${entry.os}:${entry.version}` || entry.rule === "" || entry.vectors.length === 0) throw new Error(`session-table-invalid: ${key}`);
    for (const [from, to] of Object.entries(entry.substitute)) {
      if (from.length !== 1 || to === "" || to.includes("/")) throw new Error(`session-table-invalid: ${key} substitute`);
    }
    for (const vector of entry.vectors) {
      if (encodeProjectDir(vector.cwd, entry) !== vector.project_dir) throw new Error(`session-table-invalid: ${key} vector ${vector.evidence}`);
    }
  }
  for (const key of Object.keys(tables.pairs)) {
    const ends = key.split(">");
    if (ends.length !== 2 || !ends.every(end => Object.hasOwn(tables.builds, end))) throw new Error(`session-pair-invalid: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// the manifest

/** The text a manifest's digest is taken over. Every object is built key by key, so its order never depends on how it was made. */
export function canonicalNativeManifest(manifest: NativeManifest): string {
  return JSON.stringify({
    version: manifest.version,
    adapter: manifest.adapter,
    native_session: manifest.native_session,
    rule: manifest.rule,
    from: { version: manifest.from.version, os: manifest.from.os, cwd: manifest.from.cwd, project_dir: manifest.from.project_dir },
    files: manifest.files.map(one => ({ path: one.path, sha256: one.sha256, size: one.size, mode: one.mode })),
  });
}

export function nativeManifestDigest(manifest: NativeManifest): string {
  return sha256Hex(Buffer.from(canonicalNativeManifest(manifest)));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const transcriptPath = (projectDir: string, session: string): string => `${PROJECTS}/${projectDir}/${session}.jsonl`;

/** A manifest from untrusted data, rebuilt key by key, or `native_export_mismatch`. The digest is checked by the caller. */
function parseNativeManifest(data: unknown): NativeManifest {
  const mismatch = () => new NativeRefusal("native_export_mismatch");
  if (!isRecord(data) || !exactKeys(data, ["version", "adapter", "native_session", "rule", "from", "files"]) || data.version !== 1 || data.adapter !== ADAPTER ||
      typeof data.native_session !== "string" || !UUID.test(data.native_session) || typeof data.rule !== "string" || data.rule === "" ||
      !isRecord(data.from) || !Array.isArray(data.files) || data.files.length !== 1) throw mismatch();
  const from = data.from;
  if (!exactKeys(from, ["version", "os", "cwd", "project_dir"]) || typeof from.version !== "string" || from.version === "" ||
      (from.os !== "darwin" && from.os !== "linux") || typeof from.cwd !== "string" || !isAbsolute(from.cwd) || from.cwd.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(from.cwd) || typeof from.project_dir !== "string" || pathProblem(from.project_dir) !== null || from.project_dir.includes("/")) throw mismatch();
  const file = data.files[0];
  const path = transcriptPath(from.project_dir, data.native_session);
  if (!isRecord(file) || !exactKeys(file, ["path", "sha256", "size", "mode"]) || file.path !== path ||
      typeof file.sha256 !== "string" || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || (file.size as number) < 0 ||
      !Number.isInteger(file.mode) || (file.mode as number) < 0 || (file.mode as number) > 0o777) throw mismatch();
  return {
    version: 1, adapter: ADAPTER, native_session: data.native_session, rule: data.rule,
    from: { version: from.version, os: from.os, cwd: from.cwd, project_dir: from.project_dir },
    files: [{ path, sha256: file.sha256, size: file.size as number, mode: file.mode as number }],
  };
}

// ---------------------------------------------------------------------------
// the destination

/** `path` with its deepest existing ancestor resolved and the rest appended as written (a name that does not exist cannot be a link). Creates nothing. */
function resolveFuture(path: string): string {
  const tail: string[] = [];
  for (let at = path;;) {
    try { return join(realpathSync(at), ...tail.reverse()); } catch (error) {
      const up = dirname(at);
      if (errnoOf(error) !== "ENOENT" || up === at) throw new TransferError("destination-invalid");
      tail.push(basename(at));
      at = up;
    }
  }
}

/**
 * Whether `dir` looks like a COMPLETE stage this same operation made of this same bundle, in a directory the stage
 * itself created: the one case that is a crash retry and not a collision. It reads the marker under a small bound and
 * decides nothing alone: `stageBundle` reads the marker again under the plan's own bounds, verifies every byte and the
 * identity of everything the marker lists, and refuses what does not hold. An unfinished stage, an empty directory,
 * a stage of another operation or bundle, and a stage the library did not create the root of are all false here.
 */
function completeStageOf(dir: string, at: Stats, digest: string, operation: string): boolean {
  if (at.isSymbolicLink() || !at.isDirectory()) return false;
  let text: string;
  try {
    const path = join(dir, STAGE_MARKER);
    const seen = lstatSync(path);
    if (!seen.isFile() || seen.size > MARKER_READ_BYTES) return false;
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== seen.ino || opened.dev !== seen.dev || opened.size > MARKER_READ_BYTES) return false;
      const buffer = Buffer.allocUnsafe(opened.size);
      let done = 0;
      while (done < opened.size) {
        const got = readSync(fd, buffer, done, opened.size - done, done);
        if (got === 0) break;
        done += got;
      }
      text = buffer.subarray(0, done).toString("utf8");
    } finally { closeSync(fd); }
  } catch { return false; }
  let data: unknown;
  try { data = JSON.parse(text); } catch { return false; }
  return isRecord(data) && data.version === 1 && data.state === "complete" && data.operation === operation && data.manifest === digest &&
    data.createdRoot === true && isRecord(data.root) && data.root.dev === at.dev && data.root.ino === at.ino;
}

/**
 * Where `to` places a session at `sessionDir`: the realpath the engine would run in and the folder it is known to make for it. The one
 * rule both `destination` (a preflight that writes nothing) and `importSession` apply, so they cannot disagree. Creates nothing.
 */
function placeAt(sessionDir: string, to: SessionRule): { cwd: string; projectDir: string } {
  if (!isAbsolute(sessionDir) || resolve(sessionDir) !== sessionDir) throw new TransferError("destination-invalid");
  const cwd = resolveFuture(sessionDir);
  const projectDir = encodeProjectDir(cwd, to);
  if (projectDir === null) throw new NativeRefusal("native_locator_unsupported_path");
  return { cwd, projectDir };
}

/** Undo what THIS call just staged (never a reused stage) and refuse. A discard that cannot finish is its own named refusal and wins. */
function refuseStaged(staged: StageResult, code: "native_dest_session_collision" | "native_locator_unsupported_path"): never {
  if (!staged.reused) discardStaged({ receipt: staged.receipt });
  throw new NativeRefusal(code);
}

// ---------------------------------------------------------------------------
// after a resumed turn

/**
 * The sha256 of the first `size` bytes of the file at `rel`, reached through no link, or null when it is gone, not a
 * regular file, or not STRICTLY longer than `size`: a file of exactly `size` bytes has not grown, and the size is
 * judged on the opened file (`fstat`) as well as on the path.
 */
function prefixHash(root: string, rel: string, size: number): string | null {
  try {
    const stat = lstatBelow(root, rel);
    if (!stat.isFile() || stat.size <= size) return null;
    const fd = openSync(join(root, rel), constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size <= size) return null;
      const sha = createHash("sha256");
      const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, size)));
      for (let read = 0; read < size;) {
        const got = readSync(fd, chunk, 0, Math.min(chunk.length, size - read), read);
        if (got === 0) return null;
        sha.update(chunk.subarray(0, got));
        read += got;
      }
      return sha.digest("hex");
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** Every `.jsonl` under `rel`, by relative path, without following a link. A link, a special file or more than `cap` entries is `native_resume_unverified`. */
function jsonlUnder(root: string, rel: string, cap: number): string[] {
  const found: string[] = [];
  let count = 0;
  const walk = (at: string) => {
    let names: string[];
    try { names = readdirSync(join(root, at)); } catch (error) {
      if (errnoOf(error) === "ENOENT" && at === rel) return;
      throw new NativeRefusal("native_resume_unverified", at);
    }
    for (const name of names.sort()) {
      const child = `${at}/${name}`;
      if (++count > cap) throw new NativeRefusal("native_resume_unverified", at);
      let stat: Stats;
      try { stat = lstatSync(join(root, child)); } catch { throw new NativeRefusal("native_resume_unverified", child); }
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) { if (name.toLowerCase().endsWith(".jsonl")) found.push(child); }
      else throw new NativeRefusal("native_resume_unverified", child);
    }
  };
  walk(rel);
  return found;
}

// ---------------------------------------------------------------------------
// the port

/**
 * Called as the port touches the disk. Production passes nothing; a test passes
 * recorders, so that what was and was not opened is observed and not inferred.
 * `listed` hears of every engine-directory entry the export looked at (a
 * `lstat`, never an open); `read` hears of every file the capture opened for its
 * bytes. They see what this port and the transfer library's capture do, and do not
 * intercept the process's system calls. `beforeStage` is called once the destination
 * has been checked and before the stage runs, which is the one place a directory can
 * appear that the check did not see: a test makes it appear there on purpose.
 */
export interface SessionObserve {
  listed?: (rel: string) => void;
  read?: (rel: string) => void;
  beforeStage?: (sessionDir: string) => void;
}

export function makeClaudeSessionPort(
  tables: SessionTables = DEFAULT_TABLES,
  host: { os: NodeJS.Platform } = { os: process.platform },
  observe: SessionObserve = {},
): NativeSessionPort {
  assertTables(tables);

  const buildOf = (os: string, version: string): SessionRule => {
    const key = `${os}:${version}`;
    if (typeof version !== "string" || !Object.hasOwn(tables.builds, key)) throw new NativeRefusal("native_build_unvalidated");
    return tables.builds[key];
  };

  /** What a directory entry is, from an `lstat` and nothing more. */
  const kindOf = (abs: string, rel: string): "file" | "dir" | "other" | "missing" => {
    let stat: Stats;
    try { stat = lstatSync(abs); } catch (error) {
      if (errnoOf(error) === "ENOENT") return "missing";
      throw new TransferError("unreadable", rel);
    }
    return stat.isSymbolicLink() ? "other" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
  };
  const names = (abs: string, rel: string): string[] => {
    try { return readdirSync(abs).sort(); } catch { throw new TransferError("unreadable", rel); }
  };
  const unsupported = (rel: string) => new NativeRefusal("native_side_state_unsupported", rel);

  return {
    /** Pure: `placeAt` for this host's build. It touches no entry of the disk beyond resolving the existing ancestors of `sessionDir`. */
    destination({ sessionDir, version }) {
      const to = buildOf(host.os, version);
      const { cwd, projectDir } = placeAt(sessionDir, to);
      return { version: to.version, os: to.os, cwd, project_dir: projectDir } satisfies NativeSide;
    },

    /** Pure: the table's own pair entry, named by the two builds. A pair nobody moved between (one host's two builds included) is not guessed at. */
    portability({ from, to }) {
      const source = buildOf(from.os, from.version);
      const target = buildOf(to.os, to.version);
      const key = `${source.os}:${source.version}>${target.os}:${target.version}`;
      if (!Object.hasOwn(tables.pairs, key)) throw new NativeRefusal("native_pair_unvalidated");
      return { adapter: ADAPTER, from: `${source.os}:${source.version}`, to: `${target.os}:${target.version}`, evidence: tables.pairs[key].evidence };
    },

    /**
     * Reads only `config/`, and in it only the transcript. Every other entry of the engine directory is classified by
     * `lstat` alone: `.claude.json`, `.credentials.json`, `backups/` and `sessions/` are measured as not needed and are
     * never opened (a login is split out of the session by the launch, and is not this port's to read); anything else
     * (`file-history/`, `todos/`, a `<uuid>/` side directory, a second transcript) is state nobody measured a move
     * without, and is `native_side_state_unsupported`, naming it. That is the cheapest next measurement, and the refusal
     * that stands until it is made. `home/`, `tmp/` and the session root's files are never listed or read.
     */
    exportSession({ sessionDir, nativeSession, version, limits }) {
      if (typeof nativeSession !== "string" || !UUID.test(nativeSession)) throw new NativeRefusal("native_session_invalid");
      const entry = buildOf(host.os, version);
      if (typeof sessionDir !== "string" || !isAbsolute(sessionDir)) throw new TransferError("root-invalid");
      let root: string;
      try { root = realpathSync(sessionDir); } catch { throw new TransferError("root-invalid"); }

      const config = join(root, "config");
      const configKind = kindOf(config, "config");
      if (configKind === "missing") throw new NativeRefusal("native_transcript_missing", "config");
      if (configKind !== "dir") throw unsupported("config");
      let hasProjects = false;
      for (const name of names(config, "config")) {
        const rel = `config/${name}`;
        observe.listed?.(rel);
        const kind = kindOf(join(config, name), rel);
        if (name === "projects") {
          if (kind !== "dir") throw unsupported(rel);
          hasProjects = true;
        } else if (NOT_CARRIED.get(name) !== kind) throw unsupported(rel);
      }
      if (!hasProjects) throw new NativeRefusal("native_transcript_missing", PROJECTS);

      const projects = names(join(config, "projects"), PROJECTS);
      for (const name of projects) {
        observe.listed?.(`${PROJECTS}/${name}`);
        if (kindOf(join(config, "projects", name), `${PROJECTS}/${name}`) !== "dir") throw unsupported(`${PROJECTS}/${name}`);
      }
      if (projects.length === 0) throw new NativeRefusal("native_transcript_missing", PROJECTS);
      if (projects.length > 1) throw new NativeRefusal("native_locator_ambiguous", PROJECTS);
      const projectDir = projects[0];
      const dirRel = `${PROJECTS}/${projectDir}`;
      const transcript = `${nativeSession}.jsonl`;
      const inside = names(join(config, "projects", projectDir), dirRel);
      if (!inside.includes(transcript)) throw new NativeRefusal("native_transcript_missing", dirRel);
      for (const name of inside) {
        observe.listed?.(`${dirRel}/${name}`);
        if (name !== transcript || kindOf(join(config, "projects", projectDir, name), `${dirRel}/${name}`) !== "file") throw unsupported(`${dirRel}/${name}`);
      }

      // A free vector on every export: where the source's engine put its folder against where this build's rule says it would.
      // A source outside the subset still exports, because its folder is observed here, not worked out.
      const expected = encodeProjectDir(root, entry);
      if (expected !== null && expected !== projectDir) throw new NativeRefusal("native_locator_rule_mismatch", dirRel);

      const rel = transcriptPath(projectDir, nativeSession);
      const captured = captureWorkspace({
        root, paths: [rel], class: "native", limits, observe: { afterRead: read => observe.read?.(read) },
      });
      const carried = captured.bundle.manifest.entries.length === 1 ? captured.bundle.manifest.entries[0] : undefined;
      if (carried === undefined || carried.kind !== "file" || carried.path !== rel) throw new NativeRefusal("native_export_mismatch", rel);
      const manifest: NativeManifest = {
        version: 1, adapter: ADAPTER, native_session: nativeSession, rule: entry.rule,
        from: { version: entry.version, os: entry.os, cwd: root, project_dir: projectDir },
        files: [{ path: rel, sha256: carried.sha256, size: carried.size, mode: carried.mode }],
      };
      return { manifest, digest: nativeManifestDigest(manifest), bundle: captured.bundle } satisfies NativeExport;
    },

    /**
     * Stages the transcript at the destination's own folder name, directly at `sessionDir`. It refuses before writing
     * anything: a manifest or bundle that is not the one exported, a build or pair that was not measured, a
     * destination path outside the subset, and any `sessionDir` that already exists, EXCEPT a complete stage of this
     * same operation and bundle that the library created the root of (a retry after a crash), which is verified and
     * reused without a write. An empty directory, an unfinished stage and any foreign directory are collisions and are
     * left exactly as they are: this port never adopts a directory it did not make.
     *
     * The check and the stage are not one atomic step. If a directory appears in between and the stage lands in an
     * empty one (its receipt says it did not create the root), what this call made is removed by receipt and the
     * import is refused; the directory itself and anything of someone else's in it stay.
     *
     * The caller compares `digest` with its own, authoritative record of the export: the check here only shows that
     * the manifest is the one `digest` was taken over, and both arrive together. A stage interrupted before its marker
     * says complete has no receipt and is a collision here; recovering it is an integration gate, not done here.
     */
    importSession({ manifest: claimed, digest, bundle, sessionDir, version, operation, limits }) {
      const mismatch = () => new NativeRefusal("native_export_mismatch");
      const manifest = parseNativeManifest(claimed);
      if (typeof digest !== "string" || digest !== nativeManifestDigest(manifest)) throw mismatch();
      try { verifyBundle(bundle, limits); } catch (error) {
        if (error instanceof TransferError && (error.code === "limits-invalid" || error.code.startsWith("limit-"))) throw error;
        throw mismatch();
      }
      const file = manifest.files[0];
      const held = bundle.manifest.entries.length === 1 ? bundle.manifest.entries[0] : undefined;
      const bytes = bundle.contents.get(contentKey("native", file.path));
      if (bundle.manifest.base !== null || held === undefined || held.kind !== "file" || held.class !== "native" || held.path !== file.path ||
          held.sha256 !== file.sha256 || held.size !== file.size || held.mode !== file.mode || bytes === undefined) throw mismatch();

      const to = buildOf(host.os, version);
      const source = buildOf(manifest.from.os, manifest.from.version);
      if (!Object.hasOwn(tables.pairs, `${source.os}:${source.version}>${to.os}:${to.version}`)) throw new NativeRefusal("native_pair_unvalidated");
      if (manifest.rule !== source.rule) throw new NativeRefusal("native_locator_rule_mismatch");
      const sourceExpected = encodeProjectDir(manifest.from.cwd, source);
      if (sourceExpected !== null && sourceExpected !== manifest.from.project_dir) throw new NativeRefusal("native_locator_rule_mismatch");

      const { cwd, projectDir } = placeAt(sessionDir, to);
      const mappedPath = transcriptPath(projectDir, manifest.native_session);
      const mapped = buildBundle([{ path: mappedPath, class: "native", mode: file.mode, bytes }], limits);

      let at: Stats | null = null;
      try { at = lstatSync(sessionDir); } catch (error) {
        if (errnoOf(error) !== "ENOENT") throw new NativeRefusal("native_dest_session_collision");
      }
      if (at !== null && !completeStageOf(sessionDir, at, mapped.manifest.digest, operation)) throw new NativeRefusal("native_dest_session_collision");
      if (at === null) {
        try { mkdirSync(dirname(sessionDir), { recursive: true, mode: 0o700 }); } catch { throw new TransferError("destination-invalid"); }
      }

      observe.beforeStage?.(sessionDir);
      let staged: StageResult;
      try { staged = stageBundle({ bundle: mapped, destination: sessionDir, classes: ["native"], operation, limits }); } catch (error) {
        if (error instanceof TransferError && (error.code === "destination-exists" || error.code === "destination-foreign")) throw new NativeRefusal("native_dest_session_collision");
        throw error;
      }
      // An empty directory that appeared after the check was staged into, not created: not ours to keep a session in.
      if (!staged.receipt.createdRoot) refuseStaged(staged, "native_dest_session_collision");
      let real: string | null = null;
      try { real = realpathSync(sessionDir); } catch { /* compared below */ }
      if (real !== cwd) refuseStaged(staged, "native_locator_unsupported_path");

      const side: NativeSide = { version: to.version, os: to.os, cwd, project_dir: projectDir };
      const transcript: NativeFile = { path: mappedPath, sha256: file.sha256, size: file.size, mode: file.mode };
      return { native_manifest_digest: digest, to: side, bundle_digest: mapped.manifest.digest, transcript, receipt: staged.receipt, reused: staged.reused } satisfies NativeImport;
    },

    /**
     * Removes what the library's receipt says one stage made, and only that. A MARKER IN A FILE CANNOT SAY WHETHER A
     * SESSION HAS LAUNCHED. Before it removes anything the library checks that each file the stage recorded is still the
     * object it made (so a transcript a resume appended to stops the discard, and nothing is removed) and that each
     * recorded directory is still the same directory (device and inode only). It does NOT notice a directory or the
     * root that has gained entries: with the transcript unchanged, it removes the transcript and the then-empty
     * directories, and the marker too if every object the stage recorded was removed, and only then refuses with `stage-ambiguous`
     * naming what is left. That refusal can therefore follow a partial removal that leaves no marker and no record of
     * what was removed, and a second discard of the same receipt is `stage-stale`. A session that launched but has not
     * yet written to its transcript is such a case: the launch's own directories sit beside the stage's, and the
     * imported transcript is lost. An unchanged tree is not evidence that nothing ran.
     *
     * So the guarantee is the caller's, and it is mandatory: it serialises this with every other use of the
     * conversation, and has proved there was no activation and no live child at the destination before it asks. Nothing
     * here checks either, and adding a directory beside the stage's does not make a discard safe or all-or-nothing.
     */
    discardImport(receipt) {
      discardStaged({ receipt });
    },

    /**
     * Run after the first real resumed turn; it starts nothing. It is a conservative verification of the one layout that
     * was measured, in which a resume left the imported transcript as the first bytes of a LONGER resumed one (the
     * measured resume appended) and wrote no other transcript. A transcript that is exactly as long as the imported one
     * shows no recorded turn, so it is refused, straight after the import included. It is NOT a proof that long,
     * compacted or rewritten sessions behave that way, and a session the
     * engine legitimately compacts will be refused: `native_resume_unverified` is a named refusal, not a verdict that
     * the session is broken. It changes nothing, retries nothing and starts no fresh session in its place; what the
     * caller does with its input and its hold while it stands is the caller's.
     *
     * Checked: the id the engine reported is the conversation's; the session directory is still the realpath the import
     * mapped for; the transcript at the mapped path is strictly longer than the imported one and starts with the
     * imported bytes (the first `size` bytes hash to the imported sha256, reached through no link, so growth is
     * required and a rewrite, a truncation or no change at all is not enough); and no other
     * `.jsonl` exists anywhere under `config/projects/`. Logs under `home/` are not looked at.
     */
    checkResumed({ sessionDir, imported, nativeSession, reportedSessionId, limits }) {
      const unverified = (path?: string) => new NativeRefusal("native_resume_unverified", path);
      if (typeof nativeSession !== "string" || !UUID.test(nativeSession) || reportedSessionId !== nativeSession) throw unverified();
      const rel = imported.transcript.path;
      const { size, sha256 } = imported.transcript;
      if (rel !== transcriptPath(imported.to.project_dir, nativeSession) || !Number.isSafeInteger(size) || size < 0 || !SHA256.test(sha256)) throw unverified(rel);
      let root: string;
      try { root = realpathSync(sessionDir); } catch { throw unverified(); }
      if (root !== imported.to.cwd) throw unverified();
      if (prefixHash(root, rel, size) !== sha256) throw unverified(rel);
      for (const found of jsonlUnder(root, PROJECTS, limits.maxFiles)) if (found !== rel) throw unverified(found);
    },
  };
}

/** The port for this host and the measured tables. */
export const claudeSession: NativeSessionPort = makeClaudeSessionPort();
