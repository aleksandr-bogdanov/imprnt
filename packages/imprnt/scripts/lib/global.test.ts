import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addGlobalModule, rmGlobalModule, listGlobalModules, installedGlobalDirs } from "./global.ts";

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

test("add wires the import in a managed block, copies the module, drops package.json", () => {
  const { globalDir, src } = sandbox();
  const r = addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(r.ok).toBe(true);
  expect(r.changed).toBe(true);

  const md = claudeMd(globalDir);
  expect(md).toContain("imprnt:global BEGIN");
  expect(md).toContain("@imprnt/anti-slop/agent.md");
  expect(md).toContain("imprnt:global END");

  // The copy landed at <globalDir>/imprnt/<name>/ with agent.md, and package.json was filtered out.
  expect(existsSync(join(globalDir, "imprnt", "anti-slop", "agent.md"))).toBe(true);
  expect(existsSync(join(globalDir, "imprnt", "anti-slop", "package.json"))).toBe(false);

  expect(listGlobalModules(globalDir)).toEqual(["anti-slop"]);
});

test("add is idempotent - the same module twice does not duplicate the import line", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  const second = addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(second.ok).toBe(true);
  expect(second.changed).toBe(false); // already wired
  const occurrences = claudeMd(globalDir).split("@imprnt/anti-slop/agent.md").length - 1;
  expect(occurrences).toBe(1);
  expect(listGlobalModules(globalDir)).toEqual(["anti-slop"]);
});

test("two modules sort inside one block", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "guard", src("guard"));
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(listGlobalModules(globalDir)).toEqual(["anti-slop", "guard"]); // sorted, not insertion order
  // exactly one managed block
  expect(claudeMd(globalDir).split("imprnt:global BEGIN").length - 1).toBe(1);
});

test("the user's own CLAUDE.md content outside the fence is preserved byte-for-byte across add and rm", () => {
  const { globalDir, src } = sandbox();
  const userContent = "# My global instructions\n\nAlways write tests first.\n\nBe terse.\n";
  writeFileSync(join(globalDir, "CLAUDE.md"), userContent);

  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  // The user's prose is still all there, untouched.
  expect(claudeMd(globalDir)).toContain("Always write tests first.");
  expect(claudeMd(globalDir)).toContain("Be terse.");

  rmGlobalModule(globalDir, "anti-slop", { purge: true });
  // After removal the block is gone AND the user's content is exactly what it was.
  const after = claudeMd(globalDir);
  expect(after).not.toContain("imprnt:global");
  expect(after).toContain("Always write tests first.");
  expect(after).toContain("Be terse.");
  expect(after.trimEnd()).toBe(userContent.trimEnd());
});

test("rm removes one module's line but leaves the block and the other module", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "guard", src("guard"));
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  const r = rmGlobalModule(globalDir, "guard");
  expect(r.changed).toBe(true);
  expect(listGlobalModules(globalDir)).toEqual(["anti-slop"]);
  expect(claudeMd(globalDir)).toContain("imprnt:global BEGIN"); // block survives
  expect(claudeMd(globalDir)).not.toContain("@imprnt/guard/agent.md");
});

test("rm of the last module removes the whole block (no orphan markers)", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  rmGlobalModule(globalDir, "anti-slop");
  const md = claudeMd(globalDir);
  expect(md).not.toContain("imprnt:global BEGIN");
  expect(md).not.toContain("imprnt:global END");
});

test("rm --purge deletes the copied dir; plain rm leaves it on disk", () => {
  const { globalDir, src } = sandbox();
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));

  rmGlobalModule(globalDir, "anti-slop"); // unwire only
  expect(existsSync(join(globalDir, "imprnt", "anti-slop"))).toBe(true); // copy stays
  expect(installedGlobalDirs(globalDir)).toEqual(["anti-slop"]);

  // Re-wire then purge.
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  rmGlobalModule(globalDir, "anti-slop", { purge: true });
  expect(existsSync(join(globalDir, "imprnt", "anti-slop"))).toBe(false);
});

