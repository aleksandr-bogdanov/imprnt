import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  entryFor,
  entryExists,
  listPluginDirs,
  isEnabled,
  addPlugin,
  rmPlugin,
  importTargets,
} from "./plugins.ts";

// A throwaway repo root with a plugins/ tree. We never touch the real CLAUDE.local.md: every
// test wires against the temp root's own CLAUDE.local.md.
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "imprnt-plugins-"));
  mkdirSync(join(root, "plugins"), { recursive: true });
  return root;
}

function mkPlugin(root: string, name: string, files: Record<string, string> = {}): void {
  const dir = join(root, "plugins", name);
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
}

function readLocal(root: string): string {
  const p = join(root, "CLAUDE.local.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// --- entryFor ---

test("entryFor maps a bare name to <name>/agent.md", () => {
  expect(entryFor("anti-slop")).toBe("plugins/anti-slop/agent.md");
});

test("entryFor wires an explicit <name>/<file.md> as-is", () => {
  expect(entryFor("character/scribe.md")).toBe("plugins/character/scribe.md");
});

// --- listPluginDirs (bug 4) ---

test("listPluginDirs excludes any _-prefixed dir, not just _personal", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  mkPlugin(root, "_personal", { "voice.md": "x" });
  mkPlugin(root, "_secret", { "agent.md": "x" });
  mkPlugin(root, "_anything", { "agent.md": "x" });
  writeFileSync(join(root, "plugins", "README.md"), "gallery");
  const dirs = listPluginDirs(root);
  expect(dirs).toEqual(["anti-slop"]);
  expect(dirs).not.toContain("_personal");
  expect(dirs).not.toContain("_secret");
  expect(dirs).not.toContain("_anything");
});

test("listPluginDirs skips files (README.md) and dotfiles, returns sorted dirs", () => {
  const root = tmpRoot();
  mkPlugin(root, "zeta", { "agent.md": "x" });
  mkPlugin(root, "alpha", { "agent.md": "x" });
  writeFileSync(join(root, "plugins", "README.md"), "x");
  writeFileSync(join(root, "plugins", ".DS_Store"), "x");
  expect(listPluginDirs(root)).toEqual(["alpha", "zeta"]);
});

test("listPluginDirs returns empty when plugins/ is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "imprnt-noplugins-"));
  expect(listPluginDirs(root)).toEqual([]);
});

// --- entryExists / add existence guard (bug 3) ---

test("entryExists is true only for a real file under root", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  expect(entryExists(root, "plugins/anti-slop/agent.md")).toBe(true);
  expect(entryExists(root, "plugins/anti-slop/missing.md")).toBe(false);
  // A directory is not a valid entry file.
  expect(entryExists(root, "plugins/anti-slop")).toBe(false);
});

test("add of a nonexistent plugin errors and wires nothing (bug 3)", () => {
  const root = tmpRoot();
  const res = addPlugin(root, "doesnotexist");
  expect(res.added).toBe(false);
  expect(res.error).toBeDefined();
  expect(res.error).toContain("no such plugin entry");
  expect(existsSync(join(root, "CLAUDE.local.md"))).toBe(false);
});

test("add of a plugin with no agent.md (guard-style) errors (bug 3)", () => {
  const root = tmpRoot();
  mkPlugin(root, "guard", { "guard.ts": "x" }); // no agent.md
  const res = addPlugin(root, "guard");
  expect(res.added).toBe(false);
  expect(res.error).toContain("no such plugin entry");
  expect(readLocal(root)).not.toContain("@plugins/guard");
});

// --- addPlugin happy paths + idempotency ---

test("add wires a real plugin and creates CLAUDE.local.md with header on first add", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  const res = addPlugin(root, "anti-slop");
  expect(res).toEqual({ entry: "plugins/anti-slop/agent.md", added: true });
  const local = readLocal(root);
  expect(local).toContain("# Personal plugin toggles");
  expect(local).toContain("@plugins/anti-slop/agent.md");
});

test("add is idempotent: second add reports already wired, file unchanged", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  addPlugin(root, "anti-slop");
  const before = readLocal(root);
  const res = addPlugin(root, "anti-slop");
  expect(res.added).toBe(false);
  expect(res.error).toBeUndefined();
  expect(readLocal(root)).toBe(before);
});

