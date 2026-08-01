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

// --- finding 1 (P1): flush-left block-style tags (column-0 `- item`) get tag-level matching --------
// Pre-fix recall's frontmatterList required leading indent (/^\s+-\s*/), so a note tagged with
// flush-left `tags:\n- kubernetes` was reported tagged by check but NOT found by recall - the two
// core readers disagreed. moc.ts (used by check via collectNotes) already accepted flush-left items.
test("flush-left block tags get tag-level matching (recall agrees with check)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // tag note has the term ONLY in flush-left block tags, body note ONLY in body.
  writeFileSync(join(v, "tagged.md"), `---\ntype: note\ntags:\n- harbor\n- boats\n---\n# Some Title\n\nUnrelated prose about weather.\n`);
  note(v, "bodyonly.md", `---\ntags: [bigquery]\n---\n# Title\n\nharbor appears once in body.\n`);

  const r = recall("harbor", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("tagged.md");
  expect(r.stdout).not.toContain("no matches");
  // matched via the flush-left tag (2x boost) - it outranks the body-only mention.
  const taggedIdx = r.stdout.indexOf("tagged.md");
  const bodyIdx = r.stdout.indexOf("bodyonly.md");
  expect(taggedIdx).toBeGreaterThan(-1);
  if (bodyIdx > -1) expect(taggedIdx).toBeLessThan(bodyIdx);
});

test("mixed-indent block tags with an empty item are all matchable", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // flush-left, indented, an empty item (skipped), then indented again.
  writeFileSync(join(v, "mixed.md"), `---\ntype: note\ntags:\n- harbor\n  - bigquery\n-\n  - insurance\n---\n# Mixed\n\nNothing here.\n`);

  for (const term of ["harbor", "bigquery", "insurance"]) {
    const r = recall(term, v);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mixed.md");
    expect(r.stdout).not.toContain("no matches");
  }
});

// --- finding 2 (P2): a single-token synonym contributes the canonical as ONE alternative -----------
// Pre-fix, for an n=1 synonym key span.join(" ") and span.join("-") were identical, so the canonical's
// tokens were pushed TWICE as two separate additive scoring groups. A one-word query "money" then
// scored a doc the same as the two-word "money finances", double-counting an incidental mention.
test("single-token synonym does not double-count the canonical (money != money finances)", () => {
  const v = newVault();
  writeFileSync(
    join(v, "_tags.md"),
    `---\ntype: tags\n---\n\n# tags\n\n## Tags\nfinances\n\n## Synonyms\nmoney -> finances\n`,
  );
  // a doc with ONE incidental mention of each word. With money->finances, the synonym query "money"
  // must not score this the same as the explicit two-word query "money finances".
  note(v, "doc.md", `---\ntags: []\n---\n# Budget\n\nI have money saved and track finances loosely.\n`);
  // filler so idf is well-defined and df(finances) > 0 from more than one note.
  note(v, "filler.md", `---\ntags: []\n---\n# Filler\n\nfinances appear here too.\n`);

  const scoreFor = (out: string): number => {
    const line = out.split("\n").find((l) => l.includes("doc.md"));
    return line ? parseFloat(line.match(/\[(\d+\.\d+)\]/)?.[1] ?? "0") : 0;
  };
  const one = recall("money", v);
  const two = recall("money finances", v);
  expect(one.code).toBe(0);
  expect(two.code).toBe(0);
  const sOne = scoreFor(one.stdout);
  const sTwo = scoreFor(two.stdout);
  expect(sOne).toBeGreaterThan(0); // "money" still finds the doc via the canonical
  expect(sTwo).toBeGreaterThan(0);
  // the two-word query counts BOTH money(->finances) and the literal finances; the one-word query
  // counts the canonical ONCE. So the one-word score must be strictly less than the two-word score.
  expect(sOne).toBeLessThan(sTwo);
});