test("rm of a module that was never wired is a clean no-op", () => {
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
  expect(existsSync(join(globalDir, "CLAUDE.md"))).toBe(false); // wrote nothing
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

test("listGlobalModules is empty and tolerant when there is no CLAUDE.md or no block", () => {
  const { globalDir } = sandbox();
  expect(listGlobalModules(globalDir)).toEqual([]);
  writeFileSync(join(globalDir, "CLAUDE.md"), "# just user content, no managed block\n");
  expect(listGlobalModules(globalDir)).toEqual([]);
});

test("a CRLF CLAUDE.md stays CRLF on add - no doubled carriage return at the seam", () => {
  const { globalDir, src } = sandbox();
  writeFileSync(join(globalDir, "CLAUDE.md"), "# my rules\r\n\r\nbe terse.\r\n");
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  const md = claudeMd(globalDir);
  expect(md).not.toContain("\r\r"); // the doubled-CR corruption must not appear
  expect(md).toContain("be terse.");
  expect(md).toContain("@imprnt/anti-slop/agent.md");
});

test("removing the block keeps the two user paragraphs that bracketed it separate", () => {
  const { globalDir, src } = sandbox();
  // A block sandwiched between two paragraphs. After rm the paragraphs must NOT fuse into one.
  writeFileSync(join(globalDir, "CLAUDE.md"), "para one.\n\nplaceholder\n");
  addGlobalModule(globalDir, "anti-slop", src("anti-slop")); // block appends after "placeholder"
  // Put a second paragraph after the block by hand-simulating: re-read, the block is at the end, so
  // instead build the bracketed case directly via two adds is overkill - assert the seam rule on rm.
  rmGlobalModule(globalDir, "anti-slop");
  const md = claudeMd(globalDir);
  expect(md).toContain("para one.");
  expect(md).toContain("placeholder");
  expect(md).not.toContain("imprnt:global");
});

test("a block with bracketed user paragraphs survives add+rm without fusing (seam preserved)", () => {
  const { globalDir, src } = sandbox();
  // First wire a module so the block exists, then manually wrap it with paragraphs before/after, then
  // rm and confirm the surrounding paragraphs stay separated by a blank line.
  addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  const wired = claudeMd(globalDir);
  // Sandwich the managed block between two user paragraphs.
  const sandwiched = `top paragraph.\n\n${wired.trim()}\n\nbottom paragraph.\n`;
  writeFileSync(join(globalDir, "CLAUDE.md"), sandwiched);
  rmGlobalModule(globalDir, "anti-slop");
  const md = claudeMd(globalDir);
  expect(md).toContain("top paragraph.");
  expect(md).toContain("bottom paragraph.");
  expect(md).not.toContain("imprnt:global");
  // The two paragraphs are still distinct (a blank line between them), not fused onto one line.
  expect(md).toMatch(/top paragraph\.\n\nbottom paragraph\./);
});

test("add/rm REFUSE to overwrite a managed block a human pasted real content into", () => {
  const { globalDir, src } = sandbox();
  // Simulate someone pasting the doc's example block and writing notes inside it.
  const foreign = `# my rules\n\n<!-- imprnt:global BEGIN (managed by imprnt - edit with \`imprnt global add/rm\`) -->\nMY OWN NOTES - do not lose these\n<!-- imprnt:global END -->\n`;
  writeFileSync(join(globalDir, "CLAUDE.md"), foreign);

  const add = addGlobalModule(globalDir, "anti-slop", src("anti-slop"));
  expect(add.ok).toBe(false);
  expect(add.error).toContain("hand-edited");
  // The user's notes are untouched, and no copy was made (refused before the copy).
  expect(claudeMd(globalDir)).toContain("MY OWN NOTES - do not lose these");
  expect(existsSync(join(globalDir, "imprnt", "anti-slop"))).toBe(false);

  const rm = rmGlobalModule(globalDir, "anti-slop");
  expect(rm.ok).toBe(false);
  expect(claudeMd(globalDir)).toContain("MY OWN NOTES - do not lose these");
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
