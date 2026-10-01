// The files half of the native-session portability MEASUREMENT harness (live/claude-session-portability-files.ts):
// inventory of an owned tree, the reviewed export manifest, the export/import round trip over the accepted transfer
// library, and the refusals that keep credentials, launch files and foreign destinations out. Offline: synthetic trees
// under mkdtemp, no CLI, no network, no process.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "../src/transfer/bundle.ts";
import {
  diffInventory, exportNative, exportPathProblem, importNative, inventoryTree, isUnchanged, makeRedactor, parseReviewedManifest, persistJson, projectDirOf,
  readEffects, readExportDir, readJournal, Refusal, scanForLeaks, transcriptsNamed, validateReviewed, writeExclusive,
  type ExportEnvelope, type Inventory, type ReviewedManifest,
} from "../live/claude-session-portability-files.ts";

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "csp-files-"))); made.push(dir); return dir; };
function put(root: string, rel: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  chmodSync(join(root, rel), mode);
}
const code = (run: () => unknown): string => {
  try { run(); } catch (error) { if (error instanceof Refusal) return error.code; throw error; }
  return "none";
};

const SID = "11111111-1111-4111-8111-111111111111";
const SRC_DIR = "-src-dir", DST_DIR = "-dst-dir";
const TRANSCRIPT = `config/projects/${SRC_DIR}/${SID}.jsonl`;
const SIDE = `config/projects/${SRC_DIR}/side/note.json`;
const RUN = "source-20261001-000000-aaaaaaaa", NONCE = "a".repeat(32), CAL = "dest-20261001-000001-bbbbbbbb", CAL_SHA = "b".repeat(64);

/** A synthetic session tree the way a loop leaves one: a transcript, one side file, and everything that must NOT travel. */
function sourceTree(root: string): void {
  put(root, TRANSCRIPT, "{\"line\":1}\n{\"line\":2}\n", 0o600);
  put(root, SIDE, "{\"side\":true}\n", 0o644);
  put(root, "config/.credentials.json", "POISON-CREDENTIAL", 0o600);
  put(root, "config/.claude.json", "{\"account\":\"someone\"}", 0o600);
  put(root, "config/backups/.claude.json.backup.1", "x");
  put(root, "box.sb", "profile");
  put(root, "mcp.json", "{}");
  put(root, "instructions.md", "instructions");
  put(root, "home/Library/cache.txt", "cache");
  put(root, "tmp/t.txt", "t");
}

function manifestFor(inv: Inventory, over: Partial<ReviewedManifest> = {}): ReviewedManifest {
  const file = (path: string, dest: string) => {
    const e = inv.entries.find(one => one.path === path)!;
    return { path, sha256: e.sha256!, size: e.size!, mode: e.mode, dest_path: dest };
  };
  return {
    version: 1, kind: "claude-session-export-manifest", run_id: RUN, journal_nonce: NONCE, native_session: SID,
    files: [file(TRANSCRIPT, `config/projects/${DST_DIR}/${SID}.jsonl`), file(SIDE, `config/projects/${DST_DIR}/side/note.json`)],
    locator: { source_project_dir: SRC_DIR, dest_project_dir: DST_DIR, calibration_run_id: CAL, calibration_report_sha256: CAL_SHA },
    ...over,
  };
}
const SOURCE = (inventory: Inventory) => ({ run_id: RUN, nonce: NONCE, native_session: SID, inventory });
const CALIBRATION = { run_id: CAL, report_sha256: CAL_SHA, project_dir: DST_DIR };

// ---------------------------------------------------------------------------------------------------------

