// Files half of the native-session portability MEASUREMENT harness (see claude-session-portability.ts and .md).
//
// Everything here works on directories the harness itself created under one scratch run directory, plus the
// export directory root copies between hosts. It never walks a login directory, an ambient config directory or a
// home, and it never parses a transcript: a transcript is a file whose NAME is the session id, found in an
// inventory, and its bytes are carried verbatim.
//
// Reused from the accepted transfer library (not re-implemented): captureWorkspace (stable, symlink-refusing,
// bounded reads of exactly the named files), buildBundle / parseManifest / verifyBundle (digest-bound manifest),
// stageBundle (exclusive-create staging with a marker) and credentialShaped.
//
// Importing this module has no side effects.

import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import {
  buildBundle, comparePaths, contentKey, exactKeys, parseManifest, pathProblem, sha256Hex, STAGE_MARKER, TransferError, verifyBundle,
  type Bundle, type BundleLimits,
} from "../src/transfer/bundle.ts";
import { captureWorkspace, credentialShaped, lstatBelow, readStable, stageBundle, type ScanBudget, type StageReceipt } from "../src/transfer/workspace.ts";

/** One named, exactly-scoped refusal. Its message is its code; `path` is a path RELATIVE to a harness-owned tree. */
export class Refusal extends Error {
  readonly code: string;
  readonly path: string | undefined;
  constructor(code: string, path?: string) {
    super(code);
    this.name = "Refusal";
    this.code = code;
    this.path = path;
  }
}

/** The text a report may carry for a failure: codes and relative paths, never contents, never an absolute path. */
export function describe(error: unknown): string {
  if (error instanceof Refusal) return error.path === undefined ? error.code : `${error.code} (${error.path})`;
  if (error instanceof TransferError) return error.path === undefined ? `transfer:${error.code}` : `transfer:${error.code} (${error.path})`;
  return `unexpected:${error instanceof Error ? error.name : typeof error}`;
}

/** Run a transfer-library call and turn its refusal into this harness's. */
function guard<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof TransferError) throw new Refusal(`transfer:${error.code}`, error.path);
    throw error;
  }
}

/** The bounds of ONE move: 16 MiB per file and 64 MiB in all, the accepted store's own. */
export const LIMITS: BundleLimits = { maxFiles: 64, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
const INVENTORY = { maxEntries: 5000, maxFileBytes: 16 * 1024 * 1024, maxScanBytes: 128 * 1024 * 1024 };

export const SHA256 = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RUN_ID = /^(source|dest)-\d{8}-\d{6}-[0-9a-f]{8}$/;
export const NONCE = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------------------------------------
// Exclusive writes, bounded reads, redaction

export function writeExclusive(path: string, data: string | Uint8Array, mode = 0o600): void {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at);
  } finally { closeSync(fd); }
}

const errnoOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

function lstatOrRefuse(path: string, what: string): Stats {
  try { return lstatSync(path); } catch (error) {
    throw new Refusal(errnoOf(error) === "ENOENT" ? `${what}_missing` : `${what}_unreadable`);
  }
}

/** A JSON file that is a regular file (never a link) within `maxBytes`. */
export function readJson(path: string, maxBytes = 1024 * 1024): unknown {
  const what = basename(path).replace(/[^A-Za-z0-9._-]/g, "_");
  const stat = lstatOrRefuse(path, what);
  if (!stat.isFile()) throw new Refusal(`${what}_not_regular`);
  if (stat.size > maxBytes) throw new Refusal(`${what}_too_large`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Refusal(`${what}_malformed`); }
}

export function fileSha256(path: string, maxBytes = 1024 * 1024): string {
  const what = basename(path).replace(/[^A-Za-z0-9._-]/g, "_");
  const stat = lstatOrRefuse(path, what);
  if (!stat.isFile() || stat.size > maxBytes) throw new Refusal(`${what}_not_regular_or_too_large`);
  return sha256Hex(readFileSync(path));
}

/** Writes `value` as JSON through the redactor, exclusively, and returns the sha256 of the bytes written. */
export function persistJson(path: string, value: unknown, redactor?: Redactor): string {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  const text = redactor ? redactor.scrub(raw) : raw;
  writeExclusive(path, text);
  return createHash("sha256").update(text).digest("hex");
}

