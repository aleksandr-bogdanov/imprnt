import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addGlobalModule, rmGlobalModule, listGlobalModules, installedGlobalDirs, globalFragment } from "./global.ts";

// Every test runs against a throwaway "global dir" - NEVER the developer's real ~/.claude. The lib
// takes the dir as an argument exactly so this is sandboxable.
function sandbox(): { globalDir: string; src: (name: string, withAgent?: boolean) => string } {
  const root = mkdtempSync(join(tmpdir(), "imprnt-global-"));
  const globalDir = join(root, "claude");
  mkdirSync(globalDir, { recursive: true });
  // A source module dir with an agent.md (and a package.json to prove it is dropped on copy).
  const src = (name: string, withAgent = true): string => {
    const dir = join(root, `src-${name}`);
    mkdirSync(dir, { recursive: true });
    if (withAgent) writeFileSync(join(dir, "agent.md"), `# ${name} rules\n`);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `imprnt-plugin-${name}` }));
    return dir;
  };
  return { globalDir, src };
}

function claudeMd(globalDir: string): string {
  const p = join(globalDir, "CLAUDE.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function registry(globalDir: string): string {
  const p = join(globalDir, "imprnt", "global.json");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// --- the core shift: add/rm/list use the registry, NEVER ~/.claude/CLAUDE.md ---

test("add records the module in the registry, copies the module, drops package.json - and never writes CLAUDE.md", () => {
  const { globalDir, src } = sandbox();
  const r = addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(r.ok).toBe(true);
  expect(r.changed).toBe(true);

  // The enable list is the imprnt-owned registry, NOT the user's CLAUDE.md.
  expect(JSON.parse(registry(globalDir))).toEqual({ enabled: ["anti-slop"] });
  expect(existsSync(join(globalDir, "CLAUDE.md"))).toBe(false); // CLAUDE.md is never created

  // The copy landed at <globalDir>/imprnt/<name>/ with agent.md, and package.json was filtered out.
  expect(existsSync(join(globalDir, "imprnt", "anti-slop", "agent.md"))).toBe(true);
  expect(existsSync(join(globalDir, "imprnt", "anti-slop", "package.json"))).toBe(false);

  expect(listGlobalModules(globalDir)).toEqual(["anti-slop"]);
});

test("add is idempotent - the same module twice does not duplicate the registry entry", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  const second = addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(second.ok).toBe(true);
  expect(second.changed).toBe(false); // already enabled
  expect(JSON.parse(registry(globalDir))).toEqual({ enabled: ["anti-slop"] });
  expect(listGlobalModules(globalDir)).toEqual(["anti-slop"]);
});

test("two modules sort inside the registry", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "demo", src("demo"));
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(listGlobalModules(globalDir)).toEqual(["anti-slop", "demo"]); // sorted
  expect(JSON.parse(registry(globalDir))).toEqual({ enabled: ["anti-slop", "demo"] });
});

test("add/rm never touch the user's own ~/.claude/CLAUDE.md (it stays pristine)", () => {
  const { globalDir, src } = sandbox();
  const userContent = "# My global instructions\n\nAlways write tests first.\n\nBe terse.\n";
  writeFileSync(join(globalDir, "CLAUDE.md"), userContent);

  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(claudeMd(globalDir)).toBe(userContent); // byte-for-byte, no managed block injected

  rmGlobalModule(globalDir, "anti-slop", { purge: true });
  expect(claudeMd(globalDir)).toBe(userContent); // still untouched after rm
});

test("rm removes one module from the registry but leaves the other", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "demo", src("demo"));
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  const r = rmGlobalModule(globalDir, "demo");
  expect(r.changed).toBe(true);
  expect(listGlobalModules(globalDir)).toEqual(["anti-slop"]);
  expect(JSON.parse(registry(globalDir))).toEqual({ enabled: ["anti-slop"] });
});

test("rm of the last module empties the registry (no orphan entry)", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  rmGlobalModule(globalDir, "anti-slop");
  expect(listGlobalModules(globalDir)).toEqual([]);
  expect(JSON.parse(registry(globalDir))).toEqual({ enabled: [] });
});