test("inventory lists path, size, mode and sha256 of an owned tree, reads no credential-shaped file, and diffs without claiming ownership", () => {
  const root = scratch();
  sourceTree(root);
  const inv = inventoryTree(root);
  const transcript = inv.entries.find(one => one.path === TRANSCRIPT)!;
  const bytes = readFileSync(join(root, TRANSCRIPT));
  expect(transcript).toMatchObject({ kind: "file", size: bytes.length, mode: 0o600, sha256: sha256Hex(bytes) });
  const credential = inv.entries.find(one => one.path === "config/.credentials.json")!;
  expect(credential.withheld).toBe("credential-shaped");
  expect(credential.sha256).toBeNull();
  expect(inv.entries.some(one => one.kind === "dir" && one.path === "config/projects")).toBe(true);
  expect(transcriptsNamed(inv, SID)).toEqual([TRANSCRIPT]);
  expect(projectDirOf(TRANSCRIPT)).toBe(SRC_DIR);
  expect(projectDirOf("config/projects/a/b/c.jsonl")).toBeNull(); // a layout nobody measured is not guessed at

  const before = inventoryTree(root);
  expect(isUnchanged(diffInventory(before, inventoryTree(root)))).toBe(true);
  appendFileSync(join(root, TRANSCRIPT), "{\"line\":3}\n");
  put(root, "config/new.txt", "n");
  const diff = diffInventory(before, inventoryTree(root));
  expect(diff.changed.map(one => one.path)).toEqual([TRANSCRIPT]);
  expect(diff.added).toEqual(["config/new.txt"]);
});

test("inventory refuses a symlink, an oversize file, an unportable name and a missing root: an inventory that cannot say what is there says nothing", () => {
  const link = scratch();
  sourceTree(link);
  symlinkSync("/etc/hosts", join(link, "config/escape"));
  expect(code(() => inventoryTree(link))).toBe("inventory_symlink");

  const big = scratch();
  put(big, "config/big.bin", "");
  truncateSync(join(big, "config/big.bin"), 16 * 1024 * 1024 + 1);
  expect(code(() => inventoryTree(big))).toBe("inventory_file_too_large");

  const odd = scratch();
  put(odd, "config/a\nb", "x");
  expect(code(() => inventoryTree(odd))).toBe("inventory_path_invalid");

  expect(code(() => inventoryTree(join(scratch(), "missing")))).toBe("inventory_root_missing");
  const rootLink = scratch();
  symlinkSync(link, join(rootLink, "l"));
  expect(code(() => inventoryTree(join(rootLink, "l")))).toBe("inventory_root_invalid");
});

test("what may be exported is decided by named rules: only files under config/, never a credential, account file, launch-generated or escaping path", () => {
  const table: [string, string | null][] = [
    [TRANSCRIPT, null],
    ["config/.credentials.json", "credential_shaped"], ["config/.env", "credential_shaped"], ["config/id_rsa", "credential_shaped"],
    ["config/x/oauth-state.json", "credential_shaped"], ["config/projects/-a/auth.json", "credential_shaped"],
    ["config/.claude.json", "account_config"], ["config/settings.json", "account_config"], ["config/backups/x", "account_config"],
    ["home/Library/cache.txt", "launch_generated"], ["tmp/t.txt", "launch_generated"],
    ["box.sb", "launch_generated"], ["mcp.json", "launch_generated"], ["instructions.md", "launch_generated"],
    ["other/x", "not_under_session_config"], ["config", "not_a_file_path"],
    ["../x", "path_traversal"], ["/abs", "path_absolute"], [".imprnt-transfer.json", "path_reserved"], ["config//x", "path_invalid"],
  ];
  for (const [path, want] of table) expect([path, exportPathProblem(path)]).toEqual([path, want]);
});

test("the reviewed manifest is checked key for key: unknown keys, bad digests, bad modes, duplicates and unbounded lists refuse", () => {
  const root = scratch();
  sourceTree(root);
  const good = manifestFor(inventoryTree(root));
  expect(parseReviewedManifest(JSON.parse(JSON.stringify(good))).files.length).toBe(2);
  const edit = (change: (m: any) => void) => { const copy = JSON.parse(JSON.stringify(good)); change(copy); return () => parseReviewedManifest(copy); };
  expect(code(edit(m => { m.extra = 1; }))).toBe("manifest_keys");
  expect(code(edit(m => { m.kind = "other"; }))).toBe("manifest_kind");
  expect(code(edit(m => { m.files[0].sha256 = "zz"; }))).toBe("manifest_sha256_malformed");
  expect(code(edit(m => { m.files[0].mode = 0o200; }))).toBe("manifest_mode");
  expect(code(edit(m => { m.files[1].path = m.files[0].path.toUpperCase(); }))).toBe("manifest_duplicate_path");
  expect(code(edit(m => { m.files[0].extra = 1; }))).toBe("manifest_file_keys");
  expect(code(edit(m => { m.files = []; }))).toBe("manifest_files");
  expect(code(edit(m => { m.files = Array.from({ length: 65 }, (_, n) => ({ ...m.files[0], path: `config/f${n}` })); }))).toBe("manifest_files");
  expect(code(edit(m => { m.locator.dest_project_dir = "a/b"; }))).toBe("manifest_dest_project_dir_malformed");
  expect(code(edit(m => { m.run_id = "not-a-run"; }))).toBe("manifest_run_id_malformed");
});