/** Replaces the strings that must never reach an artifact (the login path and its directory). */
export interface Redactor { scrub(text: string): string; leaks(text: string): boolean }
export function makeRedactor(hide: string[]): Redactor {
  const needles = [...new Set(hide.filter(one => one.length >= 4))].sort((a, b) => b.length - a.length);
  return {
    scrub: text => needles.reduce((out, needle) => out.split(needle).join("<login>"), text),
    leaks: text => needles.some(needle => text.includes(needle)),
  };
}

/** Which labelled texts contain one of the secrets. Labels only; the secret is never returned. */
export function scanForLeaks(parts: { label: string; text: string }[], secrets: string[]): string[] {
  const needles = secrets.filter(one => one.length >= 4);
  return parts.filter(part => needles.some(needle => part.text.includes(needle))).map(part => part.label);
}

// ---------------------------------------------------------------------------------------------------------
// Inventory of ONE owned session tree: paths, sizes, modes, sha256. Nothing else about a file is read out.

export interface InventoryEntry {
  path: string;
  kind: "file" | "dir";
  size: number | null;
  mode: number;
  sha256: string | null;
  /** The entry's name is credential-shaped: listed, and its bytes were not read. */
  withheld?: "credential-shaped";
}
export interface Inventory { entries: InventoryEntry[]; files: number; dirs: number; bytes: number }

const CREDENTIAL_WORDS = /credential|secret|token|oauth|keychain|login|passw|api[-_]?key|\.(pem|key|p12|pfx)$/i;
const ACCOUNT_NAMES: RegExp[] = [/^\.claude\.json/i, /setting/i, /^backups$/i, /account/i];
const GENERATED_ROOT_FILES = new Set(["box.sb", "mcp.json", "instructions.md", STAGE_MARKER]);

const withheldName = (name: string, directory: boolean) => credentialShaped(name, directory) || CREDENTIAL_WORDS.test(name);

function inventoryError(error: unknown, path: string): Refusal {
  if (error instanceof TransferError) return new Refusal(`inventory_${error.code.replace(/-/g, "_")}`, path);
  return new Refusal("inventory_unreadable", path);
}

/**
 * Every entry under `root`, which must be a real directory (never a link). A symlink anywhere, a device or socket,
 * a file over 16 MiB, more than 5000 entries, more than 128 MiB of reads, a path this library cannot carry, and two
 * names that fold to one all REFUSE: an inventory that cannot say what is there says nothing. A credential-shaped
 * name is listed and not read.
 */
export function inventoryTree(root: string): Inventory {
  const top = lstatOrRefuse(root, "inventory_root");
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Refusal("inventory_root_invalid");
  const entries: InventoryEntry[] = [];
  const folded = new Set<string>();
  const scan: ScanBudget = { limit: INVENTORY.maxScanBytes, used: 0 };
  let bytes = 0;
  const walk = (rel: string): void => {
    let names: string[];
    try { names = readdirSync(rel === "" ? root : join(root, rel)); } catch { throw new Refusal("inventory_unreadable", rel === "" ? "." : rel); }
    names.sort(comparePaths);
    for (const name of names) {
      const child = rel === "" ? name : `${rel}/${name}`;
      const key = child.toLowerCase();
      if (folded.has(key)) throw new Refusal("inventory_ambiguous_name", child);
      folded.add(key);
      if (entries.length >= INVENTORY.maxEntries) throw new Refusal("inventory_too_many_entries");
      // The transfer library's own stage marker is a path its helpers refuse by design: it is read here by hand, once, as the
      // regular file it must be. (`.imprnt-transfer.json.tmp`, an unfinished stage, stays refused below.)
      if (rel === "" && name === STAGE_MARKER) {
        const marker = lstatSync(join(root, name));
        if (!marker.isFile() || marker.size > 1024 * 1024) throw new Refusal("inventory_marker_invalid", child);
        entries.push({ path: child, kind: "file", size: marker.size, mode: marker.mode & 0o777, sha256: sha256Hex(readFileSync(join(root, name))) });
        bytes += marker.size;
        continue;
      }
      const problem = pathProblem(child);
      if (problem) throw new Refusal(`inventory_${problem.replace(/-/g, "_")}`, child);
      let stat: Stats;
      try { stat = lstatBelow(root, child); } catch (error) { throw inventoryError(error, child); }
      if (stat.isDirectory()) {
        const entry: InventoryEntry = { path: child, kind: "dir", size: null, mode: stat.mode & 0o777, sha256: null };
        entries.push(entry);
        if (withheldName(name, true)) entry.withheld = "credential-shaped";
        else walk(child);
      } else if (stat.isFile()) {
        if (stat.size > INVENTORY.maxFileBytes) throw new Refusal("inventory_file_too_large", child);
        if (withheldName(name, false)) {
          entries.push({ path: child, kind: "file", size: stat.size, mode: stat.mode & 0o777, sha256: null, withheld: "credential-shaped" });
          bytes += stat.size;
          continue;
        }
        let read: ReturnType<typeof readStable>;
        try { read = readStable(root, child, { retain: false, maxBytes: INVENTORY.maxFileBytes, scan }); } catch (error) { throw inventoryError(error, child); }
        entries.push({ path: child, kind: "file", size: read.size, mode: read.mode, sha256: read.sha256 });
        bytes += read.size;
      } else throw new Refusal("inventory_special_file", child);
    }
  };
  walk("");
  const files = entries.filter(one => one.kind === "file").length;
  return { entries, files, dirs: entries.length - files, bytes };
}

