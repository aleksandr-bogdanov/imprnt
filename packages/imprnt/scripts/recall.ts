#!/usr/bin/env bun
// imprnt recall "<query>" [--vault DIR] [--limit N]
//
// Ranked retrieval over the vault using real BM25 — deterministic, local, zero LLM, zero deps.
// This is the CHEAP/DUMB default ranker, on purpose: the READ path runs thousands of times, so it
// must be free. BM25 is pure local arithmetic (term frequencies + inverse document frequency), so it
// is CORE, not an opt-in. The job is to NARROW 1000s of notes to a tight ranked set (~top 15) the LLM
// then reads — never to return most of the vault, never an MCP/embedding/vector index.
//
// Scoring (standard BM25 with field boosts):
//   - Each note is tokenized into terms (lowercased, split on non Unicode-letter/number characters).
//   - A term's occurrences in the TITLE/aliases count 3x, in TAGS 2x, in BODY 1x — folded into the
//     term frequency, so "harbor" in a title outweighs "harbor" buried in prose. One BM25 pass.
//   - idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5));  k1 = 1.5, b = 0.75.
//   - score = Σ_query-terms idf(t) * (tf*(k1+1)) / (tf + k1*(1 - b + b*dl/avgdl)).
//   - idf subsumes the old df-weighting (a rare matched term scores; a common one barely moves the
//     total) and additive term scoring subsumes the old partial-coverage fallback (one matched term
//     still scores — no false "no matches"). No AND gate, no bespoke tiers.
// Query terms are expanded through _tags.md (synonym -> canonical) and treated as alternatives; the
// best-scoring variant of each query term contributes. Lean conversational stopwords are dropped.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { loadTags, normalize, type TagVocab } from "./lib/tags.ts";
// The frontmatter list parser + BOM strip are CORE and shared with moc.ts (which check.ts/ingest.ts
// build on), so the write side (check certifies a tag) and the read side (recall finds it) parse the
// SAME note identically. Both files are core - the copy-don't-share rule is for plugins only.
import { fmList, stripBom } from "./lib/moc.ts";

const args = process.argv.slice(2);
let vault = process.env.IMPRNT_VAULT ?? process.env.IMPRINT_VAULT ?? "./vault";
let limit = 15; // tight by default — narrow, don't dump
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") {
    const v = args[++i];
    if (v === undefined) { console.error("--vault requires a directory argument"); process.exit(1); }
    vault = v;
  }
  else if (args[i] === "--limit") {
    const tok = args[++i];
    // Reject a missing value or trailing garbage (parseInt would silently accept "5abc"). The whole
    // token must be a positive integer.
    if (tok === undefined || !/^[0-9]+$/.test(tok)) { console.error("--limit must be a positive integer"); process.exit(1); }
    const n = parseInt(tok, 10);
    if (!Number.isFinite(n) || n <= 0) { console.error("--limit must be a positive integer"); process.exit(1); }
    limit = n;
  } else positional.push(args[i]);
}
const query = positional.join(" ").trim();
if (!query) {
  console.error('usage: imprnt recall "<query>" [--vault DIR] [--limit N]');
  process.exit(1);
}

const vocab = loadTags(vault);

// Longest synonym KEY in word count, computed once from the loaded map. phraseSynonymTokens only ever
// matches a key, so scanning n-grams longer than this can never hit one - they are pure wasted work.
// Capping the n-gram window here keeps a pasted-paragraph query (hundreds/thousands of words) from
// allocating a slice + Set + normalize per span, which is O(words^2) spans and OOM-crashes the read
// path. A floor of 1 keeps the loop well-formed when the vocab has no multi-word keys. The synonym map
// shape is `synonyms: Map<alias, canonical>`; the keys are the aliases we match against.
const MAX_SYNONYM_NGRAM = Math.max(
  1,
  ...[...vocab.synonyms.keys()].map((k) => k.trim().split(/[\s-]+/).filter(Boolean).length),
);

