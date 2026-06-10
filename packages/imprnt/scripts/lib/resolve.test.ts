import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { personResolved, flagNeedsReview, openNeedsReview } from "./resolve.ts";

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "imprnt-resolve-"));
}

function writePerson(vault: string, name: string, body: string): void {
  const dir = join(vault, "people");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

// --- personResolved ---

test("a person note file makes the slug resolve", () => {
  const vault = tmpVault();
  writePerson(vault, "jane.md", "---\ntype: person\n---\n\n# Jane\n");
  expect(personResolved(vault, "jane", "Jane")).toBe(true);
});

test("an LF alias resolves a differently-slugged person", () => {
  const vault = tmpVault();
  writePerson(vault, "jane.md", '---\naliases: ["Janie", "JD"]\n---\n\n# Jane\n');
  expect(personResolved(vault, "missing", "Janie")).toBe(true);
});

test("a CRLF alias still resolves (CRLF regression)", () => {
  const vault = tmpVault();
  const fm = '---\naliases: ["Janie", "JD"]\n---\n\n# Jane\n'.replace(/\n/g, "\r\n");
  writePerson(vault, "jane.md", fm);
  // Pre-fix the LF-only fence regex returns no match on CRLF, so the frontmatter (and aliases) is empty.
  expect(personResolved(vault, "missing", "Janie")).toBe(true);
});

test("an unknown name does not resolve", () => {
  const vault = tmpVault();
  writePerson(vault, "jane.md", '---\naliases: ["Janie"]\n---\n\n# Jane\n');
  expect(personResolved(vault, "missing", "Stranger")).toBe(false);
});

// --- flagNeedsReview / openNeedsReview ---

test("openNeedsReview returns nothing when the file is absent", () => {
  const vault = tmpVault();
  expect(openNeedsReview(vault)).toEqual([]);
});

test("flagNeedsReview writes an open item that openNeedsReview surfaces", () => {
  const vault = tmpVault();
  flagNeedsReview(vault, "- [ ] resolve Stranger");
  flagNeedsReview(vault, "- [x] already done");
  expect(openNeedsReview(vault)).toEqual(["- [ ] resolve Stranger"]);
});

test("openNeedsReview parses CRLF needs-review lines", () => {
  const vault = tmpVault();
  const p = join(vault, "_needs-review.md");
  writeFileSync(p, "---\r\ntype: needs-review\r\n---\r\n\r\n# Needs review\r\n\r\n- [ ] crlf item\r\n");
  expect(openNeedsReview(vault)).toEqual(["- [ ] crlf item"]);
});

// --- round-2 finding 4: flagNeedsReview must dedup. A standing conflict re-flagged on every
// --apply-all run would otherwise append an identical line forever (unbounded growth under a
// scheduled apply). The same line flagged twice yields exactly one entry.
test("flagNeedsReview does not append a duplicate of an identical existing line", () => {
  const vault = tmpVault();
  const line = "- [ ] proposed note conflicts with existing [[people/alex]]";
  flagNeedsReview(vault, line);
  flagNeedsReview(vault, line);
  expect(openNeedsReview(vault)).toEqual([line]);
});
