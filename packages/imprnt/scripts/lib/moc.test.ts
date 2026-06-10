import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateIndex, collectNotes } from "./moc.ts";

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "imprnt-moc-"));
}

function writeNote(vault: string, folder: string, name: string, body: string): void {
  const dir = join(vault, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

// The index line a note's frontmatter should produce. We assert on this exact line for both LF and CRLF.
function indexLineFor(vault: string, slug: string): string | undefined {
  generateIndex(vault);
  const index = readFileSync(join(vault, "index.md"), "utf8");
  return index.split("\n").find((l) => l.startsWith(`- [[${slug}]]`));
}

test("LF note with summary + tags produces the right index line", () => {
  const vault = tmpVault();
  const fm = "---\ntype: person\nsummary: A short summary.\ntags: [alpha, beta]\n---\n\n# Jane Doe\n\nbody\n";
  writeNote(vault, "people", "jane.md", fm);
  const line = indexLineFor(vault, "people/jane");
  expect(line).toBe("- [[people/jane]] — A short summary.  `alpha` `beta`");
});

test("CRLF note with the same frontmatter produces the SAME index line (CRLF regression)", () => {
  const lfVault = tmpVault();
  const crlfVault = tmpVault();
  const fm = "---\ntype: person\nsummary: A short summary.\ntags: [alpha, beta]\n---\n\n# Jane Doe\n\nbody\n";
  writeNote(lfVault, "people", "jane.md", fm);
  writeNote(crlfVault, "people", "jane.md", fm.replace(/\n/g, "\r\n"));

  const lfLine = indexLineFor(lfVault, "people/jane");
  const crlfLine = indexLineFor(crlfVault, "people/jane");

  // Pre-fix the LF-only regex returns no match on CRLF, so summary/tags are empty and these diverge.
  expect(crlfLine).toBe(lfLine);
  expect(crlfLine).toContain("A short summary.");
  expect(crlfLine).toContain("`alpha` `beta`");
});

test("CRLF frontmatter summary carries no trailing carriage return", () => {
  const vault = tmpVault();
  const fm = "---\nsummary: Clean summary.\n---\n\n# Note\n".replace(/\n/g, "\r\n");
  writeNote(vault, "life", "note.md", fm);
  const note = collectNotes(vault).find((n) => n.slug === "life/note")!;
  expect(note.summary).toBe("Clean summary.");
  expect(note.summary).not.toContain("\r");
});

// A note filed at work/index.md (slug index) is genuine knowledge, not a control file. Pre-fix the
// basename "index.md" was excluded at ANY depth, so the note never appeared in the generated index.md.
// The top-level control files (index.md, hot.md, log.md, _tags.md) stay excluded and are not counted.
test("a nested control-basename note (work/index.md) is collected and listed; top-level controls are excluded", () => {
  const vault = tmpVault();
  // a real nested note whose basename collides with a control file
  writeNote(vault, "work", "index.md", "---\nsummary: Quarterly plan.\ntags: [work]\n---\n\n# Index\n\nbody\n");
  // a normal note so the folder count is meaningful
  writeNote(vault, "people", "jane.md", "---\nsummary: A person.\n---\n\n# Jane\n\nbody\n");
  // top-level control files that must NOT be collected
  writeFileSync(join(vault, "hot.md"), "---\ntype: hot\n---\n\n# Hot\n\nprimer\n");
  writeFileSync(join(vault, "log.md"), "---\ntype: log\n---\n\n# Log\n\nchronological\n");
  writeFileSync(join(vault, "_tags.md"), "---\ntype: tags\n---\n\n# tags\n");

  const slugs = collectNotes(vault).map((n) => n.slug).sort();
  expect(slugs).toEqual(["people/jane", "work/index"]);

  generateIndex(vault);
  const index = readFileSync(join(vault, "index.md"), "utf8");
  // the nested note is listed exactly once
  expect(index).toContain("- [[work/index]] — Quarterly plan.  `work`");
  // the generated index.md must not list the top-level controls or itself
  expect(index).not.toContain("[[hot]]");
  expect(index).not.toContain("[[log]]");
  expect(index).not.toContain("[[index]]");
  expect(index).not.toContain("[[_tags]]");
  // header count reflects only the two real notes
  expect(index).toContain("2 notes across 2 folders");
});

test("a note with no summary falls back to the H1 title", () => {
  const vault = tmpVault();
  const fm = "---\ntype: note\n---\n\n# My Heading\n\nbody\n";
  writeNote(vault, "life", "thing.md", fm);
  const note = collectNotes(vault).find((n) => n.slug === "life/thing")!;
  expect(note.summary).toBe("My Heading");
  const line = indexLineFor(vault, "life/thing");
  expect(line).toBe("- [[life/thing]] — My Heading");
});

// --- block-style YAML lists (what Obsidian's properties UI writes) ----------
// Pre-fix fmList only matched the inline `tags: [a, b]` form, so a block list was invisible: the note
// got flagged untagged and its tags vanished from index.md and never synced to _tags.md.

test("block-style YAML tags parse identically to the inline form (LF and CRLF)", () => {
  const lfVault = tmpVault();
  const crlfVault = tmpVault();
  const fm = "---\ntype: person\nsummary: A short summary.\ntags:\n  - alpha\n  - beta\n---\n\n# Jane Doe\n\nbody\n";
  writeNote(lfVault, "people", "jane.md", fm);
  writeNote(crlfVault, "people", "jane.md", fm.replace(/\n/g, "\r\n"));

  const lf = collectNotes(lfVault).find((n) => n.slug === "people/jane")!;
  expect(lf.tags).toEqual(["alpha", "beta"]);
  const crlf = collectNotes(crlfVault).find((n) => n.slug === "people/jane")!;
  expect(crlf.tags).toEqual(["alpha", "beta"]);

  const line = indexLineFor(lfVault, "people/jane");
  expect(line).toBe("- [[people/jane]] — A short summary.  `alpha` `beta`");
});

test("block list stops at the next key and unwraps quoted items", () => {
  const vault = tmpVault();
  const fm = "---\ntags:\n  - \"alpha\"\n  - beta\ntype: note\nsummary: S.\n---\n\n# T\n\nbody\n";
  writeNote(vault, "life", "t.md", fm);
  const note = collectNotes(vault).find((n) => n.slug === "life/t")!;
  expect(note.tags).toEqual(["alpha", "beta"]);
  // the type: line right after the block must not be swallowed into the list
  expect(note.type).toBe("note");
  expect(note.summary).toBe("S.");
});

test("a bare `tags:` with no items is an empty list, not a crash", () => {
  const vault = tmpVault();
  const fm = "---\ntags:\ntype: note\nsummary: S.\n---\n\n# T\n\nbody\n";
  writeNote(vault, "life", "t.md", fm);
  const note = collectNotes(vault).find((n) => n.slug === "life/t")!;
  expect(note.tags).toEqual([]);
  expect(note.type).toBe("note");
});

// --- symmetric quote-strip (fmScalar) ---------------------------------------
// Pre-fix the strip was `/^["']|["']$/g`: a leading quote OR a trailing quote got dropped
// independently, so a summary ENDING in a quoted phrase lost exactly one of its quotes.

test("a summary ending in a quoted phrase keeps both quotes", () => {
  const vault = tmpVault();
  const fm = '---\nsummary: Heard it from "the boss"\n---\n\n# Note\n\nbody\n';
  writeNote(vault, "life", "note.md", fm);
  const note = collectNotes(vault).find((n) => n.slug === "life/note")!;
  expect(note.summary).toBe('Heard it from "the boss"');
});

test("a summary starting with a quoted phrase keeps both quotes", () => {
  const vault = tmpVault();
  const fm = "---\nsummary: 'The boss' said so\n---\n\n# Note\n\nbody\n";
  writeNote(vault, "life", "note.md", fm);
  const note = collectNotes(vault).find((n) => n.slug === "life/note")!;
  expect(note.summary).toBe("'The boss' said so");
});

test("a fully quote-wrapped summary still unwraps", () => {
  const vault = tmpVault();
  const fm = '---\nsummary: "Wrapped value."\n---\n\n# Note\n\nbody\n';
  writeNote(vault, "life", "note.md", fm);
  const note = collectNotes(vault).find((n) => n.slug === "life/note")!;
  expect(note.summary).toBe("Wrapped value.");
});