// Conversational stopwords. The pitch is "you talk in plain language, the agent searches underneath" —
// a query is a SENTENCE ("what do I believe about money"), not keywords. These words are sentence glue
// that appear everywhere and discriminate nothing, so they only add noise to BM25. Kept lean and we
// never strip a query to nothing — if every term is a stopword we keep the originals.
//
// This is a COMPLETE canonical English function-word set (the standard ~50 closed-class glue words),
// not a reactive hand-tweak. Two failure modes are in tension and the resolution is asymmetric:
//   - A MISSING glue word only slightly dilutes ranking. On a small vault idf does NOT de-weight glue
//     (a corpus of N notes can have df("with") == df("doctor"), so idf is equal), and then a query's
//     lone surviving preposition drives the whole score and returns a wrong top hit. So the set must be
//     complete enough that a normal sentence leaves only content terms.
//   - A wrongly-INCLUDED content word silently DROPS the answer: dropped from the query, it can no
//     longer rank the one note that carries it. This is the worse failure.
// So the rule is: ONLY pure function/glue words go here - articles, pronouns (subject/object/possessive),
// prepositions, conjunctions, auxiliary/modal verbs, the be/have/do forms, and the common question words,
// plus the question-framing mental verbs (think/know/believe). CONTENT NOUNS stay OUT - the contract
// treats status/timeline/decision/plan/etc. as first-class (projects carry a `status`, the contract says
// "pull decisions/actions"), so dropping one would sink the right note. If a word could plausibly be a
// vault search term (a noun/verb/adjective with topical meaning), it is NOT a stopword. When in doubt,
// leave it OUT.
const STOPWORDS = new Set([
  // question words
  "what", "where", "how", "when", "which", "who", "whom", "whose", "why",
  // articles + determiners
  "a", "an", "the", "this", "that", "these", "those",
  // pronouns: subject / object / possessive
  "i", "me", "my", "mine", "myself",
  "we", "us", "our", "ours",
  "you", "your", "yours",
  "he", "him", "his",
  "she", "her", "hers",
  "it", "its",
  "they", "them", "their", "theirs",
  // conjunctions
  "and", "or", "but", "nor", "so", "than", "if", "then",
  // prepositions
  "of", "to", "in", "on", "for", "with", "from", "by", "at", "as",
  "into", "onto", "about", "over", "under", "between", "through",
  // be / have / do forms (auxiliaries)
  "be", "am", "is", "are", "was", "were", "been", "being",
  "have", "has", "had",
  "do", "does", "did", "done",
  // modals
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  // common adverbial glue
  "not", "no", "yes", "there", "here",
  // question-framing mental verbs (the assistant's "what do I think/know/believe about ...")
  "think", "know", "believe",
]);

// Tokenize on Unicode letters and numbers so non-ASCII content (Cyrillic, German umlauts, ß) tokenizes
// to whole words instead of being stripped. The same tokenizer runs on both the query and the note
// body/title/tags so the write and read sides agree on word boundaries. Lowercasing is locale-agnostic.
// NFC-normalize before tokenizing so the same visible accented word agrees regardless of composition
// form. macOS APFS and many IMEs emit decomposed (NFD: e + U+0301), editors and PDFs emit composed
// (NFC: the single "é" codepoint). Without this the query and the indexed text would split into two
// different terms, and an NFD-form word loses its accent to the `\p{N}/\p{L}` split (the bare combining
// mark is dropped). NFC matches the write side: tags.ts kebab also NFC-composes, so a tag check
// certifies is a tag recall finds.
const tokenize = (text: string): string[] =>
  text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// A MULTI-token or hyphenated synonym key (`big-query`, `on-call`, `net worth`) is split into pieces
// by the alnum/Unicode tokenizer, so `big-query` would never reach the `big-query -> bigquery` synonym
// via per-token normalize. To make those keys reachable, scan the raw whitespace-split query for any
// MULTI-word synonym key (adjacent n-grams, n >= 2) and contribute the canonical's TOKENS as extra
// query terms. SINGLE-token keys are deliberately NOT handled here: the per-token group below already
// carries `[word, normalize(word)]`, so the canonical is one alternative WITHIN the word's group. If
// this added a single-token canonical as its own group too, a one-word synonym query ("money" ->
// finances) would score the canonical in a separate additive group AND the word in its own group,
// double-counting and tying a one-word query with the explicit two-word query.
//   Returns the tokenized canonicals discovered from multi-token/hyphenated synonym keys.
const phraseSynonymTokens = (q: string): string[] => {
  const out: string[] = [];
  // Atomize the query the way the tokenizer would: split on whitespace AND hyphens (and strip any
  // other punctuation off the edges), so "big-query" becomes the atoms [big, query] - the n-gram
  // base. This is what lets a hyphenated key written as one whitespace-word still be reassembled and
  // matched below (joined back by both hyphen and space).
  // NFC-normalize the same way tokenize does, so an NFD-form multi-word query reassembles to the key.
  const words = q.normalize("NFC").toLowerCase().split(/[\s-]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  // Try contiguous n-grams from the longest synonym KEY width down to PAIRS (n >= 2), joined by both
  // space and hyphen (a key may be written either way). A hit maps to its canonical, which we then
  // tokenize. Capping at MAX_SYNONYM_NGRAM (not words.length) is what keeps a pasted-paragraph query
  // bounded - a span longer than the longest key can never match one, so scanning it is wasted O(n^2)
  // work that OOMs the read path.
  for (let n = Math.min(words.length, MAX_SYNONYM_NGRAM); n >= 2; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const span = words.slice(i, i + n);
      for (const key of new Set([span.join(" "), span.join("-")])) {
        const canon = normalize(vocab, key);
        if (canon !== key) out.push(...tokenize(canon));
      }
    }
  }
  return out;
};