test("validation binds the manifest to the source run, its measured inventory and the destination calibration, and maps a project directory only when it was measured to differ", () => {
  const root = scratch();
  sourceTree(root);
  put(root, "config/projects/-other/x.json", "{}");
  const inv = inventoryTree(root);
  const good = manifestFor(inv);
  const mapped = validateReviewed(good, SOURCE(inv), CALIBRATION);
  expect(mapped.map(one => [one.from, one.to])).toEqual([
    [TRANSCRIPT, `config/projects/${DST_DIR}/${SID}.jsonl`], [SIDE, `config/projects/${DST_DIR}/side/note.json`],
  ]);
  const run = (m: ReviewedManifest, source = SOURCE(inv), cal = CALIBRATION) => () => validateReviewed(m, source, cal);
  const files = (change: (list: any[]) => void) => { const copy = JSON.parse(JSON.stringify(good)); change(copy.files); return copy as ReviewedManifest; };
  const entry = (path: string) => { const e = inv.entries.find(one => one.path === path)!; return { path, sha256: e.sha256!, size: e.size!, mode: e.mode }; };

  expect(code(run({ ...good, journal_nonce: "c".repeat(32) }))).toBe("manifest_not_for_this_run");
  expect(code(run({ ...good, native_session: "22222222-2222-4222-8222-222222222222" }))).toBe("manifest_not_for_this_run");
  expect(code(run(good, SOURCE(inv), { ...CALIBRATION, run_id: "dest-20261001-000009-cccccccc" }))).toBe("locator_calibration_not_bound");
  expect(code(run(good, SOURCE(inv), { ...CALIBRATION, project_dir: "-elsewhere" }))).toBe("locator_destination_mismatch");
  expect(code(run({ ...good, locator: { ...good.locator, source_project_dir: "-nope" } }))).toBe("locator_source_mismatch");
  expect(code(run(files(list => { list[0].sha256 = sha256Hex(Buffer.from("other")); })))).toBe("export_file_changed");
  expect(code(run(files(list => { list[0].size = 1; })))).toBe("export_file_changed");
  expect(code(run(files(list => { list.push(entry("config/.credentials.json")); })))).toBe("export_credential_shaped");
  expect(code(run(files(list => { list.push(entry("config/.claude.json")); })))).toBe("export_account_config");
  expect(code(run(files(list => { list.push(entry("home/Library/cache.txt")); })))).toBe("export_launch_generated");
  expect(code(run(files(list => { list.push(entry("box.sb")); })))).toBe("export_launch_generated");
  expect(code(run(files(list => { list.push({ ...entry(SIDE), path: `config/projects/${SRC_DIR}/ghost.json` }); })))).toBe("export_file_not_in_inventory");
  expect(code(run(files(list => { list.splice(0, 1); })))).toBe("transcript_not_in_manifest");
  expect(code(run(files(list => { delete list[1].dest_path; })))).toBe("locator_mapping_missing");
  expect(code(run(files(list => { list[1].dest_path = `config/projects/-guess/side/note.json`; })))).toBe("locator_mapping_not_justified");
  expect(code(run(files(list => { list.push(entry("config/projects/-other/x.json")); })))).toBe("project_dir_unexpected");
  expect(code(run(files(list => { list[0].dest_path = list[0].path; })))).toBe("locator_mapping_not_justified");

  // Where the measurement shows the same directory on both sides, there is nothing to map and nothing may be.
  const same = { ...good, files: good.files.map(one => ({ path: one.path, sha256: one.sha256, size: one.size, mode: one.mode })), locator: { ...good.locator, dest_project_dir: SRC_DIR } };
  expect(validateReviewed(same as ReviewedManifest, SOURCE(inv), { ...CALIBRATION, project_dir: SRC_DIR }).every(one => one.from === one.to)).toBe(true);
});