export interface InventoryDiff {
  added: string[];
  removed: string[];
  changed: { path: string; before: { size: number | null; sha256: string | null }; after: { size: number | null; sha256: string | null } }[];
  added_dirs: string[];
  removed_dirs: string[];
}

/** What differs between two inventories of one tree. A DIFF IS A QUESTION FOR A HUMAN, never an ownership claim. */
export function diffInventory(before: Inventory, after: Inventory): InventoryDiff {
  const held = (inv: Inventory, kind: "file" | "dir") => new Map(inv.entries.filter(one => one.kind === kind).map(one => [one.path, one] as const));
  const [bf, af, bd, ad] = [held(before, "file"), held(after, "file"), held(before, "dir"), held(after, "dir")];
  const changed: InventoryDiff["changed"] = [];
  for (const [path, now] of af) {
    const was = bf.get(path);
    if (was && (was.sha256 !== now.sha256 || was.size !== now.size)) {
      changed.push({ path, before: { size: was.size, sha256: was.sha256 }, after: { size: now.size, sha256: now.sha256 } });
    }
  }
  return {
    added: [...af.keys()].filter(path => !bf.has(path)), removed: [...bf.keys()].filter(path => !af.has(path)), changed,
    added_dirs: [...ad.keys()].filter(path => !bd.has(path)), removed_dirs: [...bd.keys()].filter(path => !ad.has(path)),
  };
}

export const isUnchanged = (diff: InventoryDiff) =>
  diff.added.length + diff.removed.length + diff.changed.length + diff.added_dirs.length + diff.removed_dirs.length === 0;

/** Files whose NAME is `<session>.jsonl`, wherever they are. Nothing is opened. */
export function transcriptsNamed(inv: Inventory, session: string): string[] {
  return inv.entries.filter(one => one.kind === "file" && basename(one.path) === `${session}.jsonl`).map(one => one.path);
}

/** `config/projects/<dir>/<session>.jsonl` gives `<dir>`; any other shape gives null, and nothing is guessed. */
export function projectDirOf(transcript: string): string | null {
  const parts = transcript.split("/");
  return parts.length === 4 && parts[0] === "config" && parts[1] === "projects" ? parts[2] : null;
}

export function jsonlFiles(inv: Inventory): { path: string; size: number | null }[] {
  return inv.entries.filter(one => one.kind === "file" && one.path.endsWith(".jsonl")).map(one => ({ path: one.path, size: one.size }));
}

/** The part of an inventory the transcript judgments read: paths and sizes. A saved report carries exactly this for its .jsonl files. */
export interface InventoryView { entries: readonly Pick<InventoryEntry, "path" | "kind" | "size">[] }

/**
 * Whether a `.jsonl` path is shaped like a conversation transcript rather than another log the CLI keeps: it lives under the
 * CLI's `config/projects/` namespace (whatever the project directory or depth), or it is named `<uuid>.jsonl` wherever it is.
 * A timestamp-named MCP server log under `home/.cache/` is neither. Nothing is opened and no project directory is guessed.
 */
export function transcriptShaped(path: string): boolean {
  return path.endsWith(".jsonl") && (path.startsWith("config/projects/") || UUID.test(basename(path).slice(0, -".jsonl".length)));
}

/** Transcript-shaped files present after and absent before: a new conversation, in this project directory or any other. */
export function freshTranscripts(before: InventoryView, after: InventoryView): string[] {
  const was = new Set(before.entries.filter(one => one.kind === "file").map(one => one.path));
  return after.entries.filter(one => one.kind === "file" && !was.has(one.path) && transcriptShaped(one.path)).map(one => one.path);
}

