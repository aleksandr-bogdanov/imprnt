// Tests for scripts/recall.ts. recall.ts runs its CLI logic at import time (top-level), so each test
// spawns it as a subprocess with Bun.spawnSync and asserts on stdout/exit. One temp vault per test.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RECALL = join(import.meta.dir, "recall.ts");

// Spawn recall against a vault. Returns exit code + decoded stdout/stderr.
function recall(query: string, vault: string, ...extra: string[]) {
  const res = Bun.spawnSync(["bun", RECALL, query, "--vault", vault, ...extra]);
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

// Spawn recall with a raw arg vector (for malformed-flag cases).
function recallRaw(...argv: string[]) {
  const res = Bun.spawnSync(["bun", RECALL, ...argv]);
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

function newVault(): string {
  return mkdtempSync(join(tmpdir(), "recall-test-"));
}

// A minimal _tags.md carrying the shipped synonyms under test.
const TAGS_MD = `---
type: tags
---

# tags

## Tags
bigquery, insurance, harbor

## Synonyms
bq, big-query -> bigquery
rückerstattung, refund -> insurance
marina, dock -> harbor
`;

function note(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), body);
}

// --- bug 1: hyphenated synonym query reaches a note tagged with the canonical -----------------------
test("hyphenated synonym query (big-query) ranks a note tagged bigquery", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "warehouse.md", `---\ntags: [bigquery]\n---\n# Warehouse\n\nThe nightly load runs here.\n`);
  note(v, "unrelated.md", `---\ntags: [harbor]\n---\n# House\n\nA place to live.\n`);

  const r = recall("big-query", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("warehouse.md");
  expect(r.stdout).not.toContain("no matches");
});

// --- bug 2: non-ASCII query + body ------------------------------------------------------------------
test("Cyrillic query ranks a matching note (non-ASCII not dropped)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "house.md", `---\ntags: [harbor]\n---\n# Дом\n\nДом в городе Москва, старый.\n`);
  note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);

  const r = recall("Москва", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("house.md");
  expect(r.stdout).not.toContain("no matches");
});

test("German umlaut query (rückerstattung) ranks via synonym, and ß/umlaut body word is matchable", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "insurance.md", `---\ntags: [insurance]\n---\n# Versicherung\n\nDie Auszahlung ist groß.\n`);
  note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);

  // synonym key reaches the insurance-tagged note
  const bySyn = recall("rückerstattung", v);
  expect(bySyn.code).toBe(0);
  expect(bySyn.stdout).toContain("insurance.md");

  // a body word with ß tokenizes whole and is matchable
  const byBody = recall("groß", v);
  expect(byBody.code).toBe(0);
  expect(byBody.stdout).toContain("insurance.md");
});

// --- bug 3: broken symlink does not abort the walk -------------------------------------------------
test("broken symlink in vault still returns valid notes", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "real.md", `---\ntags: [harbor]\n---\n# Real\n\nHarbor content here.\n`);
  // a dangling symlink whose target does not exist - statSync would throw on it
  symlinkSync(join(v, "does-not-exist.md"), join(v, "broken.md"));

  const r = recall("harbor", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("real.md");
  expect(r.stderr).not.toContain("no vault");
});

// --- bug 4: CRLF note frontmatter parses, tags get tag-level matching ------------------------------
test("CRLF note's tags get tag-level matching", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // CRLF line endings throughout. The tag note has the term ONLY in the tag, the body note ONLY in body.
  const crlf = `---\r\ntags: [harbor]\r\n---\r\n# Some Title\r\n\r\nUnrelated prose about weather.\r\n`;
  writeFileSync(join(v, "tagged.md"), crlf);
  note(v, "bodyonly.md", `---\ntags: [bigquery]\n---\n# Title\n\nharbor appears once in body.\n`);

  const r = recall("harbor", v);
  expect(r.code).toBe(0);
  // The CRLF note matches via its tag (2x boost), proving frontmatter parsed. If frontmatter were
  // treated as body, the tag term would still appear but only at body weight - so assert it ranks
  // above the body-only note.
  expect(r.stdout).toContain("tagged.md");
  const taggedIdx = r.stdout.indexOf("tagged.md");
  const bodyIdx = r.stdout.indexOf("bodyonly.md");
  expect(taggedIdx).toBeGreaterThan(-1);
  if (bodyIdx > -1) expect(taggedIdx).toBeLessThan(bodyIdx);
});