test("add of <name>/<file.md> wires that exact file", () => {
  const root = tmpRoot();
  mkPlugin(root, "character", { "scribe.md": "x" });
  const res = addPlugin(root, "character/scribe.md");
  expect(res).toEqual({ entry: "plugins/character/scribe.md", added: true });
  expect(readLocal(root)).toContain("@plugins/character/scribe.md");
});

// --- _personal personalization path (documented "make it yours" flow) ---
// The list-exclusion (listPluginDirs hides _-prefixed dirs) and the add path (entryFor/addPlugin)
// are different functions. addPlugin must still WIRE an _personal/<file>.md entry even though
// listPluginDirs hides _personal. This test guards the documented flow against a future change to
// the exclusion logic leaking into the add path. It would FAIL if add ever started excluding
// _-prefixed specs: addPlugin would return added=false / an error, no line would be written, and
// isEnabled would report false.
test("add of _personal/<file.md> wires it and isEnabled reports it, though listPluginDirs hides _personal", () => {
  const root = tmpRoot();
  // Create the entry file so the round-1 existence guard passes.
  mkPlugin(root, "_personal", { "voice.md": "x" });
  const res = addPlugin(root, "_personal/voice.md");
  expect(res).toEqual({ entry: "plugins/_personal/voice.md", added: true });
  expect(readLocal(root)).toContain("@plugins/_personal/voice.md");
  expect(isEnabled(root, "_personal")).toBe(true);
  // The gallery listing still hides _personal even though it is wired.
  expect(listPluginDirs(root)).not.toContain("_personal");
});

// --- multi-spec behavior simulated as the cli loop does it (bug 1) ---

test("adding two specs in sequence wires BOTH (bug 1)", () => {
  const root = tmpRoot();
  mkPlugin(root, "character", { "scribe.md": "x" });
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  const a = addPlugin(root, "character/scribe.md");
  const b = addPlugin(root, "anti-slop");
  expect(a.added).toBe(true);
  expect(b.added).toBe(true);
  const local = readLocal(root);
  expect(local).toContain("@plugins/character/scribe.md");
  expect(local).toContain("@plugins/anti-slop/agent.md");
});

test("multi-spec: a duplicate spec in one call is idempotent (single line)", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  // The cli add loop calls addPlugin once per spec, so `add a a` lands here twice.
  const first = addPlugin(root, "anti-slop");
  const second = addPlugin(root, "anti-slop");
  expect(first.added).toBe(true);
  expect(second.added).toBe(false);
  const lines = readLocal(root).split("\n").filter((l) => l.trim() === "@plugins/anti-slop/agent.md");
  expect(lines.length).toBe(1);
});

test("multi-spec: a bad spec errors but the good ones still wire", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  const good = addPlugin(root, "anti-slop");
  const bad = addPlugin(root, "doesnotexist");
  expect(good.added).toBe(true);
  expect(bad.error).toBeDefined();
  const local = readLocal(root);
  expect(local).toContain("@plugins/anti-slop/agent.md");
  expect(local).not.toContain("@plugins/doesnotexist");
});

// --- trailing newline preservation ---

test("add preserves a single trailing newline and does not double it", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  // Seed a file that already ends with one newline.
  writeFileSync(join(root, "CLAUDE.local.md"), "# header\n");
  addPlugin(root, "anti-slop");
  const local = readLocal(root);
  expect(local).toBe("# header\n@plugins/anti-slop/agent.md\n");
});

test("add adds a missing trailing newline before appending", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  writeFileSync(join(root, "CLAUDE.local.md"), "# header"); // no trailing newline
  addPlugin(root, "anti-slop");
  expect(readLocal(root)).toBe("# header\n@plugins/anti-slop/agent.md\n");
});

// --- isEnabled ---

test("isEnabled detects <name>/<file>-style wiring", () => {
  const root = tmpRoot();
  mkPlugin(root, "character", { "scribe.md": "x" });
  addPlugin(root, "character/scribe.md");
  expect(isEnabled(root, "character")).toBe(true);
});

test("isEnabled detects a bare-name agent.md wiring", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  addPlugin(root, "anti-slop");
  expect(isEnabled(root, "anti-slop")).toBe(true);
});

test("isEnabled treats a commented @import line as NOT enabled", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "CLAUDE.local.md"), "# @plugins/anti-slop/agent.md\n");
  expect(isEnabled(root, "anti-slop")).toBe(false);
});

test("isEnabled is false for an absent CLAUDE.local.md", () => {
  const root = tmpRoot();
  expect(isEnabled(root, "anything")).toBe(false);
});