/** Whether the first `size` bytes of a file still hash to `sha256` (an append kept what was there). Read inside an owned tree. */
export function prefixPreserved(root: string, rel: string, size: number, sha256: string): boolean | null {
  try {
    const read = readStable(root, rel, { retain: true, maxBytes: INVENTORY.maxFileBytes });
    if (!read.bytes || read.bytes.length < size) return false;
    return sha256Hex(read.bytes.subarray(0, size)) === sha256;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------
// The fixture's own effect log (outside the session tree)

export interface Effects { count: number; results: string[]; malformed: number }

export function readEffects(fixtureDir: string): Effects {
  const file = join(fixtureDir, "effects.jsonl");
  let stat: Stats;
  try { stat = lstatSync(file); } catch (error) {
    if (errnoOf(error) === "ENOENT") return { count: 0, results: [], malformed: 0 };
    throw new Refusal("effects_log_unreadable");
  }
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Refusal("effects_log_invalid");
  const lines = readFileSync(file, "utf8").split("\n").filter(line => line.trim() !== "");
  const results: string[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const effect = JSON.parse(line) as { tool?: unknown; result?: unknown };
      if (effect.tool === "fixture_effect" && typeof effect.result === "string") results.push(effect.result);
      else malformed++;
    } catch { malformed++; }
  }
  return { count: lines.length, results, malformed };
}

// ---------------------------------------------------------------------------------------------------------
// What may leave a session: exact files, under config/, never a credential, account file or launch-generated path

/** The named reason a path may NOT be exported, or null. A name is a rule of THIS harness, not a claim about the CLI's layout. */
export function exportPathProblem(path: string): string | null {
  const problem = pathProblem(path);
  if (problem) return problem.replace(/-/g, "_");
  const parts = path.split("/");
  if (parts[0] === "home" || parts[0] === "tmp") return "launch_generated";
  if (parts.length === 1 && GENERATED_ROOT_FILES.has(parts[0])) return "launch_generated";
  if (parts[0] !== "config") return "not_under_session_config";
  if (parts.length < 2) return "not_a_file_path";
  for (const part of parts) {
    if (withheldName(part, false) || withheldName(part, true)) return "credential_shaped";
    if (ACCOUNT_NAMES.some(pattern => pattern.test(part))) return "account_config";
  }
  return null;
}

export interface ReviewedFile { path: string; sha256: string; size: number; mode: number; dest_path?: string }
export interface ReviewedManifest {
  version: 1;
  kind: "claude-session-export-manifest";
  run_id: string;
  journal_nonce: string;
  native_session: string;
  files: ReviewedFile[];
  locator: { source_project_dir: string; dest_project_dir: string; calibration_run_id: string; calibration_report_sha256: string };
}

export function rec(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Refusal(`${what}_malformed`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, what: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value === "" || value.length > 1024 || (pattern && !pattern.test(value))) throw new Refusal(`${what}_malformed`);
  return value;
}
function count(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Refusal(`${what}_malformed`);
  return value as number;
}
function segment(value: unknown, what: string): string {
  const one = text(value, what);
  if (one.includes("/") || pathProblem(one) !== null) throw new Refusal(`${what}_malformed`);
  return one;
}

/** The manifest root wrote by hand after inspecting the source evidence, checked key for key. */
export function parseReviewedManifest(data: unknown): ReviewedManifest {
  const top = rec(data, "manifest");
  if (!exactKeys(top, ["version", "kind", "run_id", "journal_nonce", "native_session", "files", "locator"])) throw new Refusal("manifest_keys");
  if (top.version !== 1 || top.kind !== "claude-session-export-manifest") throw new Refusal("manifest_kind");
  if (!Array.isArray(top.files) || top.files.length === 0 || top.files.length > LIMITS.maxFiles) throw new Refusal("manifest_files");
  const seen = new Set<string>();
  const files = top.files.map((item: unknown): ReviewedFile => {
    const one = rec(item, "manifest_file");
    const keys = Object.keys(one).sort().join(",");
    if (keys !== "mode,path,sha256,size" && keys !== "dest_path,mode,path,sha256,size") throw new Refusal("manifest_file_keys");
    const path = text(one.path, "manifest_path");
    const mode = one.mode, size = one.size;
    if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777 || ((mode as number) & 0o400) === 0) throw new Refusal("manifest_mode", path);
    if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > LIMITS.maxFileBytes) throw new Refusal("manifest_size", path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Refusal("manifest_duplicate_path", path);
    seen.add(key);
    const file: ReviewedFile = { path, sha256: text(one.sha256, "manifest_sha256", SHA256), size: size as number, mode: mode as number };
    if (one.dest_path !== undefined) file.dest_path = text(one.dest_path, "manifest_dest_path");
    return file;
  });
  const locator = rec(top.locator, "manifest_locator");
  if (!exactKeys(locator, ["source_project_dir", "dest_project_dir", "calibration_run_id", "calibration_report_sha256"])) throw new Refusal("manifest_locator_keys");
  return {
    version: 1, kind: "claude-session-export-manifest",
    run_id: text(top.run_id, "manifest_run_id", RUN_ID), journal_nonce: text(top.journal_nonce, "manifest_nonce", NONCE),
    native_session: text(top.native_session, "manifest_session", UUID), files,
    locator: {
      source_project_dir: segment(locator.source_project_dir, "manifest_source_project_dir"),
      dest_project_dir: segment(locator.dest_project_dir, "manifest_dest_project_dir"),
      calibration_run_id: text(locator.calibration_run_id, "manifest_calibration_run", RUN_ID),
      calibration_report_sha256: text(locator.calibration_report_sha256, "manifest_calibration_sha", SHA256),
    },
  };
}