test("round-1 invariant holds: a both-terms doc outranks a one-term doc with a single-token synonym", () => {
  const v = newVault();
  writeFileSync(
    join(v, "_tags.md"),
    `---\ntype: tags\n---\n\n# tags\n\n## Tags\nfinances\n\n## Synonyms\nmoney -> finances\n`,
  );
  note(v, "zboth.md", `---\ntags: []\n---\n# Budget Plan\n\nI track finances and save money each month.\n`);
  note(v, "aone.md", `---\ntags: []\n---\n# Budget Plan\n\nI track finances each month.\n`);

  const r = recall("money finances", v);
  expect(r.code).toBe(0);
  const zi = r.stdout.indexOf("zboth.md");
  const ai = r.stdout.indexOf("aone.md");
  expect(zi).toBeGreaterThan(-1);
  expect(ai).toBeGreaterThan(-1);
  expect(zi).toBeLessThan(ai);
});

// --- finding 3 (P3): a UTF-8 BOM before --- does not leak frontmatter into the body ----------------
// Pre-fix a leading BOM defeated the /^---/ fence, so all frontmatter dropped to body weight and
// frontmatter-only values leaked into the searchable body.
test("a BOM-prefixed note keeps tags at tag weight; summary is indexed, other frontmatter scalars are not", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // BOM right before the fence. "harbor" is ONLY in the tag; "zzsummaryonly" is ONLY in the summary
  // scalar; "zzsourceonly" is ONLY in the source scalar. None appear in the body.
  writeFileSync(join(v, "bommed.md"), `﻿---\ntype: note\nsummary: zzsummaryonly text\nsource: "[[raw/zzsourceonly]]"\ntags: [harbor]\n---\n# Title\n\nUnrelated prose about weather.\n`);
  note(v, "bodyonly.md", `---\ntags: [bigquery]\n---\n# Title\n\nharbor appears once in body.\n`);

  // harbor matches via the BOM note's tag (2x boost) and outranks a body-only mention.
  const r = recall("harbor", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("bommed.md");
  const taggedIdx = r.stdout.indexOf("bommed.md");
  const bodyIdx = r.stdout.indexOf("bodyonly.md");
  if (bodyIdx > -1) expect(taggedIdx).toBeLessThan(bodyIdx);

  // the summary IS an indexed field now - a term only in the summary is matchable.
  expect(recall("zzsummaryonly", v).stdout).toContain("bommed.md");
  // but other frontmatter scalars (source, and metadata generally) stay out of the search corpus.
  expect(recall("zzsourceonly", v).stdout).toContain("no matches");
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

// --- round-3 finding 1 (P1): Unicode NFC/NFD normalization ----------------------------------------
// macOS APFS and many IMEs emit decomposed (NFD) text, editors and PDFs emit composed (NFC). The same
// visible accented word in the two forms is two different terms unless the tokenizer normalizes. So a
// note whose body holds "café" in one form must be found by a query typed in the other.
test("an NFC-form body word is found by an NFD-form query (and vice versa)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // "café" composed (NFC): e-with-acute is one code point.
  const nfc = "café";
  // "café" decomposed (NFD): plain e + combining acute accent.
  const nfd = "café";
  // body holds the NFC form, the query types the NFD form.
  note(v, "menu.md", `---\ntags: []\n---\n# Menu\n\nThe ${nfc} serves espresso.\n`);
  note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);

  const byNfd = recall(nfd, v);
  expect(byNfd.code).toBe(0);
  expect(byNfd.stdout).toContain("menu.md");
  expect(byNfd.stdout).not.toContain("no matches");

  // and the reverse: an NFD-form body word found by an NFC-form query.
  const v2 = newVault();
  writeFileSync(join(v2, "_tags.md"), TAGS_MD);
  note(v2, "menu.md", `---\ntags: []\n---\n# Menu\n\nThe ${nfd} serves espresso.\n`);
  note(v2, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);
  const byNfc = recall(nfc, v2);
  expect(byNfc.code).toBe(0);
  expect(byNfc.stdout).toContain("menu.md");
  expect(byNfc.stdout).not.toContain("no matches");
});

test("an NFD-form tag is matched by an NFC-form query (tokenizer agrees with the write side)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  const nfd = "café"; // decomposed tag value
  const nfc = "café"; // composed query
  // the term lives ONLY in the tag, written in NFD form (what macOS/an IME may emit).
  note(v, "tagged.md", `---\ntags: [${nfd}]\n---\n# Some Title\n\nUnrelated prose about weather.\n`);
  note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);

  const r = recall(nfc, v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("tagged.md");
  expect(r.stdout).not.toContain("no matches");
});

