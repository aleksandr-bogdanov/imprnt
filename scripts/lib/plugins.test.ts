import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  entryFor,
  entryExists,
  listPluginDirs,
  isEnabled,
  addPlugin,
  rmPlugin,
} from "./plugins.ts";

// A throwaway repo root with a plugins/ tree. We never touch the real CLAUDE.local.md: every
// test wires against the temp root's own CLAUDE.local.md.
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "imprint-plugins-"));
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
  const root = mkdtempSync(join(tmpdir(), "imprint-noplugins-"));
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