test("rm --purge deletes the copied dir; plain rm leaves it on disk", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));

  rmGlobalModule(globalDir, "anti-slop"); // unwire only
  expect(existsSync(join(globalDir, "imprnt", "anti-slop"))).toBe(true); // copy stays
  expect(installedGlobalDirs(globalDir)).toEqual(["anti-slop"]);

  // Re-enable then purge.
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  rmGlobalModule(globalDir, "anti-slop", { purge: true });
  expect(existsSync(join(globalDir, "imprnt", "anti-slop"))).toBe(false);
});

test("rm of a module that was never enabled is a clean no-op", () => {
  const { globalDir } = sandbox();
  const r = rmGlobalModule(globalDir, "ghost");
  expect(r.ok).toBe(true);
  expect(r.changed).toBe(false);
});

test("add rejects a source with no agent.md (a behavior module needs the fragment)", () => {
  const { globalDir, src } = sandbox();
  const r = addGlobalModule(globalDir, "bad", src("bad", false));
  expect(r.ok).toBe(false);
  expect(r.error).toContain("no agent.md");
  expect(existsSync(join(globalDir, "imprnt", "global.json"))).toBe(false); // wrote nothing
});

test("add rejects a name that would escape the imprnt/ copy dir (path traversal / separator)", () => {
  const { globalDir, src } = sandbox();
  for (const bad of ["../evil", "a/b", "..", "/abs", "with space"]) {
    const r = addGlobalModule(globalDir, bad, src("ok"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid module name");
  }
  // Nothing was created outside imprnt/.
  expect(existsSync(join(globalDir, "..", "evil"))).toBe(false);
});

test("listGlobalModules is empty and tolerant when there is no registry or CLAUDE.md", () => {
  const { globalDir } = sandbox();
  expect(listGlobalModules(globalDir)).toEqual([]);
  writeFileSync(join(globalDir, "CLAUDE.md"), "# just user content, no managed block\n");
  expect(listGlobalModules(globalDir)).toEqual([]);
});

test("listGlobalModules tolerates a corrupt registry (reads as empty)", () => {
  const { globalDir } = sandbox();
  mkdirSync(join(globalDir, "imprnt"), { recursive: true });
  writeFileSync(join(globalDir, "imprnt", "global.json"), "{not json");
  expect(listGlobalModules(globalDir)).toEqual([]);
});

test("add refreshes the copy on a re-add (clean copy, not an overlay of stale files)", () => {
  const { globalDir, src } = sandbox();
  // First source ships a stray file the next version drops.
  const v1 = src("antislop-v1");
  writeFileSync(join(v1, "stale.md"), "old\n");
  addGlobalModule(globalDir, "anti-slop", v1);
  expect(existsSync(join(globalDir, "imprnt", "anti-slop", "stale.md"))).toBe(true);

  // A genuinely DIFFERENT source dir (no stray file); re-add must clear the old file, not overlay it.
  const v2 = src("antislop-v2");
  addGlobalModule(globalDir, "anti-slop", v2);
  expect(existsSync(join(globalDir, "imprnt", "anti-slop", "stale.md"))).toBe(false);
  expect(existsSync(join(globalDir, "imprnt", "anti-slop", "agent.md"))).toBe(true);
});

// --- globalFragment: the text imp injects ---

test("globalFragment concatenates the enabled modules' agent.md, in sorted order", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "demo", src("demo"));
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(globalFragment(globalDir)).toBe("# anti-slop rules\n\n# demo rules");
});

test("globalFragment is empty when nothing is enabled", () => {
  const { globalDir } = sandbox();
  expect(globalFragment(globalDir)).toBe("");
});

test("globalFragment skips a module named in the skip set (dedupe vs the project cast)", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  addGlobalModule(globalDir, "demo", src("demo"));
  // anti-slop is also enabled project-locally - imp passes it in the skip set so it injects once.
  expect(globalFragment(globalDir, new Set(["anti-slop"]))).toBe("# demo rules");
});

test("globalFragment skips an enabled module whose copy is gone (registry orphan)", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  // Hand-enable a ghost in the registry with no copy on disk.
  writeFileSync(join(globalDir, "imprnt", "global.json"), JSON.stringify({ enabled: ["anti-slop", "ghost"] }));
  expect(globalFragment(globalDir)).toBe("# anti-slop rules");
});