// --- round-3 finding 2 (P1): n-gram window must be capped so a huge query cannot OOM ---------------
// phraseSynonymTokens scanned every contiguous n-gram from full-query-length down to 2, allocating a
// slice + Set + normalize per span - uncapped, that OOM/SIGABRTs on a pasted-paragraph query. The cap
// keeps it bounded while a legitimate 2-word synonym key still expands.
test("a 2000-word query returns promptly and does not crash", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "real.md", `---\ntags: [harbor]\n---\n# Real\n\nHarbor content here.\n`);

  // 2000 distinct words plus a real term so the query is not all stopwords.
  const huge = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ") + " harbor";
  const t0 = Date.now();
  const r = recall(huge, v);
  const elapsed = Date.now() - t0;
  expect(r.code).toBe(0); // did not SIGABRT / OOM
  expect(r.stdout).toContain("real.md");
  // generous bound - the point is it completes, not that it is instant under a cold bun spawn.
  expect(elapsed).toBeLessThan(15000);
});

test("a legitimate two-word synonym key still expands after the n-gram cap", () => {
  const v = newVault();
  // Multi-word synonym keys are stored kebab/hyphenated (the shipped form: data-pipeline, on-call), so
  // a query written as two whitespace words ("on call") still reassembles to the key and expands.
  writeFileSync(
    join(v, "_tags.md"),
    `---\ntype: tags\n---\n\n# tags\n\n## Tags\noncall\n\n## Synonyms\non-call -> oncall\n`,
  );
  note(v, "rota.md", `---\ntags: [oncall]\n---\n# Rota\n\nThe pager schedule.\n`);
  note(v, "other.md", `---\ntags: []\n---\n# Other\n\nNothing relevant.\n`);

  const r = recall("on call", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("rota.md");
  expect(r.stdout).not.toContain("no matches");
});

// --- round-3 finding 3 (P2): a note symlink is indexed once, not twice ------------------------------
// The walk used statSync (which resolves symlinks), so a symlink TO a note double-indexed it (inflating
// df and listing it twice). Skipping symlinked entries keeps each note counted once.
test("a note symlink is not double-indexed", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "real.md", `---\ntags: [harbor]\n---\n# Real\n\nHarbor content here.\n`);
  // a VALID symlink pointing at the real note - statSync would index it as a second copy.
  symlinkSync(join(v, "real.md"), join(v, "alias.md"));

  const r = recall("harbor", v);
  expect(r.code).toBe(0);
  const lines = r.stdout.split("\n").filter((l) => /^\s+\[\d/.test(l));
  // exactly one result line - the real note, not its symlink copy.
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("real.md");
});