function exported(src: string, runDir: string, inv: Inventory, id = "0123456789abcdef") {
  const manifest = manifestFor(inv);
  const mapped = validateReviewed(manifest, SOURCE(inv), CALIBRATION);
  const source: ExportEnvelope["source"] = { run_id: RUN, journal_nonce: NONCE, native_session: SID, os: "darwin", cli_version: "2.1.286", cwd_realpath: src, report_sha256: "d".repeat(64) };
  const calibration: ExportEnvelope["calibration"] = { run_id: CAL, report_sha256: CAL_SHA, project_dir: DST_DIR, cwd_realpath: "/dest/cwd" };
  return exportNative({ sessionDir: src, runDir, exportId: id, manifest, manifestSha256: "e".repeat(64), mapped, source, calibration });
}
const EXPECTED = { source_run_id: RUN, source_nonce: NONCE, native_session: SID, calibration_run_id: CAL, calibration_report_sha256: CAL_SHA, calibration_project_dir: DST_DIR };
/** What an operator who selected THIS export passes: the run/calibration binding plus the export's own bundle digest. */
const expectFor = (out: { envelope: ExportEnvelope }) => ({ ...EXPECTED, bundle_digest: out.envelope.bundle_digest });
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const child = rel === "" ? name : `${rel}/${name}`;
      if (lstatSync(join(dir, child)).isDirectory()) walk(child); else out[child] = sha256Hex(readFileSync(join(dir, child)));
    }
  };
  walk("");
  return out;
}

test("export carries exactly the reviewed files verbatim under the measured locator and leaves the source untouched; import creates the absent session directory byte for byte", () => {
  const src = scratch(), runDir = scratch(), dest = scratch();
  sourceTree(src);
  const inv = inventoryTree(src);
  const sourceBefore = tree(src);
  const out = exported(src, runDir, inv);
  expect(tree(src)).toEqual(sourceBefore);
  expect(out.bundle.manifest.files).toBe(2);
  expect(out.envelope.locator).toEqual({ source_project_dir: SRC_DIR, dest_project_dir: DST_DIR, mapped_files: 2 });
  // Nothing but the reviewed files' bytes is in the export directory: no credential, account file, launch file, home or tmp.
  const blobs = readdirSync(join(out.dir, "blobs")).sort();
  expect(blobs).toEqual([sha256Hex(readFileSync(join(src, TRANSCRIPT))), sha256Hex(readFileSync(join(src, SIDE)))].sort());
  expect(readFileSync(join(out.dir, "manifest.json"), "utf8")).not.toContain("credential");
  expect(readExportDir(out.dir).envelope.bundle_digest).toBe(out.envelope.bundle_digest);

  const sessionDir = join(dest, "sessions", "conv");
  mkdirSync(dirname(sessionDir));
  const imported = importNative({ exportDir: out.dir, sessionDir, operation: "native-import:dest-20261001-000001-bbbbbbbb", expect: expectFor(out) });
  expect(imported.files.map(one => one.path).sort()).toEqual([`config/projects/${DST_DIR}/${SID}.jsonl`, `config/projects/${DST_DIR}/side/note.json`]);
  const landed = tree(sessionDir);
  expect(Object.keys(landed).sort()).toEqual([".imprnt-transfer.json", `config/projects/${DST_DIR}/${SID}.jsonl`, `config/projects/${DST_DIR}/side/note.json`]);
  expect(landed[`config/projects/${DST_DIR}/${SID}.jsonl`]).toBe(sourceBefore[TRANSCRIPT]);
  expect(landed[`config/projects/${DST_DIR}/side/note.json`]).toBe(sourceBefore[SIDE]);
  expect(lstatSync(join(sessionDir, `config/projects/${DST_DIR}/${SID}.jsonl`)).mode & 0o777).toBe(0o600);
  // The library's marker is the one file of its own in the session root, and an inventory of the imported tree accepts it.
  expect(inventoryTree(sessionDir).entries.some(one => one.path === ".imprnt-transfer.json")).toBe(true);
});