// Each query word -> a group of acceptable variants {word, canonical tag}. The best-scoring variant of
// each group contributes to the note's score (OR within a group, additive across groups). Stopwords are
// dropped from the query terms; if that empties the query we keep the originals.
const rawTerms = tokenize(query);
const contentTerms = rawTerms.filter((w) => !STOPWORDS.has(w));
const baseTerms = contentTerms.length ? contentTerms : rawTerms;
// Tokenize the canonical into the group, not keep it whole. normalize() returns the canonical as ONE
// string, but a MULTI-word canonical ("big-query", "net worth") is stored on a note as the kebab tag,
// whose tf keys are the SPLIT tokens (big, query) - the tokenizer splits on hyphens AND spaces. Scoring
// the whole "big-query" string would match nothing. Each canonical token becomes its own scorable
// alternative within the word's group, mirroring the multi-word-KEY path (phraseSynonymTokens). A
// single-token canonical tokenizes to one token, so the group is unchanged. The Set dedups the literal
// against a same-spelling canonical token.
const queryTerms = baseTerms.map((w) => [...new Set([w, ...tokenize(normalize(vocab, w))])]);
// Add a group per token discovered from a multi-token/hyphenated synonym key. Each canonical token is
// its own group so it scores additively alongside the literal query terms.
for (const t of phraseSynonymTokens(query)) {
  if (!STOPWORDS.has(t)) queryTerms.push([t]);
}
if (!queryTerms.length) { console.error("empty query after tokenizing"); process.exit(1); }

// Generated/control files are NOT part of the search corpus: index.md aggregates every note's summary
// + tags, so leaving it in would flood every query (it matches almost everything); log.md and hot.md
// are chronological/primer surfaces, not knowledge. `_`-prefixed (_tags, _needs-review) already skipped.
// Control files are anchored to the vault ROOT only - a real note filed at any nested path like
// work/index.md keeps the basename of a control file but is genuine knowledge, so it must be searched.
// We exclude a file only when its path relative to the vault root has no directory component and equals
// one of these basenames (depth 0). raw/ is dropped wholesale - raw snapshots are not the search corpus.
const CONTROL = new Set(["index.md", "hot.md", "log.md", "_tags.md"]);
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const p = join(dir, entry);
    // A control basename counts only at the vault root - relative path with no directory separator.
    const rel = relative(vault, p);
    if (!rel.includes("/") && !rel.includes("\\") && CONTROL.has(rel)) continue;
    // Be tolerant per entry. A broken symlink or otherwise unreadable entry makes lstatSync/readdir throw.
    // Skip just that entry so one bad node never aborts the whole walk or hides a populated vault.
    try {
      // lstatSync does NOT resolve a symlink, so we can detect and SKIP one. A file symlink to a note
      // would otherwise index the note twice (inflating df, listing it twice); a directory symlink can
      // form a cycle that recurses until the OS errors. Skip every symlink - a note's canonical path is
      // walked directly. (ingest's snapshot walk defends the same way.)
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) out.push(...walk(p));
      else if (entry.endsWith(".md")) out.push(p);
    } catch { continue; }
  }
  return out;
}

let files: string[] = [];
try { files = walk(vault); } catch { console.error(`no vault at ${vault} — run \`imprnt init\` first`); process.exit(1); }

// Field boosts. A term in the title/aliases is a stronger signal that the note IS about the query than
// the same term in tags, which is stronger than an incidental body mention. We fold these into the term
// frequency so one weighted BM25 pass captures all three.
const TITLE_BOOST = 3;
const TAG_BOOST = 2;
const BODY_BOOST = 1;

// --- pass 1: read + tokenize every note once; build weighted term frequencies + doc lengths ----------
type Doc = { path: string; tf: Map<string, number>; len: number };
const docs: Doc[] = [];
const df = new Map<string, number>(); // document frequency: how many notes contain each term

