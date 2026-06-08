import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTags, normalize, appendTags } from "./tags.ts";

function tmpVault(tagsContent?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-tags-"));
  if (tagsContent !== undefined) writeFileSync(join(dir, "_tags.md"), tagsContent);
  return dir;
}

// --- normalize ---

test("normalize lowercases an unknown term", () => {
  const vocab = { approved: new Set<string>(), synonyms: new Map<string, string>() };
  expect(normalize(vocab, "FOO")).toBe("foo");
});

test("normalize maps a synonym to its canonical", () => {
  const vocab = { approved: new Set<string>(), synonyms: new Map([["bq", "bigquery"]]) };
  expect(normalize(vocab, "BQ")).toBe("bigquery");
});

test("normalize leaves a canonical unchanged", () => {
  const vocab = { approved: new Set(["bigquery"]), synonyms: new Map([["bq", "bigquery"]]) };
  expect(normalize(vocab, "bigquery")).toBe("bigquery");
});

// --- loadTags ---

test("loadTags parses a single-line tag list and synonyms", () => {
  const v = tmpVault("## Tags\nalpha, beta, gamma\n\n## Synonyms\na, aa -> alpha\n");
  const vocab = loadTags(v);
  expect([...vocab.approved].sort()).toEqual(["alpha", "beta", "gamma"]);
  expect(vocab.synonyms.get("a")).toBe("alpha");
  expect(vocab.synonyms.get("aa")).toBe("alpha");
  rmSync(v, { recursive: true });
});

test("loadTags ignores a prose line in the ## Tags section (BUG B)", () => {
  const v = tmpVault("## Tags\nalpha, beta\nthis is an explanatory sentence\n\n## Synonyms\n");
  const vocab = loadTags(v);
  expect([...vocab.approved].sort()).toEqual(["alpha", "beta"]);
  expect(vocab.approved.has("this is an explanatory sentence")).toBe(false);
  expect(vocab.approved.has("this")).toBe(false);
  rmSync(v, { recursive: true });
});

test("loadTags returns empty vocab when _tags.md is missing", () => {
  const v = tmpVault();
  const vocab = loadTags(v);
  expect(vocab.approved.size).toBe(0);
  expect(vocab.synonyms.size).toBe(0);
  rmSync(v, { recursive: true });
});

test("loadTags handles the shipped templates/_tags.md format", () => {
  const shipped = readFileSync(join(import.meta.dir, "../../templates/_tags.md"), "utf8");
  const v = tmpVault(shipped);
  const vocab = loadTags(v);
  expect(vocab.approved.has("identity")).toBe(true);
  expect(vocab.approved.has("finances")).toBe(true);
  expect(vocab.approved.has("projects")).toBe(true);
  expect(vocab.synonyms.get("pipeline")).toBe("etl");
  expect(vocab.synonyms.get("money")).toBe("finances");
  // The prose paragraphs above ## Tags must not leak in as tags.
  for (const t of vocab.approved) expect(t).toMatch(/^[a-z0-9-]+$/);
  rmSync(v, { recursive: true });
});

// --- appendTags ---

test("appendTags appends to a single-line tag list, preserving trailing newline", () => {
  const v = tmpVault("## Tags\nalpha, beta\n\n## Synonyms\n");
  const added = appendTags(v, ["gamma", "delta"]);
  expect(added).toEqual(["gamma", "delta"]);
  const out = readFileSync(join(v, "_tags.md"), "utf8");
  expect(out).toBe("## Tags\nalpha, beta, gamma, delta\n\n## Synonyms\n");
  rmSync(v, { recursive: true });
});

test("appendTags does not mangle a prose line in the section (BUG A)", () => {
  const prose = "explanatory line touching the list";
  const v = tmpVault(`## Tags\nalpha, beta\n${prose}\n## Synonyms\n`);
  appendTags(v, ["gamma"]);
  const out = readFileSync(join(v, "_tags.md"), "utf8");
  const lines = out.split("\n");
  // New tag lands on the tag-list line, not the prose line.
  expect(lines[1]).toBe("alpha, beta, gamma");
  // Prose line is byte-identical.
  expect(lines[2]).toBe(prose);
  rmSync(v, { recursive: true });
});

test("appendTags is a no-op when newTags is empty", () => {
  const before = "## Tags\nalpha, beta\n\n## Synonyms\n";
  const v = tmpVault(before);
  expect(appendTags(v, [])).toEqual([]);
  expect(readFileSync(join(v, "_tags.md"), "utf8")).toBe(before);
  rmSync(v, { recursive: true });
});

test("appendTags is a no-op when _tags.md is missing", () => {
  const v = tmpVault();
  expect(appendTags(v, ["gamma"])).toEqual([]);
  rmSync(v, { recursive: true });
});

test("appendTags returns the tags it added", () => {
  const v = tmpVault("## Tags\nalpha\n\n## Synonyms\n");
  expect(appendTags(v, ["beta", "gamma"])).toEqual(["beta", "gamma"]);
  rmSync(v, { recursive: true });
});