test("an existing destination, empty or not, is a collision and is preserved; an export for another run or another calibration is refused before anything is written", () => {
  const src = scratch(), runDir = scratch(), dest = scratch();
  sourceTree(src);
  const out = exported(src, runDir, inventoryTree(src));
  const parent = join(dest, "sessions");
  mkdirSync(parent);

  const empty = join(parent, "empty");
  mkdirSync(empty);
  expect(code(() => importNative({ exportDir: out.dir, sessionDir: empty, operation: "native-import:x", expect: expectFor(out) }))).toBe("dest_session_collision");
  expect(readdirSync(empty)).toEqual([]);

  const foreign = join(parent, "foreign");
  put(foreign, "keep.txt", "somebody else's");
  expect(code(() => importNative({ exportDir: out.dir, sessionDir: foreign, operation: "native-import:x", expect: expectFor(out) }))).toBe("dest_session_collision");
  expect(tree(foreign)).toEqual({ "keep.txt": sha256Hex(Buffer.from("somebody else's")) });

  const fresh = join(parent, "fresh");
  expect(code(() => importNative({ exportDir: out.dir, sessionDir: fresh, operation: "native-import:x", expect: { ...expectFor(out), source_nonce: "c".repeat(32) } }))).toBe("export_not_for_this_run");
  expect(code(() => importNative({ exportDir: out.dir, sessionDir: fresh, operation: "native-import:x", expect: { ...expectFor(out), calibration_project_dir: "-elsewhere" } }))).toBe("export_not_calibrated_here");
  expect(code(() => importNative({ exportDir: out.dir, sessionDir: fresh, operation: "native-import:x", expect: { ...expectFor(out), native_session: "22222222-2222-4222-8222-222222222222" } }))).toBe("export_not_for_this_run");
  expect(existsSync(fresh)).toBe(false);
});

test("an import names the export it was shown: any other or malformed bundle digest is refused first, before the destination is looked at, created or staged", () => {
  const src = scratch(), runDir = scratch(), dest = scratch();
  sourceTree(src);
  const out = exported(src, runDir, inventoryTree(src));
  const parent = join(dest, "sessions");
  mkdirSync(parent);
  const fresh = join(parent, "fresh");
  const attempt = (sessionDir: string, bundle_digest: string) => code(() => importNative({ exportDir: out.dir, sessionDir, operation: "native-import:x", expect: { ...expectFor(out), bundle_digest } }));
  for (const wrong of ["0".repeat(64), out.envelope.source_bundle_digest, out.envelope.bundle_digest.toUpperCase(), out.envelope.bundle_digest.slice(1), "", "not hex"]) {
    expect([wrong, attempt(fresh, wrong)]).toEqual([wrong, "export_not_the_selected_bundle"]);
  }
  expect(existsSync(fresh)).toBe(false);
  // Refused for the digest even where the destination is a foreign directory, which stays exactly as it was.
  const foreign = join(parent, "foreign");
  put(foreign, "keep.txt", "somebody else's");
  expect(attempt(foreign, "0".repeat(64))).toBe("export_not_the_selected_bundle");
  expect(tree(foreign)).toEqual({ "keep.txt": sha256Hex(Buffer.from("somebody else's")) });
  // A digest that matches the envelope but not the bundle that was actually read back cannot be forged by editing the envelope alone.
  const edited = JSON.parse(readFileSync(join(out.dir, "export.json"), "utf8"));
  edited.bundle_digest = "0".repeat(64);
  writeFileSync(join(out.dir, "export.json"), JSON.stringify(edited));
  expect(attempt(fresh, "0".repeat(64))).toBe("export_digest_mismatch");
  expect(existsSync(fresh)).toBe(false);
});