export interface Mapped { from: string; to: string; sha256: string; size: number; mode: number }

const PROJECTS = "config/projects/";

/**
 * The reviewed manifest against what the source run measured. Every refusal is by name:
 *  - identity: run, nonce and native session are this source run's own;
 *  - every file is a regular, listed, unwithheld file of the source's after-inventory with that size, mode and sha256;
 *  - no path is credential-shaped, account config, launch-generated, or outside `config/`;
 *  - the one transcript named `<session>.jsonl` is in the manifest;
 *  - the source→destination mapping exists exactly when the measured project directories differ, is a rename of
 *    that one path segment and nothing else, and is spelled out by the reviewer. Nothing is computed or guessed.
 */
export function validateReviewed(manifest: ReviewedManifest, source: { run_id: string; nonce: string; native_session: string; inventory: Inventory },
  calibration: { run_id: string; report_sha256: string; project_dir: string }): Mapped[] {
  if (manifest.run_id !== source.run_id || manifest.journal_nonce !== source.nonce || manifest.native_session !== source.native_session) {
    throw new Refusal("manifest_not_for_this_run");
  }
  const loc = manifest.locator;
  if (loc.calibration_run_id !== calibration.run_id || loc.calibration_report_sha256 !== calibration.report_sha256) throw new Refusal("locator_calibration_not_bound");
  if (loc.dest_project_dir !== calibration.project_dir) throw new Refusal("locator_destination_mismatch");
  const transcripts = transcriptsNamed(source.inventory, source.native_session);
  if (transcripts.length === 0) throw new Refusal("source_transcript_missing");
  if (transcripts.length > 1) throw new Refusal("source_transcript_ambiguous");
  if (projectDirOf(transcripts[0]) !== loc.source_project_dir) throw new Refusal("locator_source_mismatch", transcripts[0]);
  const held = new Map(source.inventory.entries.map(one => [one.path, one] as const));
  const srcPrefix = `${PROJECTS}${loc.source_project_dir}/`;
  const mapped: Mapped[] = [];
  for (const file of manifest.files) {
    const problem = exportPathProblem(file.path);
    if (problem) throw new Refusal(`export_${problem}`, file.path);
    const entry = held.get(file.path);
    if (!entry || entry.kind !== "file") throw new Refusal("export_file_not_in_inventory", file.path);
    if (entry.withheld || entry.sha256 === null) throw new Refusal("export_credential_shaped", file.path);
    if (entry.sha256 !== file.sha256 || entry.size !== file.size || entry.mode !== file.mode) throw new Refusal("export_file_changed", file.path);
    let expected = file.path;
    if (file.path.startsWith(srcPrefix)) expected = `${PROJECTS}${loc.dest_project_dir}/${file.path.slice(srcPrefix.length)}`;
    else if (file.path.startsWith(PROJECTS)) throw new Refusal("project_dir_unexpected", file.path);
    if (expected !== file.path && file.dest_path === undefined) throw new Refusal("locator_mapping_missing", file.path);
    if (file.dest_path !== undefined && file.dest_path !== expected) throw new Refusal("locator_mapping_not_justified", file.path);
    const outProblem = exportPathProblem(expected);
    if (outProblem) throw new Refusal(`export_${outProblem}`, expected);
    mapped.push({ from: file.path, to: expected, sha256: file.sha256, size: file.size, mode: file.mode });
  }
  if (!manifest.files.some(file => file.path === transcripts[0])) throw new Refusal("transcript_not_in_manifest", transcripts[0]);
  if (new Set(mapped.map(one => one.to.toLowerCase())).size !== mapped.length) throw new Refusal("manifest_duplicate_destination");
  return mapped;
}