// --- bug 5: dangling --vault ----------------------------------------------------------------------
test("dangling --vault exits 1 with a usage error and no stack trace", () => {
  const r = recallRaw("q", "--vault");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--vault");
  // a raw TypeError stack would mention these
  expect(r.stderr).not.toContain("TypeError");
  expect(r.stderr).not.toContain("at ");
});

// --- bug 6: --limit validation --------------------------------------------------------------------
test("--limit 5abc exits 1", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "a.md", `---\ntags: [harbor]\n---\n# A\n\nharbor content.\n`);

  const r = recall("harbor", v, "--limit", "5abc");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--limit");
});

test("--limit 3 still works", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  for (let i = 0; i < 5; i++) {
    note(v, `n${i}.md`, `---\ntags: [harbor]\n---\n# Note ${i}\n\nharbor content ${i}.\n`);
  }
  const r = recall("harbor", v, "--limit", "3");
  expect(r.code).toBe(0);
  const lines = r.stdout.split("\n").filter((l) => /^\s+\[\d/.test(l));
  expect(lines.length).toBe(3);
});

// --- bug 7: control basename at a nested path is a real note, not a skipped control file -----------
// A note filed at work/index.md (slug index, e.g. an H1 of "# Index" or ingest --apply with that slug)
// must be searchable. Pre-fix the basename "index.md" was excluded at ANY depth, so this note was
// silently invisible to recall. The real top-level vault/index.md stays excluded.
test("a note at a nested control basename (work/index.md) is searchable; top-level index.md is not", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  mkdirSync(join(v, "work"));
  // nested note carrying a unique term - this is a genuine note despite the index.md basename
  note(v, join("work", "index.md"), `---\ntags: []\n---\n# Index\n\nThe zzzunique term lives here.\n`);
  // the real top-level control file also carries the unique term but must never surface
  writeFileSync(join(v, "index.md"), `---\ntype: index\n---\n# Index\n\nzzzunique aggregate.\n`);

  const r = recall("zzzunique", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("work/index.md");
  expect(r.stdout).not.toContain("no matches");
  // the top-level control file is still excluded from the corpus
  const lines = r.stdout.split("\n").filter((l) => /^\s+\[\d/.test(l));
  expect(lines.some((l) => /\]\s+index\.md$/.test(l))).toBe(false);
});

// --- audit fix 1 (P0): machine path components must not be indexed --------------------------------
// Pre-fix the FULL walk path was tokenized at title weight, so a vault under .../insurance-stuff/
// made every note match "insurance" and crushed idf corpus-wide.
test("machine path components are not indexed - a path term does not match the whole vault", () => {
  const root = newVault();
  const v = join(root, "insurance-stuff", "vault");
  mkdirSync(v, { recursive: true });
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "disability.md", `---\ntags: [insurance]\n---\n# Disability Insurance\n\nThe policy covers income loss.\n`);
  note(v, "recipe.md", `---\ntags: [harbor]\n---\n# Pancakes\n\nFlour, milk, eggs.\n`);
  note(v, "garden.md", `---\ntags: [harbor]\n---\n# Garden\n\nTomatoes and beans.\n`);

  const r = recall("insurance", v);
  expect(r.code).toBe(0);
  // only the insurance note matches - pre-fix every note matched via the "insurance" path component
  expect(r.stdout).toContain("disability.md");
  expect(r.stdout).not.toContain("recipe.md");
  expect(r.stdout).not.toContain("garden.md");
  const lines = r.stdout.split("\n").filter((l) => /^\s+\[\d/.test(l));
  expect(lines[0]).toContain("disability.md");
});

test("intra-vault folder names are not a search surface, the filename stem is", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  mkdirSync(join(v, "health"));
  note(v, join("health", "wombat-protocol.md"), `---\ntags: []\n---\n# Morning Routine\n\nStretch and walk.\n`);
  note(v, "other.md", `---\ntags: []\n---\n# Health Tips\n\nSleep well.\n`);

  // the slug matches even when the term appears nowhere in the content
  const bySlug = recall("wombat", v);
  expect(bySlug.stdout).toContain("wombat-protocol.md");

  // the folder name alone does not match a note (folders are browse drawers, not the search axis)
  const byFolder = recall("health", v);
  expect(byFolder.stdout).not.toContain("wombat-protocol.md");
  expect(byFolder.stdout).toContain("other.md");
});