test("a changed byte, a swapped blob, a missing or extra blob and a link in the source are all refused, never carried", () => {
  const src = scratch(), runDir = scratch();
  sourceTree(src);
  const inv = inventoryTree(src);
  const manifest = manifestFor(inv);
  const mapped = validateReviewed(manifest, SOURCE(inv), CALIBRATION);
  const base = { sessionDir: src, runDir, manifest, manifestSha256: "e".repeat(64), mapped,
    source: { run_id: RUN, journal_nonce: NONCE, native_session: SID, os: "darwin", cli_version: "2.1.286", cwd_realpath: src, report_sha256: "d".repeat(64) },
    calibration: { run_id: CAL, report_sha256: CAL_SHA, project_dir: DST_DIR, cwd_realpath: "/dest/cwd" } };

  // The transcript grew between review and export.
  appendFileSync(join(src, TRANSCRIPT), "more\n");
  expect(code(() => exportNative({ ...base, exportId: "1111111111111111" }))).toBe("export_file_changed");
  expect(existsSync(join(runDir, "export-1111111111111111"))).toBe(false);

  // A listed file became a link.
  const linked = scratch();
  sourceTree(linked);
  const linkedInv = inventoryTree(linked);
  rmSync(join(linked, SIDE));
  symlinkSync("/etc/hosts", join(linked, SIDE));
  expect(code(() => exportNative({ ...base, sessionDir: linked, mapped: validateReviewed(manifestFor(linkedInv), SOURCE(linkedInv), CALIBRATION), exportId: "2222222222222222" }))).toBe("transfer:symlink");

  // A good export, then damage to the copied directory.
  const clean = scratch();
  sourceTree(clean);
  const cleanInv = inventoryTree(clean);
  const good = exported(clean, runDir, cleanInv, "3333333333333333");
  const blobs = readdirSync(join(good.dir, "blobs"));
  const victim = join(good.dir, "blobs", blobs[0]);
  const original = readFileSync(victim);
  writeFileSync(victim, Buffer.concat([Buffer.from([original[0] ^ 1]), original.subarray(1)]));
  expect(code(() => readExportDir(good.dir))).toBe("transfer:entry-hash");
  writeFileSync(victim, original);
  writeFileSync(join(good.dir, "blobs", "f".repeat(64)), "extra");
  expect(code(() => readExportDir(good.dir))).toBe("export_extra_blob");
  rmSync(join(good.dir, "blobs", "f".repeat(64)));
  rmSync(victim);
  expect(code(() => readExportDir(good.dir))).toBe("export_blob_missing");
  expect(code(() => exported(clean, runDir, cleanInv, "3333333333333333"))).toBe("export_dir_exists");
});

test("the fixture's effect log is read bounded, the login path is scrubbed from artifacts, and artifacts are written exclusively", () => {
  const fx = scratch();
  expect(readEffects(fx)).toEqual({ count: 0, results: [], malformed: 0 });
  writeFileSync(join(fx, "effects.jsonl"), `${JSON.stringify({ n: 1, tool: "fixture_effect", result: "RESULT-aa" })}\nnot json\n`);
  expect(readEffects(fx)).toEqual({ count: 2, results: ["RESULT-aa"], malformed: 1 });
  writeFileSync(join(fx, "effects.jsonl"), "x".repeat(64 * 1024 + 1));
  expect(code(() => readEffects(fx))).toBe("effects_log_invalid");

  const login = "/Users/someone/.runner-login/.credentials.json";
  const redactor = makeRedactor([login, dirname(login)]);
  const out = scratch();
  persistJson(join(out, "r.json"), { path: login, dir: dirname(login), nested: [`${dirname(login)}/config`] }, redactor);
  const text = readFileSync(join(out, "r.json"), "utf8");
  expect(text).not.toContain("runner-login");
  expect(text).toContain("<login>");
  expect(redactor.leaks(login)).toBe(true);
  expect(() => persistJson(join(out, "r.json"), {}, redactor)).toThrow();
  expect(() => writeExclusive(join(out, "r.json"), "x")).toThrow();
  expect(scanForLeaks([{ label: "argv", text: "a MARK-1234 b" }, { label: "env", text: "clean" }], ["MARK-1234"])).toEqual(["argv"]);
});

test("a run's journal is honoured only in the directory it names and in the role it was written for", () => {
  const parent = scratch();
  const run = join(parent, RUN);
  mkdirSync(run);
  const journal = { version: 1, kind: "claude-session-portability-journal", role: "source", run_id: RUN, nonce: NONCE, created_at: "t", run_dir: run,
    host: { platform: "linux", arch: "x", release: "r", bun: "b", machine: "m" }, ids: { person: "p1", agent: "p1-lair", conversation: SID },
    paths: { tree: run, state_root: run, session_dir: join(run, "s"), fixture_dir: join(run, "f") }, source: null };
  persistJson(join(run, "journal.json"), journal);
  expect(readJournal(run, "source").run_id).toBe(RUN);
  expect(code(() => readJournal(run, "destination"))).toBe("journal_kind");
  const moved = join(parent, "source-20261001-000000-dddddddd");
  renameSync(run, moved);
  expect(code(() => readJournal(moved, "source"))).toBe("journal_not_this_directory");
});