// --- round-4 finding (P1): a synonym whose CANONICAL is multi-word/kebab reaches the note ----------
// Pre-fix the per-token group at recall.ts was built as [word, normalize(word)], where normalize
// returns the canonical as ONE string ("big-query"). That single string is scored against d.tf, but
// d.tf was built by tokenize() which splits on hyphens, so a note tagged big-query has tf keys big +
// query, never the literal big-query. The canonical matched nothing and the synonym was dead. The fix
// tokenizes the canonical into the group so each of its tokens is a scorable alternative, mirroring the
// multi-word-KEY path (phraseSynonymTokens). A single-word KEY with a multi-word VALUE is the case the
// phrase path never covers (it only fires for n>=2 KEY spans).
test("a synonym with a multi-word canonical (bigquery -> big-query) finds a note tagged big-query", () => {
  const v = newVault();
  writeFileSync(
    join(v, "_tags.md"),
    `---\ntype: tags\n---\n\n# tags\n\n## Tags\nbig-query\n\n## Synonyms\nbigquery -> big-query\n`,
  );
  // the term lives ONLY in the tag, in its kebab form big-query (tf keys: big, query). The literal
  // string "bigquery" / "big-query" never appears in the title or body.
  note(v, "warehouse.md", `---\ntags: [big-query]\n---\n# Warehouse\n\nThe nightly load runs here.\n`);
  note(v, "unrelated.md", `---\ntags: [harbor]\n---\n# House\n\nA place to live.\n`);

  const r = recall("bigquery", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("warehouse.md");
  expect(r.stdout).not.toContain("no matches");
});

// guard: a single-token-canonical synonym still resolves exactly as before (no regression). The
// canonical tokenizes to one token, so the group is unchanged in effect.
test("a single-token-canonical synonym (bigquery -> oncall) still resolves", () => {
  const v = newVault();
  writeFileSync(
    join(v, "_tags.md"),
    `---\ntype: tags\n---\n\n# tags\n\n## Tags\noncall\n\n## Synonyms\nbigquery -> oncall\n`,
  );
  note(v, "rota.md", `---\ntags: [oncall]\n---\n# Rota\n\nThe pager schedule.\n`);
  note(v, "other.md", `---\ntags: [harbor]\n---\n# Other\n\nNothing relevant.\n`);

  const r = recall("bigquery", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("rota.md");
  expect(r.stdout).not.toContain("no matches");
});

// --- deep-audit finding (P1): the H1 extraction must agree with moc/check (strip code, same-line) --
// Pre-fix recall pulled the H1 with a RAW `^#\s+(.+)$` over the frontmatter-stripped body: it did NOT
// strip fenced code, so a `# shell-comment` inside a fence BEFORE the real `# Real Title` was taken as
// the title and its words landed at TITLE_BOOST. moc.ts (the index/title side, what check certifies)
// strips code first, so the two core readers disagreed on the H1 - a tag/title check certifies a title
// recall would not actually rank. The fix aligns recall on stripCode + the same-line anchor.
test("a fenced # comment before the real H1 does not steal the title boost (recall agrees with check)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // The note opens with a fenced shell block whose first line is a `# shellcomment` comment, THEN the
  // real H1. The comment word and the title word each appear ONLY in their respective surface (the
  // comment word is nowhere in the body prose, the title word is nowhere in the body prose), so the
  // band each lands in is unambiguous.
  writeFileSync(
    join(v, "fenced.md"),
    "---\ntags: []\n---\n```bash\n# zzshellcomment deploy steps\n```\n# zztruetitle Deploy Howto\n\nGeneric prose about servers.\n",
  );
  // a decoy that mentions the title word ONLY in its body, so title-boost ranking is observable.
  note(v, "decoy.md", `---\ntags: []\n---\n# Decoy\n\nWe once mentioned zztruetitle in passing.\n`);

  // the real H1 word ranks the fenced note at title boost, above the body-only decoy.
  const byTitle = recall("zztruetitle", v);
  expect(byTitle.code).toBe(0);
  expect(byTitle.stdout).toContain("fenced.md");
  const fIdx = byTitle.stdout.indexOf("fenced.md");
  const dIdx = byTitle.stdout.indexOf("decoy.md");
  expect(fIdx).toBeGreaterThan(-1);
  if (dIdx > -1) expect(fIdx).toBeLessThan(dIdx);

  // the fenced `# shellcomment` is code, not the H1: its word is NOT on the title surface. (The body
  // is code-blanked into the index? No - recall DOES index the raw body, so the comment word may still
  // appear at body weight. The invariant under test is that it is not the TITLE.) To prove it is not at
  // title boost, give a sibling note that carries the SAME word in its real H1: that note must outrank
  // the fenced note for the shellcomment word.
  note(v, "hastitle.md", `---\ntags: []\n---\n# zzshellcomment\n\nNothing else here.\n`);
  const byComment = recall("zzshellcomment", v);
  expect(byComment.code).toBe(0);
  const hIdx = byComment.stdout.indexOf("hastitle.md");
  const fcIdx = byComment.stdout.indexOf("fenced.md");
  expect(hIdx).toBeGreaterThan(-1);
  // the note with the word in its TRUE H1 outranks the fenced note (where it is body-only code).
  if (fcIdx > -1) expect(hIdx).toBeLessThan(fcIdx);
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

// --- deep-audit finding (P2): content nouns must not be stopworded away ----------------------------
// The stopword set over-reached into CONTENT NOUNS (status, timeline, period, decision, plan, info,
// details, current, latest, notes). The vault contract treats these as first-class - projects carry a
// `status`, the contract says "pull decisions/actions". When such a word is the DISCRIMINATING term in
// a query, dropping it leaves only the common term, and BM25 length-norm then sinks the real answer.
// Pre-fix: 5 generic "cache" notes + 1 longer "cache decision" note, query "cache decision" expands to
// just [cache] (decision dropped), so the decision note - the longest - ranks LAST. idf already
// de-weights a common term, so keeping "decision" in the query costs almost nothing and lifts the right
// note. The matching note must rank #1 (the term carries the signal).
test("a content-noun query term (decision) is not stopworded; the matching note ranks first", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // 5 short generic notes carrying the COMMON term only.
  for (let i = 0; i < 5; i++) {
    note(v, `cache${i}.md`, `---\ntags: []\n---\n# Cache ${i}\n\ncache here.\n`);
  }
  // the answer: it has the discriminating word "decision" AND is the LONGEST note, so length-norm
  // would bury it if "decision" were dropped and only the common "cache" survived.
  note(
    v,
    "decision.md",
    `---\ntags: []\n---\n# Cache Strategy\n\nThe cache strategy goes into depth about caching across layers and tiers and edge conditions and invalidation and eviction and warmup and metrics. The decision about which approach to take is recorded here with rationale and tradeoffs at length.\n`,
  );

  const r = recall("cache decision", v);
  expect(r.code).toBe(0);
  // "decision" must survive as a query term and lift the only note that carries it to the top.
  const lines = r.stdout.split("\n").filter((l) => /^\s+\[\d/.test(l));
  expect(lines[0]).toContain("decision.md");
});

// guard: with "decision" pruned from STOPWORDS, a sensible sentence query whose discriminating word is
// a FORMER stopword content noun ("status") still works - the content word does the ranking.
test("a sentence query keyed on a former-stopword content noun (status) ranks the matching note", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  note(v, "rollout.md", `---\ntags: []\n---\n# Rollout Status\n\nThe rollout status is green and shipping.\n`);
  note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);

  const r = recall("what is the status of the rollout", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("rollout.md");
  expect(r.stdout).not.toContain("no matches");
});

// guard: the all-glue-words fallback still triggers. A query of ONLY true sentence-glue (no content
// term survives the stopword filter) must keep the originals rather than empty out, so recall still runs
// instead of dying with "empty query". The glue terms then match notes that contain them.
test("an all-glue-words query keeps its originals (fallback still fires)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // a note whose body holds the glue words so the fallback has something to match.
  note(v, "glue.md", `---\ntags: []\n---\n# What\n\nwhat do i know about the of.\n`);

  const r = recall("what do i know about", v);
  expect(r.code).toBe(0);
  // it did not exit 1 with "empty query after tokenizing", and it found the note via the kept glue terms.
  expect(r.stderr).not.toContain("empty query");
  expect(r.stdout).toContain("glue.md");
  expect(r.stdout).not.toContain("no matches");
});

// --- deep-audit finding (P3): the STOPWORDS set must be a COMPLETE function-word list --------------
// The old set listed only a few prepositions (on, of, to, for, in) and was MISSING common glue its own
// comment claimed it covered: with, from, by, at, as, the be/are/was forms, and the pronouns it/you/we/
// they/this/that/these/those. On a small vault idf does NOT de-weight glue (df can tie a preposition
// with a content noun, so idf is equal), so a query's lone surviving "with" drove ranking and returned
// a wrong top hit. The fix replaces the ad-hoc list with a complete canonical function-word set.

// The exact repro: a sentence query whose only NON-content word that used to survive the filter is a
// preposition ("with"). A red-herring note carries "with" (zero topical relevance), the real answer
// carries the content noun ("doctor"). Pre-fix "with" survived and floated the red herring to #1.
// Post-fix "with" drops, so the red herring no longer scores and the content note alone ranks.
test("a sentence query no longer ranks by a leftover preposition (with)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // the red herring: it holds "with" several times but nothing the query is actually about.
  note(v, "redherring.md", `---\ntags: []\n---\n# Cooking Notes\n\nServe with rice, with sauce, with greens, with bread.\n`);
  // the real answer: it carries the discriminating content noun "doctor".
  note(v, "answer.md", `---\ntags: []\n---\n# My Doctor\n\nThe doctor visit notes live here.\n`);

  const r = recall("what should I check with my doctor", v);
  expect(r.code).toBe(0);
  const lines = r.stdout.split("\n").filter((l) => /^\s+\[\d/.test(l));
  // the content note ranks first - "with" no longer carries the score.
  expect(lines[0]).toContain("answer.md");
  // the red herring (only "with") does not appear at all: every term it could match is now a stopword.
  expect(r.stdout).not.toContain("redherring.md");
});

// the honest no-match: when a sentence's only matching tokens are glue, dropping the glue leaves no
// content term to score, so recall returns no-match (the truthful answer) instead of a false hit ranked
// by the lone preposition. Pre-fix the surviving "with" produced a wrong top hit here.
test("a query whose only vault-present tokens are glue returns no-match, not a false hit", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // the note holds the glue word "with" but none of the content words in the query.
  note(v, "redherring.md", `---\ntags: []\n---\n# Cooking Notes\n\nServe with rice and with greens.\n`);

  const r = recall("what mistakes did I make with taxes", v);
  expect(r.code).toBe(0);
  // no content term (mistakes/make/taxes) appears in the note, and "with"/"did" are now glue, so the
  // honest result is no-match rather than the red herring ranked by its lone "with".
  expect(r.stdout).toContain("no matches");
  expect(r.stdout).not.toContain("redherring.md");
});