for (const path of files) {
  // Strip a leading UTF-8 BOM (shared with moc.ts) so a BOM-prefixed note's fence still matches -
  // otherwise all frontmatter drops to body weight and leaks frontmatter values into the body.
  const raw = stripBom(readFileSync(path, "utf8"));
  // Accept CRLF (`\r\n`) fences so Windows-authored notes parse frontmatter. Without `\r?` the closing
  // `---\r` line never matches and the whole frontmatter falls through to the body, losing tag boosts.
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = fmMatch?.[1] ?? "";
  const body = fmMatch ? raw.slice(fmMatch.index! + fmMatch[0].length) : raw;

  // Match the H1 against the BODY - a YAML comment line in frontmatter (`# managed by hand`) must
  // not pose as the title.
  const titleText = body.match(/^#\s+(.+)$/m)?.[1] ?? "";
  // Shared fmList parses inline + block (flush-left OR indented) lists identically to check, so a tag
  // check certifies is a tag recall scores. normalize() lowercases tags; tokenize() lowercases aliases.
  const aliases = fmList(fm, "aliases").join(" ");
  const tags = fmList(fm, "tags").map((t) => normalize(vocab, t));

  // Weighted term frequency: each occurrence contributes its field's boost. The filename STEM joins
  // the title surface (the slug IS the note's identity) - and only the stem: folders are browse
  // drawers, never the search axis, and the machine path above the vault is pure noise, so neither
  // is indexed. Body uses the raw note text minus frontmatter.
  const tf = new Map<string, number>();
  const add = (tokens: string[], weight: number) => {
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
  };
  add([...tokenize(titleText), ...tokenize(basename(path, ".md"))], TITLE_BOOST);
  add(tokenize(aliases), TITLE_BOOST); // an alias is an identity match — same band as the title
  add(tags.flatMap(tokenize), TAG_BOOST);
  add(tokenize(body), BODY_BOOST);

  // Doc length = sum of weighted term counts; BM25 length-normalizes against the corpus average so a
  // long note doesn't dominate purely by repeating a term.
  let len = 0;
  for (const c of tf.values()) len += c;
  docs.push({ path, tf, len });
  for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
}

const N = docs.length || 1;
const avgdl = docs.reduce((s, d) => s + d.len, 0) / N || 1;
const K1 = 1.5;
const B = 0.75;

// idf via the BM25 probabilistic form. Rare term -> large idf; a term in every note -> ~0. Floored at 0
// so a near-ubiquitous term can't push a score negative.
const idf = (term: string): number => {
  const n = df.get(term) ?? 0;
  return Math.max(0, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
};

// BM25 contribution of a single (already field-weighted) term frequency in a doc.
const bm25Term = (tf: number, dl: number, termIdf: number): number => {
  if (tf <= 0) return 0;
  return termIdf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgdl)));
};

// Precompute the idf of every query variant once.
const variantIdf = new Map<string, number>();
for (const group of queryTerms) for (const v of group) if (!variantIdf.has(v)) variantIdf.set(v, idf(v));

type Hit = { path: string; score: number };
const hits: Hit[] = [];

// Score groups with FEWER variants first, so a flexible synonym group's fallback (its literal term)
// stays available. Otherwise a query holding both a synonym and its canonical lets the synonym group
// greedily consume the shared canonical, the literal match is never counted, and a both-terms doc
// ties with a one-term doc. Invariant: adding a synonym entry never makes ranking worse for a query
// that contains both the synonym and its canonical. Display order (the header) stays the query order.
const scoringGroups = [...queryTerms].sort((a, b) => a.length - b.length);

for (const d of docs) {
  let score = 0;
  const scored = new Set<string>(); // a matched term contributes once, even if two query groups reach it
  for (const group of scoringGroups) {
    // Within a synonym group, take the best-scoring variant (the word or its canonical tag) that this
    // doc hasn't already been scored on. So "insurance disability" (disability->insurance) doesn't count
    // `insurance` twice on a note lacking "disability"; the literal term still separates notes that have
    // it. The strongest unused signal wins.
    let best = 0;
    let bestVariant = "";
    for (const v of group) {
      if (scored.has(v)) continue;
      const s = bm25Term(d.tf.get(v) ?? 0, d.len, variantIdf.get(v) ?? 0);
      if (s > best) { best = s; bestVariant = v; }
    }
    if (best > 0) { score += best; scored.add(bestVariant); }
  }
  if (score > 0) hits.push({ path: relative(vault, d.path), score: Math.round(score * 100) / 100 });
}

hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

if (!hits.length) { console.log(`no matches for "${query}" in ${vault}`); process.exit(0); }

const shown = hits.slice(0, limit);
const expanded = queryTerms.map((g) => g.join("|")).join(" ");
console.log(`recall "${query}" [${expanded}] — ${hits.length} match(es)${hits.length > shown.length ? `, showing top ${shown.length}` : ""}, BM25-ranked:\n`);
for (const h of shown) console.log(`  [${h.score.toFixed(2)}] ${h.path}`);
if (hits.length > shown.length) {
  console.log(`\n  … ${hits.length - shown.length} lower-ranked hit(s) hidden. Raise with --limit if needed; usually you don't.`);
}