// --- migration: a legacy ~/.claude/CLAUDE.md managed block self-heals into the registry ---

const BEGIN = "<!-- imprnt:global BEGIN (managed by imprnt - edit with `imprnt global add/rm`) -->";
const END = "<!-- imprnt:global END -->";

test("a clean legacy block migrates into the registry and is stripped from CLAUDE.md, user content preserved", () => {
  const { globalDir, src } = sandbox();
  // Stage the copies the old design would have made, then a CLAUDE.md with a clean managed block.
  addGlobalModuleCopyOnly(globalDir, "anti-slop", src("anti-slop"));
  addGlobalModuleCopyOnly(globalDir, "demo", src("demo"));
  const legacy = `# My instructions\n\nBe terse.\n\n${BEGIN}\n@imprnt/anti-slop/agent.md\n@imprnt/demo/agent.md\n${END}\n\nBottom paragraph.\n`;
  writeFileSync(join(globalDir, "CLAUDE.md"), legacy);

  // A plain list triggers the migration.
  expect(listGlobalModules(globalDir)).toEqual(["anti-slop", "demo"]);
  expect(JSON.parse(registry(globalDir))).toEqual({ enabled: ["anti-slop", "demo"] });

  const md = claudeMd(globalDir);
  expect(md).not.toContain("imprnt:global"); // block gone
  expect(md).toContain("Be terse."); // user content preserved
  expect(md).toContain("Bottom paragraph.");
  // The two user paragraphs that bracketed the block stay separate (not fused).
  expect(md).toMatch(/Be terse\.\n\nBottom paragraph\./);
});

test("migration carries names forward even on `add` and merges them with the new one", () => {
  const { globalDir, src } = sandbox();
  addGlobalModuleCopyOnly(globalDir, "anti-slop", src("anti-slop"));
  writeFileSync(join(globalDir, "CLAUDE.md"), `${BEGIN}\n@imprnt/anti-slop/agent.md\n${END}\n`);
  // Add a NEW module: migration folds anti-slop in, demo lands beside it.
  addGlobalModule(globalDir, "demo", src("demo"));
  expect(listGlobalModules(globalDir)).toEqual(["anti-slop", "demo"]);
  expect(claudeMd(globalDir)).not.toContain("imprnt:global");
});

test("migration refuses a legacy block a human pasted real content into (CLAUDE.md untouched)", () => {
  const { globalDir, src } = sandbox();
  const foreign = `# my rules\n\n${BEGIN}\nMY OWN NOTES - do not lose these\n${END}\n`;
  writeFileSync(join(globalDir, "CLAUDE.md"), foreign);

  const add = addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(add.ok).toBe(false);
  expect(add.error).toContain("hand-edited");
  // The user's notes are untouched, no copy made, no registry written.
  expect(claudeMd(globalDir)).toBe(foreign);
  expect(existsSync(join(globalDir, "imprnt", "anti-slop"))).toBe(false);
  expect(existsSync(join(globalDir, "imprnt", "global.json"))).toBe(false);

  const rm = rmGlobalModule(globalDir, "anti-slop");
  expect(rm.ok).toBe(false);
  expect(claudeMd(globalDir)).toBe(foreign);
  // list does NOT throw on a foreign block - it just reads the (empty) registry, block left alone.
  expect(listGlobalModules(globalDir)).toEqual([]);
  expect(claudeMd(globalDir)).toBe(foreign);
});

test("a CLAUDE.md with NO legacy block is never modified by a global command", () => {
  const { globalDir, src } = sandbox();
  const user = "# my rules\r\n\r\nbe terse.\r\n";
  writeFileSync(join(globalDir, "CLAUDE.md"), user);
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(claudeMd(globalDir)).toBe(user); // byte-for-byte, CRLF and all
});

// Helper: stage ONLY the copy at <globalDir>/imprnt/<name>/ (no registry write), to simulate the
// state the old design left behind - copies on disk plus a CLAUDE.md block, no registry yet.
function addGlobalModuleCopyOnly(globalDir: string, name: string, srcDir: string): void {
  const dest = join(globalDir, "imprnt", name);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "agent.md"), readFileSync(join(srcDir, "agent.md"), "utf8"));
}