// ---------------------------------------------------------------------------------------------------------
// Export directory: what root copies from the source host to the destination host. Contents are bytes, verbatim.

export interface ExportEnvelope {
  version: 1;
  kind: "claude-session-export";
  export_id: string;
  source: { run_id: string; journal_nonce: string; native_session: string; os: string; cli_version: string; cwd_realpath: string; report_sha256: string };
  calibration: { run_id: string; report_sha256: string; project_dir: string; cwd_realpath: string };
  reviewed_manifest_sha256: string;
  locator: { source_project_dir: string; dest_project_dir: string; mapped_files: number };
  source_bundle_digest: string;
  bundle_digest: string;
  limits: BundleLimits;
}

function parseEnvelope(data: unknown): ExportEnvelope {
  const top = rec(data, "export_envelope");
  if (!exactKeys(top, ["version", "kind", "export_id", "source", "calibration", "reviewed_manifest_sha256", "locator", "source_bundle_digest", "bundle_digest", "limits"])) {
    throw new Refusal("export_envelope_keys");
  }
  if (top.version !== 1 || top.kind !== "claude-session-export") throw new Refusal("export_envelope_kind");
  const source = rec(top.source, "export_source"), calibration = rec(top.calibration, "export_calibration"), locator = rec(top.locator, "export_locator");
  if (!exactKeys(source, ["run_id", "journal_nonce", "native_session", "os", "cli_version", "cwd_realpath", "report_sha256"]) ||
      !exactKeys(calibration, ["run_id", "report_sha256", "project_dir", "cwd_realpath"]) ||
      !exactKeys(locator, ["source_project_dir", "dest_project_dir", "mapped_files"])) throw new Refusal("export_envelope_keys");
  const limits = rec(top.limits, "export_limits");
  if (limits.maxFiles !== LIMITS.maxFiles || limits.maxFileBytes !== LIMITS.maxFileBytes || limits.maxTotalBytes !== LIMITS.maxTotalBytes) throw new Refusal("export_limits_differ");
  return {
    version: 1, kind: "claude-session-export", export_id: text(top.export_id, "export_id", /^[0-9a-f]{16}$/),
    source: { run_id: text(source.run_id, "export_source_run", RUN_ID), journal_nonce: text(source.journal_nonce, "export_source_nonce", NONCE),
      native_session: text(source.native_session, "export_session", UUID), os: text(source.os, "export_os"), cli_version: text(source.cli_version, "export_version"),
      cwd_realpath: text(source.cwd_realpath, "export_cwd"), report_sha256: text(source.report_sha256, "export_report_sha", SHA256) },
    calibration: { run_id: text(calibration.run_id, "export_calibration_run", RUN_ID), report_sha256: text(calibration.report_sha256, "export_calibration_sha", SHA256),
      project_dir: segment(calibration.project_dir, "export_project_dir"), cwd_realpath: text(calibration.cwd_realpath, "export_calibration_cwd") },
    reviewed_manifest_sha256: text(top.reviewed_manifest_sha256, "export_manifest_sha", SHA256),
    locator: { source_project_dir: segment(locator.source_project_dir, "export_source_project_dir"), dest_project_dir: segment(locator.dest_project_dir, "export_dest_project_dir"),
      mapped_files: count(locator.mapped_files, "export_locator") },
    source_bundle_digest: text(top.source_bundle_digest, "export_source_digest", SHA256), bundle_digest: text(top.bundle_digest, "export_bundle_digest", SHA256),
    limits: LIMITS,
  };
}

/**
 * Capture exactly the reviewed files of the owned source session (stable, link-refusing reads), carry their bytes
 * verbatim under the mapped relative paths, and write an export directory next to the run. Nothing else is read.
 */