// --- audit fix 2 (P1): a synonym entry never worsens ranking when the query holds both terms ------
// Pre-fix the synonym group [disability, insurance] could greedily consume `insurance`, leaving the
// literal-canonical group [insurance] with nothing - a both-terms doc tied with a one-term doc.
test("query with both synonym and canonical: a both-terms doc outranks a one-term doc", () => {
  const v = newVault();
  writeFileSync(
    join(v, "_tags.md"),
    `---\ntype: tags\n---\n\n# tags\n\n## Tags\ninsurance\n\n## Synonyms\ndisability -> insurance\n`,
  );
  // both docs carry insurance in the TITLE so the synonym group prefers it over the rarer literal.
  // Names chosen so a score tie alphabetically ranks aone first - zboth must win on score.
  note(v, "zboth.md", `---\ntags: []\n---\n# Insurance Plan\n\nCovers disability income.\n`);
  note(v, "aone.md", `---\ntags: []\n---\n# Insurance Plan\n\nCovers income loss.\n`);
  // fillers raise df(disability) so idf no longer floats the literal above the canonical in-group
  for (let i = 0; i < 3; i++) {
    note(v, `filler${i}.md`, `---\ntags: []\n---\n# Filler ${i}\n\ndisability mention filler.\n`);
  }

  const r = recall("disability insurance", v);
  expect(r.code).toBe(0);
  const zi = r.stdout.indexOf("zboth.md");
  const ai = r.stdout.indexOf("aone.md");
  expect(zi).toBeGreaterThan(-1);
  expect(ai).toBeGreaterThan(-1);
  expect(zi).toBeLessThan(ai);
});

// --- audit fix 3 (P2): block-style YAML lists (Obsidian properties UI) -----------------------------
test("block-style YAML tags are indexed", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  writeFileSync(join(v, "boat.md"), `---\ntype: note\ntags:\n  - harbor\n  - boats\n---\n# Mooring\n\nNothing else here.\n`);
  note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);

  const r = recall("harbor", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("boat.md");
  expect(r.stdout).not.toContain("no matches");
});

// --- audit fix 4 (P2): a YAML comment in frontmatter is not the H1 ---------------------------------
test("a YAML comment in frontmatter does not steal the H1 title boost", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  writeFileSync(join(v, "zha.md"), `---\ntags: []\n# managed by hand\n---\n# Harbor Trip\n\nGeneric prose, nothing special.\n`);
  note(v, "abody.md", `---\ntags: []\n---\n# Generic Title\n\nWe talked about harbor once.\n`);

  // the fm comment text is not indexed at all - frontmatter is metadata, not prose
  const byComment = recall("managed", v);
  expect(byComment.stdout).toContain("no matches");

  // the real H1 keeps the title boost and outranks a body-only mention
  const r = recall("harbor", v);
  const zi = r.stdout.indexOf("zha.md");
  const ai = r.stdout.indexOf("abody.md");
  expect(zi).toBeGreaterThan(-1);
  expect(ai).toBeGreaterThan(-1);
  expect(zi).toBeLessThan(ai);
});

// --- audit fix 5 (P2): punctuation around a synonym key in the raw query ---------------------------
test("trailing punctuation on a hyphenated synonym key (big-query,) still reaches the synonym", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "warehouse.md", `---\ntags: [bigquery]\n---\n# Warehouse\n\nThe nightly load runs here.\n`);

  const r = recall("big-query,", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("warehouse.md");
  expect(r.stdout).not.toContain("no matches");
});

// --- sanity: BM25 ranking - title beats body ------------------------------------------------------
test("a term in the title outranks the same term only in the body", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "intitle.md", `---\ntags: []\n---\n# Harbor Trip\n\nGeneric prose, nothing special.\n`);
  note(v, "inbody.md", `---\ntags: []\n---\n# Generic Title\n\nWe talked about harbor once.\n`);

  const r = recall("harbor", v);
  expect(r.code).toBe(0);
  const titleIdx = r.stdout.indexOf("intitle.md");
  const bodyIdx = r.stdout.indexOf("inbody.md");
  expect(titleIdx).toBeGreaterThan(-1);
  expect(bodyIdx).toBeGreaterThan(-1);
  expect(titleIdx).toBeLessThan(bodyIdx);
});