// --- rmPlugin: prefix safety, commented lines, idempotency ---

test("rm removes only the right line and respects the / boundary (rm anti != anti-slop)", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  addPlugin(root, "anti-slop");
  const removed = rmPlugin(root, "anti");
  expect(removed).toBe(0);
  expect(readLocal(root)).toContain("@plugins/anti-slop/agent.md");
});

test("rm removes the matching uncommented line and reports the count", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  addPlugin(root, "anti-slop");
  const removed = rmPlugin(root, "anti-slop");
  expect(removed).toBe(1);
  expect(readLocal(root)).not.toContain("@plugins/anti-slop/agent.md");
});

test("rm leaves a commented line alone (commented is not wired)", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "CLAUDE.local.md"), "# @plugins/anti-slop/agent.md\n");
  const removed = rmPlugin(root, "anti-slop");
  expect(removed).toBe(0);
  expect(readLocal(root)).toContain("# @plugins/anti-slop/agent.md");
});

test("rm on an absent file is a clean no-op", () => {
  const root = tmpRoot();
  expect(rmPlugin(root, "anything")).toBe(0);
});

test("rm is idempotent: a second rm removes nothing", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  addPlugin(root, "anti-slop");
  expect(rmPlugin(root, "anti-slop")).toBe(1);
  expect(rmPlugin(root, "anti-slop")).toBe(0);
});

// --- spec containment: nothing outside plugins/ is ever reachable from a spec ---

test("addPlugin refuses a spec that escapes plugins/ and wires nothing", () => {
  const root = tmpRoot();
  // A real file OUTSIDE plugins/ that an uncontained wire-only spec would reach and wire.
  writeFileSync(join(root, "secret.md"), "x");
  const res = addPlugin(root, "../secret.md");
  expect(res.added).toBe(false);
  expect(res.error).toContain("invalid plugin spec");
  expect(readLocal(root)).toBe("");
});

test("addPlugin refuses .. and an absolute spec", () => {
  const root = tmpRoot();
  expect(addPlugin(root, "..").error).toContain("invalid plugin spec");
  expect(addPlugin(root, join(root, "plugins")).error).toContain("invalid plugin spec");
  expect(existsSync(join(root, "CLAUDE.local.md"))).toBe(false);
});

// --- non-canonical spec rejection (findings 1 + 3) ---
// A spec that RESOLVES inside plugins/ but is not its own canonical form (./x, a/../b, a
// trailing slash) used to pass the old containment check, because that only looked at where the
// resolved path landed. It would then wire a literal `@plugins/guard/../_personal/voice.md` line
// that the natural `rm` could never match, and it routes around every literal-string guard
// downstream (the _personal protection in purge). Reject any non-canonical spec at the door.

test("addPlugin refuses a leading ./ spec even though it resolves inside plugins/ (finding 3)", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x" });
  const res = addPlugin(root, "./_personal/voice.md");
  expect(res.added).toBe(false);
  expect(res.error).toContain("invalid plugin spec");
  expect(existsSync(join(root, "CLAUDE.local.md"))).toBe(false);
});

test("addPlugin refuses an embedded .. spec that resolves back inside plugins/ (finding 3)", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x" });
  mkPlugin(root, "guard", { "agent.md": "x" });
  // guard/../_personal/voice.md resolves to plugins/_personal/voice.md - inside plugins/, but the
  // wired line `@plugins/guard/../_personal/voice.md` is un-removable by a natural rm.
  const res = addPlugin(root, "guard/../_personal/voice.md");
  expect(res.added).toBe(false);
  expect(res.error).toContain("invalid plugin spec");
  expect(existsSync(join(root, "CLAUDE.local.md"))).toBe(false);
});

test("addPlugin does not wire a dangling line for a trailing-slash spec", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  // A trailing slash is tolerated input (tab-completion noise), but entryFor("anti-slop/") points
  // at a dir, not a file, so the entryExists guard rejects it cleanly - nothing dangling is wired.
  const res = addPlugin(root, "anti-slop/");
  expect(res.added).toBe(false);
  expect(res.error).toContain("no such plugin entry");
  expect(existsSync(join(root, "CLAUDE.local.md"))).toBe(false);
});