// each newly-added glue word is actually dropped from the query: a note that ONLY contains the glue word
// must not surface when that word rides in a sentence alongside a content term. Run one note per glue
// word so a regression on any single addition is pinpointed.
test("each newly-added glue word is dropped (a glue-only note does not surface)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // the content target the query is really about.
  note(v, "answer.md", `---\ntags: []\n---\n# Harbor Plan\n\nThe harbor plan lives here.\n`);
  // words added to STOPWORDS in this round that were absent before (sample across the categories).
  const added = ["with", "from", "by", "at", "as", "are", "was", "were", "be",
    "it", "you", "your", "we", "they", "this", "that", "these", "those", "did", "has", "have"];
  for (const w of added) {
    note(v, `glue-${w}.md`, `---\ntags: []\n---\n# Glue ${w}\n\nThe word ${w} appears ${w} ${w} here.\n`);
    const r = recall(`tell me ${w} the harbor`, v);
    expect(r.code).toBe(0);
    // the content note wins and the glue-only note never surfaces - proof the word is a stopword.
    expect(r.stdout).toContain("answer.md");
    expect(r.stdout).not.toContain(`glue-${w}.md`);
  }
});

// guard: the round-8 content nouns must STAY out of STOPWORDS. Each is the discriminating term in a
// sentence query and must rank its note. (The "decision" and "status" guards above cover two; this
// sweeps the rest so no future tidy re-adds one.)
test("round-8 content nouns are not stopworded (timeline/period/plan/info/details/current/latest/notes)", () => {
  for (const noun of ["timeline", "period", "plan", "info", "details", "current", "latest", "notes"]) {
    const v = newVault();
    writeFileSync(join(v, "_tags.md"), TAGS_MD);
    note(v, "answer.md", `---\ntags: []\n---\n# Project ${noun}\n\nThe ${noun} for the rollout is recorded here.\n`);
    note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);

    const r = recall(`what is the ${noun} of the rollout`, v);
    expect(r.code).toBe(0);
    // the content noun survives the filter and ranks its note.
    expect(r.stdout).toContain("answer.md");
    expect(r.stdout).not.toContain("no matches");
  }
});

