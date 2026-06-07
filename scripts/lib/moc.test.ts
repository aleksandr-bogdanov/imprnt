import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateIndex, collectNotes } from "./moc.ts";

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "imprint-moc-"));
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

test("a note with no summary falls back to the H1 title", () => {
  const vault = tmpVault();
  const fm = "---\ntype: note\n---\n\n# My Heading\n\nbody\n";
  writeNote(vault, "life", "thing.md", fm);
  const note = collectNotes(vault).find((n) => n.slug === "life/thing")!;
  expect(note.summary).toBe("My Heading");
  const line = indexLineFor(vault, "life/thing");
  expect(line).toBe("- [[life/thing]] — My Heading");
});