// --- rm trailing-slash handling (finding 2) ---
// Shell dir tab-completion appends a trailing slash. `rm anti-slop/` used to flip the
// includes("/") branch to the exact-file matcher `@plugins/anti-slop/`, which never equals the
// wired `@plugins/anti-slop/agent.md` - a silent no-op that REPORTED success while the plugin
// stayed wired. A single trailing slash must be treated as the bare-name (group) form.

test("rm of a tab-completed bare name (trailing slash) actually unwires (finding 2)", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  addPlugin(root, "anti-slop");
  const removed = rmPlugin(root, "anti-slop/");
  expect(removed).toBe(1);
  expect(readLocal(root)).not.toContain("@plugins/anti-slop/agent.md");
});

test("rm of a tab-completed _personal/ (trailing slash) removes the whole group (finding 2)", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x", "taylor.md": "x" });
  addPlugin(root, "_personal/voice.md");
  addPlugin(root, "_personal/taylor.md");
  expect(rmPlugin(root, "_personal/")).toBe(2);
  expect(readLocal(root)).not.toContain("@plugins/_personal");
});

// --- case-insensitive collision: one dir, one wired line (finding 2) ---
// On a case-insensitive FS, plugins/anti-slop and plugins/Anti-Slop are the same physical dir, but
// the wire-line match is case-sensitive. Adding a case-variant of an already-wired plugin used to
// append a SECOND distinct @import line (and `plugin list` would hide the dup, and a later
// `rm Foo --purge` would delete the shared dir while leaving the other case's line dangling).
// addPlugin must reuse the existing on-disk dir name so there is exactly one line, matching the dir.

test("add of a case-variant of an installed plugin does not wire a second line (finding 2)", () => {
  const root = tmpRoot();
  // Only the lowercase dir exists on disk.
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  const a = addPlugin(root, "anti-slop");
  expect(a.added).toBe(true);
  // Adding the SAME plugin under a different case must canonicalize to the existing dir, so it is
  // already wired - no second line, and the entry matches the on-disk dir name.
  const b = addPlugin(root, "Anti-Slop");
  expect(b.added).toBe(false);
  expect(b.error).toBeUndefined();
  expect(b.entry).toBe("plugins/anti-slop/agent.md");
  const lines = readLocal(root).split(/\r?\n/).filter((l) => l.trim().startsWith("@plugins/"));
  expect(lines).toEqual(["@plugins/anti-slop/agent.md"]);
});

test("add of a case-variant <name>/<file.md> reuses the on-disk dir name for the wired line (finding 2)", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x" });
  addPlugin(root, "_personal/voice.md");
  // A case-variant of the dir component must wire against the existing dir, not a second one.
  const res = addPlugin(root, "_Personal/voice.md");
  expect(res.added).toBe(false);
  expect(res.entry).toBe("plugins/_personal/voice.md");
  const lines = readLocal(root).split(/\r?\n/).filter((l) => l.trim().startsWith("@plugins/"));
  expect(lines).toEqual(["@plugins/_personal/voice.md"]);
});

// --- importTargets / isEnabled ignore FENCED @import lines (finding 4) ---
// Claude Code does NOT evaluate @imports inside a ``` code fence, but imp's inline/list logic used
// to. A fenced @import would load in every outside session yet never in the lair (the launcher
// promises those match), and `plugin list` would report a fenced plugin [on]. Lines inside a fence
// must be skipped by the ONE parser (importTargets) and by isEnabled.

test("importTargets skips an @import inside a code fence (finding 4)", () => {
  const root = tmpRoot();
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    [
      "@plugins/anti-slop/agent.md",
      "",
      "```",
      "@plugins/character/scribe.md",
      "```",
      "",
      "@plugins/guard/agent.md",
    ].join("\n"),
  );
  const targets = importTargets(root);
  expect(targets).toEqual(["plugins/anti-slop/agent.md", "plugins/guard/agent.md"]);
  expect(targets).not.toContain("plugins/character/scribe.md");
});

test("importTargets handles a fence with an info string (```md) and tildes", () => {
  const root = tmpRoot();
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    [
      "~~~md",
      "@plugins/anti-slop/agent.md",
      "~~~",
      "@plugins/guard/agent.md",
    ].join("\n"),
  );
  expect(importTargets(root)).toEqual(["plugins/guard/agent.md"]);
});

test("isEnabled reports a fenced @import as NOT enabled (finding 4)", () => {
  const root = tmpRoot();
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    ["```", "@plugins/character/scribe.md", "```"].join("\n"),
  );
  expect(isEnabled(root, "character")).toBe(false);
});