export function exportNative(input: {
  sessionDir: string; runDir: string; exportId: string; manifest: ReviewedManifest; manifestSha256: string; mapped: Mapped[];
  source: ExportEnvelope["source"]; calibration: ExportEnvelope["calibration"];
}): { dir: string; envelope: ExportEnvelope; bundle: Bundle } {
  const captured = guard(() => captureWorkspace({ root: input.sessionDir, paths: input.mapped.map(one => one.from), class: "native", limits: LIMITS }));
  if (captured.skipped.length > 0) throw new Refusal("export_path_skipped", captured.skipped[0].path);
  const seen = new Map(captured.bundle.manifest.entries.flatMap(one => (one.kind === "file" ? [[one.path, one] as const] : [])));
  const entries = input.mapped.map(one => {
    const got = seen.get(one.from);
    if (!got || got.sha256 !== one.sha256 || got.size !== one.size || got.mode !== one.mode) throw new Refusal("export_file_changed", one.from);
    const bytes = captured.bundle.contents.get(contentKey("native", one.from));
    if (!bytes) throw new Refusal("export_file_changed", one.from);
    return { path: one.to, class: "native" as const, mode: one.mode, bytes };
  });
  const bundle = guard(() => buildBundle(entries, LIMITS));
  const dir = join(input.runDir, `export-${input.exportId}`);
  try { mkdirSync(dir, { mode: 0o700 }); } catch { throw new Refusal("export_dir_exists"); }
  mkdirSync(join(dir, "blobs"), { mode: 0o700 });
  for (const entry of bundle.manifest.entries) {
    if (entry.kind !== "file") continue;
    const blob = join(dir, "blobs", entry.sha256);
    try { writeExclusive(blob, bundle.contents.get(contentKey("native", entry.path))!); } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error; // two files with the same bytes share one blob
    }
  }
  writeExclusive(join(dir, "manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`);
  const loc = input.manifest.locator;
  const envelope: ExportEnvelope = {
    version: 1, kind: "claude-session-export", export_id: input.exportId, source: input.source, calibration: input.calibration,
    reviewed_manifest_sha256: input.manifestSha256,
    locator: { source_project_dir: loc.source_project_dir, dest_project_dir: loc.dest_project_dir, mapped_files: input.mapped.filter(one => one.from !== one.to).length },
    source_bundle_digest: captured.bundle.manifest.digest, bundle_digest: bundle.manifest.digest, limits: LIMITS,
  };
  writeExclusive(join(dir, "export.json"), `${JSON.stringify(envelope, null, 2)}\n`); // last: its presence is "complete"
  return { dir, envelope, bundle };
}

/** An export directory read back and verified: envelope shape, manifest digest, every blob's size and hash, nothing extra. */
export function readExportDir(dir: string): { envelope: ExportEnvelope; bundle: Bundle } {
  const top = lstatOrRefuse(dir, "export_dir");
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Refusal("export_dir_invalid");
  const envelope = parseEnvelope(readJson(join(dir, "export.json")));
  const manifest = guard(() => parseManifest(readJson(join(dir, "manifest.json"), 4 * 1024 * 1024), LIMITS));
  if (manifest.digest !== envelope.bundle_digest) throw new Refusal("export_digest_mismatch");
  const contents = new Map<string, Uint8Array>();
  const wanted = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.kind !== "file" || entry.class !== "native") throw new Refusal("export_entry_unsupported", entry.path);
    const problem = exportPathProblem(entry.path);
    if (problem) throw new Refusal(`export_${problem}`, entry.path);
    wanted.add(entry.sha256);
    const blob = join(dir, "blobs", entry.sha256);
    const stat = lstatOrRefuse(blob, "export_blob");
    if (!stat.isFile() || stat.size !== entry.size) throw new Refusal("export_blob_size", entry.path);
    contents.set(contentKey("native", entry.path), readFileSync(blob));
  }
  let present: string[];
  try { present = readdirSync(join(dir, "blobs")); } catch { throw new Refusal("export_blobs_unreadable"); }
  if (present.some(name => !wanted.has(name))) throw new Refusal("export_extra_blob");
  const bundle: Bundle = { manifest, contents };
  guard(() => verifyBundle(bundle, LIMITS));
  return { envelope, bundle };
}

export interface ImportExpect {
  source_run_id: string; source_nonce: string; native_session: string;
  calibration_run_id: string; calibration_report_sha256: string; calibration_project_dir: string;
  /** The bundle digest the operator selected (from the reviewed export report): this export directory, not just this source and calibration. */
  bundle_digest: string;
}