// --- deep-audit finding (P2): apostrophes inside a word are stripped, not split ---------------------
// The tokenizer split on every non-letter/number, so an apostrophe was a word boundary: don't -> [don,
// t], Elena's -> [elena, s], we're -> [we, re]. The 1-2 letter remnants (s, t, m, re, ll, ve, d) are
// not stopwords, so they indexed notes AND survived in queries, polluting BM25: a possessive query
// injected a phantom term that matched every note carrying any OTHER possessive. The fix strips the
// apostrophe inside a word before splitting, on the single tokenize entry point, so the index and the
// query stay identical. Both the straight ' (U+0027) and the curly ' (U+2019) are handled.

// the exact repro: a possessive query must not inject a phantom remnant that pulls in an unrelated note
// ranked purely on its own possessives. A query with the apostrophe stripped must rank the same notes as
// the same query written without the apostrophe (only the real content terms drive the score).
test("a possessive query does not inject a phantom remnant (Sam's vs Sam ranks the same notes)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // the answer carries the content term "doctor". The decoy carries NO content term the query is about,
  // only its own possessive ("Lena's"), so a phantom "s" from the query would be the only thing pulling
  // it in.
  note(v, "answer.md", `---\ntags: []\n---\n# Doctor Visit\n\nNotes from the doctor appointment.\n`);
  note(v, "decoy.md", `---\ntags: []\n---\n# Schedule\n\nLena's calendar and the team's rota.\n`);

  // possessive form and plain form must agree: same matched notes, decoy excluded both ways.
  const poss = recall("Sam's doctor", v);
  const plain = recall("Sam doctor", v);
  expect(poss.code).toBe(0);
  expect(plain.code).toBe(0);
  // the decoy (matched only by a phantom "s") must NOT appear in the possessive query.
  expect(poss.stdout).not.toContain("decoy.md");
  // the possessive query's matched note set equals the plain query's.
  const matched = (out: string) =>
    out.split("\n").filter((l) => /^\s+\[\d/.test(l)).map((l) => l.replace(/^\s+\[[\d.]+\]\s+/, "")).sort();
  expect(matched(poss.stdout)).toEqual(matched(plain.stdout));
});