// --- a hand-commented <name>/<file.md> line: rm finds it, add does not duplicate (finding 3) ---
// Hand-editing CLAUDE.local.md is documented. A user can append a trailing comment to a managed
// line (`@plugins/_personal/voice.md  # my overlay`). addPlugin's exact-line match (l.trim() ===
// line) and rmPlugin's exact-line match (l === importLine) both missed that variant for the
// <name>/<file.md> form: add would DUPLICATE it, rm would NO-OP, while list/isEnabled (prefix
// scan) correctly reported it on. Match on the import TARGET token, tolerating a trailing comment.

test("rm of a <name>/<file.md> finds a hand-commented (trailing-#) line (finding 3)", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x" });
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "# header\n@plugins/_personal/voice.md  # my overlay\n",
  );
  const removed = rmPlugin(root, "_personal/voice.md");
  expect(removed).toBe(1);
  expect(readLocal(root)).not.toContain("@plugins/_personal/voice.md");
});

test("add of a <name>/<file.md> does not duplicate a hand-commented line (finding 3)", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x" });
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "# header\n@plugins/_personal/voice.md  # my overlay\n",
  );
  const res = addPlugin(root, "_personal/voice.md");
  expect(res.added).toBe(false);
  expect(res.error).toBeUndefined();
  const lines = readLocal(root).split(/\r?\n/).filter((l) => l.includes("@plugins/_personal/voice.md"));
  expect(lines.length).toBe(1);
});

// rm of a bare name already matched a commented-out (`# @plugins/...`) line via prefix? No - a
// commented line is not live and stays. But a trailing-comment line under a bare-name group must
// still be removed by the group rm, consistent with the file-form fix.
test("rm of a bare name removes a hand-commented (trailing-#) group line (finding 3)", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x", "taylor.md": "x" });
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "# header\n@plugins/_personal/voice.md  # overlay\n@plugins/_personal/taylor.md\n",
  );
  expect(rmPlugin(root, "_personal")).toBe(2);
  expect(readLocal(root)).not.toContain("@plugins/_personal");
});

// --- rm symmetry: a file spec removes exactly its line, a bare name removes the group ---

test("rm of a <name>/<file.md> spec removes exactly that line and leaves siblings", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x", "taylor.md": "x" });
  addPlugin(root, "_personal/voice.md");
  addPlugin(root, "_personal/taylor.md");
  expect(rmPlugin(root, "_personal/voice.md")).toBe(1);
  const local = readLocal(root);
  expect(local).not.toContain("@plugins/_personal/voice.md");
  expect(local).toContain("@plugins/_personal/taylor.md");
});

test("rm of a bare name keeps group semantics: every line under plugins/<name>/ goes", () => {
  const root = tmpRoot();
  mkPlugin(root, "_personal", { "voice.md": "x", "taylor.md": "x" });
  addPlugin(root, "_personal/voice.md");
  addPlugin(root, "_personal/taylor.md");
  expect(rmPlugin(root, "_personal")).toBe(2);
  expect(readLocal(root)).not.toContain("@plugins/_personal");
});

// --- CRLF round-trip: the managed line is the only thing that changes ---

test("rm on a CRLF file preserves CRLF endings everywhere else", () => {
  const root = tmpRoot();
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "# header\r\n\r\n@plugins/anti-slop/agent.md\r\n@plugins/character/scribe.md\r\n",
  );
  expect(rmPlugin(root, "anti-slop")).toBe(1);
  expect(readLocal(root)).toBe("# header\r\n\r\n@plugins/character/scribe.md\r\n");
});

test("add appends with the file's own CRLF ending", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  writeFileSync(join(root, "CLAUDE.local.md"), "# header\r\n");
  addPlugin(root, "anti-slop");
  expect(readLocal(root)).toBe("# header\r\n@plugins/anti-slop/agent.md\r\n");
});

// --- fs errors surface as clean error strings, never throws ---

test("addPlugin onto a read-only CLAUDE.local.md returns a clean error instead of throwing", () => {
  const root = tmpRoot();
  mkPlugin(root, "anti-slop", { "agent.md": "x" });
  const p = join(root, "CLAUDE.local.md");
  writeFileSync(p, "# header\n");
  chmodSync(p, 0o444);
  const res = addPlugin(root, "anti-slop");
  chmodSync(p, 0o644);
  expect(res.added).toBe(false);
  expect(res.error).toMatch(/EACCES|permission denied/);
});