/**
 * Import into a destination session directory that does NOT exist. The directory is created by the transfer
 * library's own exclusive mkdir (never a rename over anything), written with exclusive creates only, and read back
 * against both digests. A directory already there, empty or not, is `dest_session_collision` and is not touched.
 */
export function importNative(input: { exportDir: string; sessionDir: string; operation: string; expect: ImportExpect }):
  { envelope: ExportEnvelope; receipt: StageReceipt; files: { path: string; size: number; mode: number; sha256: string }[]; reused: boolean } {
  const { envelope, bundle } = readExportDir(input.exportDir);
  const want = input.expect;
  // The selected export, matched against the envelope AND the independently verified bundle, before anything else is trusted or staged.
  if (!SHA256.test(want.bundle_digest) || envelope.bundle_digest !== want.bundle_digest || bundle.manifest.digest !== want.bundle_digest) {
    throw new Refusal("export_not_the_selected_bundle");
  }
  if (envelope.source.run_id !== want.source_run_id || envelope.source.journal_nonce !== want.source_nonce || envelope.source.native_session !== want.native_session) {
    throw new Refusal("export_not_for_this_run");
  }
  if (envelope.calibration.run_id !== want.calibration_run_id || envelope.calibration.report_sha256 !== want.calibration_report_sha256 ||
      envelope.calibration.project_dir !== want.calibration_project_dir || envelope.locator.dest_project_dir !== want.calibration_project_dir) {
    throw new Refusal("export_not_calibrated_here");
  }
  const transcript = `${PROJECTS}${want.calibration_project_dir}/${want.native_session}.jsonl`;
  const files = bundle.manifest.entries.flatMap(one => (one.kind === "file" ? [{ path: one.path, size: one.size, mode: one.mode, sha256: one.sha256 }] : []));
  if (!files.some(one => one.path === transcript)) throw new Refusal("transcript_not_at_measured_locator", transcript);
  try { lstatSync(input.sessionDir); throw new Refusal("dest_session_collision"); } catch (error) {
    if (error instanceof Refusal) throw error;
    if (errnoOf(error) !== "ENOENT") throw new Refusal("dest_session_unreadable");
  }
  const staged = guard(() => stageBundle({ bundle, destination: input.sessionDir, classes: ["native"], limits: LIMITS, operation: input.operation }));
  return { envelope, receipt: staged.receipt, files, reused: staged.reused };
}

// ---------------------------------------------------------------------------------------------------------
// Run journal: the identity every artifact of one run is bound to. Immutable once written.

export interface HostFacts { platform: string; arch: string; release: string; bun: string; machine: string }
export interface Journal {
  version: 1;
  kind: "claude-session-portability-journal";
  role: "source" | "destination";
  run_id: string;
  nonce: string;
  created_at: string;
  run_dir: string;
  host: HostFacts;
  ids: { person: string; agent: string; conversation: string };
  paths: { tree: string; state_root: string; session_dir: string; fixture_dir: string };
  source: null | { run_id: string; nonce: string; native_session: string; cwd_realpath: string; os: string; machine: string; cli_version: string; handoff_sha256: string };
}

/** The journal of a run directory, only if the directory is exactly where and what the journal says. */
export function readJournal(runDir: string, role: Journal["role"]): Journal {
  const top = lstatOrRefuse(runDir, "run_dir");
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Refusal("run_dir_invalid");
  const data = rec(readJson(join(runDir, "journal.json")), "journal");
  const journal = data as unknown as Journal;
  let real: string;
  try { real = realpathSync(runDir); } catch { throw new Refusal("run_dir_unreadable"); }
  if (journal.version !== 1 || journal.kind !== "claude-session-portability-journal" || journal.role !== role) throw new Refusal("journal_kind");
  if (typeof journal.run_id !== "string" || !RUN_ID.test(journal.run_id) || basename(real) !== journal.run_id || journal.run_dir !== real) throw new Refusal("journal_not_this_directory");
  if (typeof journal.nonce !== "string" || !NONCE.test(journal.nonce)) throw new Refusal("journal_nonce");
  if (typeof journal.paths?.session_dir !== "string" || typeof journal.paths?.fixture_dir !== "string" || typeof journal.ids?.conversation !== "string") throw new Refusal("journal_paths");
  return journal;
}