// a lone possessive/contraction remnant must not be a search term at all - "s" or "don't" stripped to a
// non-content shape must not match notes purely on the apostrophe-remnant their prose carries.
test("a lone possessive remnant (s) does not match notes on their possessives", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // both notes carry possessives; pre-fix `recall "s"` matched them on the phantom remnant.
  note(v, "a.md", `---\ntags: []\n---\n# A\n\nSam's plan and Jonas's notes.\n`);
  note(v, "b.md", `---\ntags: []\n---\n# B\n\nElena's books.\n`);

  const r = recall("s", v);
  expect(r.code).toBe(0);
  // "s" is not a real term in any note once apostrophes are stripped, so nothing matches on it.
  expect(r.stdout).toContain("no matches");
  expect(r.stdout).not.toContain("a.md");
  expect(r.stdout).not.toContain("b.md");
});

// index and query agree: a body word written with an apostrophe is found by a query without it, and the
// reverse. Stripping (don't -> dont) is applied identically on both sides, so "dont" and "don't" are the
// same term.
test("a contraction in a note (don't) is found by a query without the apostrophe (dont), and vice versa", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // unique terms so the match is unambiguous. One note holds the apostrophe form, the other the plain.
  note(v, "withapos.md", `---\ntags: []\n---\n# Rule\n\nwe zzdon't ship on fridays.\n`);
  note(v, "noapos.md", `---\ntags: []\n---\n# Rule Two\n\nwe zzwont ship on fridays.\n`);

  // body has the apostrophe form, query has the plain form.
  const byPlain = recall("zzdont", v);
  expect(byPlain.code).toBe(0);
  expect(byPlain.stdout).toContain("withapos.md");
  expect(byPlain.stdout).not.toContain("no matches");

  // body has the plain form, query has the apostrophe form - both strip to the same term.
  const byApos = recall("zzwon't", v);
  expect(byApos.code).toBe(0);
  expect(byApos.stdout).toContain("noapos.md");
  expect(byApos.stdout).not.toContain("no matches");
});

