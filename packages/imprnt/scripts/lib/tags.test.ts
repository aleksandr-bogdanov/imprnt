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

// One `imprnt check` tag-sync pass, mirroring check.ts: collect note tags through normalize,
// diff against the loaded vocabulary, append the rest. Returns the file after the pass.
function syncPass(v: string, noteTags: string[]): string {
  const vocab = loadTags(v);
  const usedCanon = new Set<string>();
  for (const t of noteTags) { const c = normalize(vocab, t); if (c) usedCanon.add(c); }
  appendTags(v, [...usedCanon].filter((c) => !vocab.approved.has(c)).sort());
  return readFileSync(join(v, "_tags.md"), "utf8");
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

// P2 #1: an underscore/space tag variant must kebab BEFORE the synonym lookup, so it still
// resolves through the map. Otherwise recall misses the canonical and check re-appends the key.
test("normalize kebabs the input before the synonym lookup (BUG: underscore/space variant)", () => {
  const vocab = { approved: new Set<string>(), synonyms: new Map([["tax-filing", "taxes"]]) };
  expect(normalize(vocab, "Tax_Filing")).toBe("taxes");
  expect(normalize(vocab, "Tax Filing")).toBe("taxes");
});

// P2 #2: normalize must resolve a synonym CHAIN to its fixed point so a note tag and a query
// keyword that enter the chain at different points meet at the same canonical.
test("normalize follows a synonym chain to its fixed point", () => {
  const vocab = { approved: new Set<string>(), synonyms: new Map([["money", "finances"], ["finances", "wealth"]]) };
  expect(normalize(vocab, "money")).toBe("wealth");
  expect(normalize(vocab, "finances")).toBe("wealth");
  expect(normalize(vocab, "money")).toBe(normalize(vocab, "finances"));
});

// P2 #2 cycle guard: a 2-cycle must terminate (not loop forever) and be deterministic.
test("normalize terminates deterministically on a synonym 2-cycle", () => {
  const vocab = { approved: new Set<string>(), synonyms: new Map([["a", "b"], ["b", "a"]]) };
  const first = normalize(vocab, "a");
  expect(["a", "b"]).toContain(first);
  expect(normalize(vocab, "a")).toBe(first); // deterministic across calls
  expect(normalize(vocab, "b")).toBe(normalize(vocab, "b"));
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

// P2: a multi-word synonym KEY written with a space (the contract's own `net worth -> finances`
// example, and the recall.ts phrase-synonym path) must resolve through normalize. loadTags stored the
// key verbatim ("net worth"), but normalize kebabs its input ("net-worth") before the lookup, so the
// space key was never hit and the synonym was dead. The fix kebabs BOTH sides of the mapping on load.
test("normalize resolves a space-keyed synonym (BUG: space key stored un-kebabed)", () => {
  const v = tmpVault("## Tags\nfinances\n\n## Synonyms\nnet worth -> finances\n");
  const vocab = loadTags(v);
  expect(normalize(vocab, "net worth")).toBe("finances");
  // The hyphen-written form of the same query must resolve to the same canonical.
  expect(normalize(vocab, "net-worth")).toBe("finances");
  expect(vocab.synonyms.get("net-worth")).toBe("finances");
  rmSync(v, { recursive: true });
});

// An underscore-keyed and a mixed-case-keyed synonym must resolve too: the key is kebabbed on load
// the same way normalize kebabs the query, so all spelling variants meet at one map entry.
test("normalize resolves underscore-keyed and mixed-case-keyed synonyms", () => {
  const v = tmpVault("## Tags\ntaxes\n\n## Synonyms\nTax_Filing -> taxes\n");
  const vocab = loadTags(v);
  expect(vocab.synonyms.get("tax-filing")).toBe("taxes");
  expect(normalize(vocab, "Tax_Filing")).toBe("taxes");
  expect(normalize(vocab, "tax filing")).toBe("taxes");
  expect(normalize(vocab, "tax-filing")).toBe("taxes");
  rmSync(v, { recursive: true });
});

// A multi-word CANONICAL value is kebabbed on load too, so the chain lands on the same token a note's
// own kebab tag would carry: nw -> "net worth" stores canonical "net-worth", and normalize follows it.
test("loadTags kebabs a multi-word canonical value", () => {
  const v = tmpVault("## Tags\nnet-worth\n\n## Synonyms\nnw -> net worth\n");
  const vocab = loadTags(v);
  expect(vocab.synonyms.get("nw")).toBe("net-worth");
  expect(normalize(vocab, "nw")).toBe("net-worth");
  rmSync(v, { recursive: true });
});

// Existing hyphen-keyed shipped synonyms (kebab("on-call") === "on-call") are unchanged by the fix.
test("loadTags leaves an already-kebabbed synonym key unchanged", () => {
  const v = tmpVault("## Tags\noncall\n\n## Synonyms\non-call, pager -> oncall\n");
  const vocab = loadTags(v);
  expect(vocab.synonyms.get("on-call")).toBe("oncall");
  expect(vocab.synonyms.get("pager")).toBe("oncall");
  expect(normalize(vocab, "on-call")).toBe("oncall");
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

// P2 #3: a prose line under ## Tags that happens to contain one kebab-valid comma segment must
// NOT be treated as the tag list. A line is a tag line only if the MAJORITY of its comma segments
// are valid tokens. Here "Keep this list lean" (invalid, interior spaces) + "one-concept" (valid)
// = 1 of 2, not a majority. The comment sits BELOW the real list as the LAST candidate line, which
// is the case that actually bites: appendTags writes to the last tag line in the section, so under
// the too-permissive "one valid token" rule the comment would be the append target and get
// corrupted. The majority rule rejects it, so the new tag lands on the real list above and the
// comment stays byte-identical.
test("appendTags skips a prose comment whose minority of segments are valid tokens (BUG: too-permissive isTagLine)", () => {
  const comment = "Keep this list lean, one-concept";
  const v = tmpVault(`## Tags\nalpha, beta\n${comment}\n\n## Synonyms\n`);
  appendTags(v, ["gamma"]);
  const lines = readFileSync(join(v, "_tags.md"), "utf8").split("\n");
  // The new tag lands on the real tag-list line, never on the prose comment below it.
  expect(lines[1]).toBe("alpha, beta, gamma");
  // The comment line is byte-identical, untouched - the new tag never appended to it.
  expect(lines[2]).toBe(comment);
  // The comment must not have swallowed the tag under any code path.
  expect(lines.some((l) => l.startsWith(comment) && l !== comment)).toBe(false);
  rmSync(v, { recursive: true });
});

// The harder placement: the prose comment is the ONLY candidate line in the section (no real tag
// list at all). Under the too-permissive rule it is the append target and gets mangled. Under the
// majority rule it is rejected, so appendTags inserts a FRESH tag line and leaves the comment alone.
test("appendTags writes a fresh line when the only candidate under ## Tags is a prose comment", () => {
  const comment = "Keep this list lean, one-concept";
  const v = tmpVault(`## Tags\n${comment}\n\n## Synonyms\n`);
  appendTags(v, ["gamma"]);
  const out = readFileSync(join(v, "_tags.md"), "utf8");
  const lines = out.split("\n");
  // The comment is never the append target: it stays byte-identical, never "...one-concept, gamma".
  expect(lines.includes(comment)).toBe(true);
  expect(lines.some((l) => l.startsWith(comment) && l !== comment)).toBe(false);
  // gamma landed on a real tag line of its own, readable back by loadTags.
  expect(loadTags(v).approved.has("gamma")).toBe(true);
  rmSync(v, { recursive: true });
});

// Round-1 salvage must survive the majority heuristic: "health, net worth, insurance" has 2 of 3
// valid segments (net worth is invalid), a majority, so it stays a tag line and salvages both.
test("loadTags still salvages a majority-valid tag line (round-1 regression guard)", () => {
  const v = tmpVault("## Tags\nhealth, net worth, insurance\n\n## Synonyms\n");
  const vocab = loadTags(v);
  expect([...vocab.approved].sort()).toEqual(["health", "insurance"]);
  rmSync(v, { recursive: true });
});

// A single valid token with no comma (the 1-of-1 majority) is a tag line: appendTags extends it.
test("appendTags treats a single bare valid token as a tag line", () => {
  const v = tmpVault("## Tags\nstandup\n\n## Synonyms\n");
  appendTags(v, ["gamma"]);
  const lines = readFileSync(join(v, "_tags.md"), "utf8").split("\n");
  expect(lines[1]).toBe("standup, gamma");
  rmSync(v, { recursive: true });
});

// A single prose phrase with no comma (0-of-1 valid, interior spaces) is NOT a tag line.
test("appendTags does not treat a single comma-less prose phrase as a tag line", () => {
  const phrase = "keep it lean";
  const v = tmpVault(`## Tags\n${phrase}\n\nalpha\n## Synonyms\n`);
  appendTags(v, ["gamma"]);
  const lines = readFileSync(join(v, "_tags.md"), "utf8").split("\n");
  expect(lines[1]).toBe(phrase); // prose phrase untouched
  expect(lines.includes("alpha, gamma")).toBe(true); // tag lands on the real list
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

// --- Unicode tags + per-token salvage + idempotent sync (P1) ---

test("appendTags + loadTags round-trip a Unicode kebab tag", () => {
  const v = tmpVault("## Tags\nhealth, insurance\n\n## Synonyms\n");
  expect(appendTags(v, ["налоги"])).toEqual(["налоги"]);
  const vocab = loadTags(v);
  expect(vocab.approved.has("налоги")).toBe(true);
  // The pre-existing tags must still load from the same line.
  expect(vocab.approved.has("health")).toBe(true);
  expect(vocab.approved.has("insurance")).toBe(true);
  rmSync(v, { recursive: true });
});

test("loadTags salvages valid tokens around invalid ones on the same line", () => {
  const v = tmpVault("## Tags\nhealth, net worth, tax_filing, insurance\n\n## Synonyms\n");
  const vocab = loadTags(v);
  expect([...vocab.approved].sort()).toEqual(["health", "insurance"]);
  rmSync(v, { recursive: true });
});

test("two consecutive sync passes over the same notes leave _tags.md byte-identical", () => {
  const v = tmpVault("## Tags\nhealth, insurance\n\n## Synonyms\n");
  const noteTags = ["налоги", "health"];
  const after1 = syncPass(v, noteTags);
  const after2 = syncPass(v, noteTags);
  expect(after2).toBe(after1);
  const vocab = loadTags(v);
  for (const t of ["health", "insurance", "налоги"]) expect(vocab.approved.has(t)).toBe(true);
  rmSync(v, { recursive: true });
});

test("appendTags kebab-normalizes an underscore tag and re-syncing it is a no-op", () => {
  const v = tmpVault("## Tags\nalpha\n\n## Synonyms\n");
  expect(appendTags(v, ["tax_filing"])).toEqual(["tax-filing"]);
  const after1 = readFileSync(join(v, "_tags.md"), "utf8");
  expect(after1).toBe("## Tags\nalpha, tax-filing\n\n## Synonyms\n");
  expect(appendTags(v, ["tax_filing"])).toEqual([]);
  expect(readFileSync(join(v, "_tags.md"), "utf8")).toBe(after1);
  rmSync(v, { recursive: true });
});

test("appendTags lowercases and hyphenates a spaced tag on write", () => {
  const v = tmpVault("## Tags\nalpha\n\n## Synonyms\n");
  expect(appendTags(v, ["Net Worth"])).toEqual(["net-worth"]);
  expect(loadTags(v).approved.has("net-worth")).toBe(true);
  rmSync(v, { recursive: true });
});

test("appendTags skips an unsalvageable tag and leaves the file untouched", () => {
  const before = "## Tags\nalpha\n\n## Synonyms\n";
  const v = tmpVault(before);
  expect(appendTags(v, ["c++"])).toEqual([]);
  expect(readFileSync(join(v, "_tags.md"), "utf8")).toBe(before);
  rmSync(v, { recursive: true });
});

test("appendTags dedupes a batch that normalizes to the same tag", () => {
  const v = tmpVault("## Tags\nalpha\n\n## Synonyms\n");
  expect(appendTags(v, ["Налоги", "налоги"])).toEqual(["налоги"]);
  expect(readFileSync(join(v, "_tags.md"), "utf8")).toBe("## Tags\nalpha, налоги\n\n## Synonyms\n");
  rmSync(v, { recursive: true });
});

// --- missing ## Tags header (P3) ---

test("appendTags creates the ## Tags section when the header is absent", () => {
  const v = tmpVault("# Tags + synonym map\n\nprose only, no sections yet\n");
  expect(appendTags(v, ["alpha"])).toEqual(["alpha"]);
  const out = readFileSync(join(v, "_tags.md"), "utf8");
  expect(out).toBe("# Tags + synonym map\n\nprose only, no sections yet\n\n## Tags\nalpha\n");
  expect(loadTags(v).approved.has("alpha")).toBe(true);
  rmSync(v, { recursive: true });
});

test("appendTags creates ## Tags without breaking an existing ## Synonyms section", () => {
  const v = tmpVault("## Synonyms\nbq -> bigquery\n");
  expect(appendTags(v, ["alpha"])).toEqual(["alpha"]);
  const out = readFileSync(join(v, "_tags.md"), "utf8");
  expect(out).toBe("## Synonyms\nbq -> bigquery\n\n## Tags\nalpha\n");
  const vocab = loadTags(v);
  expect(vocab.approved.has("alpha")).toBe(true);
  expect(vocab.synonyms.get("bq")).toBe("bigquery");
  rmSync(v, { recursive: true });
});

// --- Unicode NFC normalization (P1) ---
// An accented tag can arrive in NFD form (base letter + a combining mark, the form macOS APFS and
// many IMEs emit). The combining mark is \p{M}, which TAG_TOKEN rejects, so without NFC kebab()
// returns "" and the tag is silently dropped at sync. NFC composes "e + U+0301" into a single "é"
// codepoint so the accented tag passes TAG_TOKEN and round-trips. The recall tokenizer is NFC-
// normalized in parallel so write and read agree on one composition form for the same word.
const NFC_CAFE = "caf\u00E9";   // "cafe" + composed acute (single codepoint U+00E9)
const NFD_CAFE = "cafe\u0301"; // "cafe" + U+0301 combining acute (decomposed)

test("appendTags writes an NFD-form accented tag as its NFC form", () => {
  const v = tmpVault("## Tags\nalpha\n\n## Synonyms\n");
  // Without NFC, kebab(NFD_CAFE) is "" and appendTags drops it entirely.
  expect(appendTags(v, [NFD_CAFE])).toEqual([NFC_CAFE]);
  expect(readFileSync(join(v, "_tags.md"), "utf8")).toBe(`## Tags\nalpha, ${NFC_CAFE}\n\n## Synonyms\n`);
  rmSync(v, { recursive: true });
});

test("loadTags reads an NFD-written tag line and yields the NFC tag", () => {
  // A hand-edited line storing the decomposed form must still load as the composed tag.
  const v = tmpVault(`## Tags\nalpha, ${NFD_CAFE}\n\n## Synonyms\n`);
  const vocab = loadTags(v);
  expect(vocab.approved.has(NFC_CAFE)).toBe(true);
  expect(vocab.approved.has("alpha")).toBe(true);
  rmSync(v, { recursive: true });
});

test("appendTags + loadTags treat NFD and NFC of the same accented tag as one tag", () => {
  const v = tmpVault("## Tags\nalpha\n\n## Synonyms\n");
  expect(appendTags(v, [NFC_CAFE])).toEqual([NFC_CAFE]);
  // Re-appending the decomposed form must not write a second, byte-different entry.
  expect(appendTags(v, [NFD_CAFE])).toEqual([]);
  expect(readFileSync(join(v, "_tags.md"), "utf8")).toBe(`## Tags\nalpha, ${NFC_CAFE}\n\n## Synonyms\n`);
  rmSync(v, { recursive: true });
});

test("normalize maps an NFD-form term to an NFC synonym key", () => {
  // The synonym map is keyed on the NFC tag; an NFD query term must still hit it.
  const vocab = { approved: new Set<string>(), synonyms: new Map([[NFC_CAFE, "coffee"]]) };
  expect(normalize(vocab, NFD_CAFE)).toBe("coffee");
  rmSync(tmpVault(), { recursive: true });
});

test("normalize of an NFD term equals NFC and is itself NFC-composed", () => {
  const vocab = { approved: new Set<string>(), synonyms: new Map<string, string>() };
  const out = normalize(vocab, NFD_CAFE);
  expect(out).toBe(NFC_CAFE);
  expect(out.normalize("NFC")).toBe(out); // the returned tag is already composed
  rmSync(tmpVault(), { recursive: true });
});