// the curly right single quote (U+2019, what macOS/iOS and word processors autoinsert) must tokenize
// identically to the straight ASCII apostrophe, so a note authored in either form is found by a query in
// either form.
test("a curly-apostrophe word (Elena’s) tokenizes the same as the straight form", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // the note's body uses the CURLY apostrophe (U+2019). A unique stem proves the strip composed.
  note(v, "curly.md", `---\ntags: []\n---\n# Curly\n\nzzelena’s reading list.\n`);
  note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant.\n`);

  // straight-apostrophe query reaches the curly-apostrophe note.
  const straight = recall("zzelena's", v);
  expect(straight.code).toBe(0);
  expect(straight.stdout).toContain("curly.md");
  expect(straight.stdout).not.toContain("no matches");

  // curly-apostrophe query reaches it too (both forms strip to zzelenas).
  const curly = recall("zzelena’s", v);
  expect(curly.code).toBe(0);
  expect(curly.stdout).toContain("curly.md");
  expect(curly.stdout).not.toContain("no matches");

  // and a no-apostrophe query for the same stem also matches - the strip joined the pieces.
  const bare = recall("zzelenas", v);
  expect(bare.code).toBe(0);
  expect(bare.stdout).toContain("curly.md");
});

// --- the summary field is indexed (the role-word fix) -----------------------------------------------
// A note's defining role word often lives ONLY in its curated `summary` (an entity note: "Dr. Costa,
// Sam's primary care doctor"), while the body never restates it. Before summary was indexed, a query
// for that word ("doctor") missed the entity note entirely and surfaced a HUB note that merely links
// it ("Primary doctor is [[people/dr-costa]]"). recall now indexes `summary` at body weight, so the
// word is matchable on the note that IS about it. Parsed with fmScalar, the same reader check uses to
// build index.md - the field the write side displays is the field recall searches. (On the real
// example vault this flips "who is my doctor" from the hub note to the doctor's own note; in a unit
// vault the rank also turns on note length, so the robust invariant to guard here is findability.)
test("a term that appears only in the summary is matchable (the summary is indexed)", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // The entity note carries "zzphysician" ONLY in its summary (not the title, tags, or body).
  note(v, "entity.md", `---\ntags: []\nsummary: "Dr Vale, the family zzphysician."\n---\n# Dr Vale\n\nWorks downtown, weekdays only.\n`);
  note(v, "other.md", `---\ntags: [bigquery]\n---\n# Other\n\nNothing relevant here.\n`);

  const r = recall("zzphysician", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("entity.md");    // found via the summary alone
  expect(r.stdout).not.toContain("no matches");
  expect(r.stdout).not.toContain("other.md"); // a note without the term still does not match
});

// ── --gap: cut where the scores fall off a cliff ────────────────────────────────
// Default-off, so every existing expectation above still describes shipped behaviour.

test("--gap trims hits below the ratio, keeping the ones above the cliff", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  // three notes that hit the query hard, one that grazes it once in a long body
  writeFileSync(join(v, "a.md"), "---\ntype: note\ntags: []\n---\n\n# Kestrel\n\nkestrel kestrel kestrel");
  writeFileSync(join(v, "b.md"), "---\ntype: note\ntags: []\n---\n\n# Kestrel again\n\nkestrel kestrel");
  writeFileSync(join(v, "c.md"), "---\ntype: note\ntags: []\n---\n\n# Kestrel once\n\nkestrel");
  writeFileSync(
    join(v, "far.md"),
    "---\ntype: note\ntags: []\n---\n\n# Unrelated\n\n" + "filler ".repeat(400) + "kestrel",
  );

  const all = recall("kestrel", v);
  expect(all.code).toBe(0);
  expect(all.stdout).toContain("far.md");

  const cut = recall("kestrel", v, "--gap", "0.5");
  expect(cut.code).toBe(0);
  // the long note's score is a fraction of the others', so the cliff drops it
  expect(cut.stdout).not.toContain("far.md");
  expect(cut.stdout).toContain("a.md");
});

test("--gap never cuts the top hit", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  writeFileSync(join(v, "one.md"), "---\ntype: note\ntags: []\n---\n\n# Only\n\npetrichor");
  writeFileSync(join(v, "two.md"), "---\ntype: note\ntags: []\n---\n\n# Other\n\n" + "x ".repeat(500) + "petrichor");
  const r = recall("petrichor", v, "--gap", "0.99");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("one.md");
});

test("--gap rejects a non-ratio value", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  writeFileSync(join(v, "a.md"), "---\ntype: note\ntags: []\n---\n\n# A\n\nkestrel");
  for (const bad of ["1", "0", "abc", "0.5x", "-0.2", "2.0"]) {
    const r = recallRaw("kestrel", "--vault", v, "--gap", bad);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--gap must be a ratio");
  }
  const missing = recallRaw("kestrel", "--vault", v, "--gap");
  expect(missing.code).toBe(1);
});

test("without --gap the result set is unchanged", () => {
  const v = newVault();
  writeFileSync(join(v, "_tags.md"), TAGS_MD);
  writeFileSync(join(v, "a.md"), "---\ntype: note\ntags: []\n---\n\n# A\n\nkestrel kestrel");
  writeFileSync(join(v, "b.md"), "---\ntype: note\ntags: []\n---\n\n# B\n\n" + "y ".repeat(400) + "kestrel");
  const r = recall("kestrel", v);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("a.md");
  expect(r.stdout).toContain("b.md");
});
