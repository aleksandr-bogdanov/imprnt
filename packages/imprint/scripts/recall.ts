#!/usr/bin/env bun
// imprint recall "<query>" [--vault DIR] [--limit N]
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
//     term frequency, so "voronezh" in a title outweighs "voronezh" buried in prose. One BM25 pass.
//   - idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5));  k1 = 1.5, b = 0.75.
//   - score = Σ_query-terms idf(t) * (tf*(k1+1)) / (tf + k1*(1 - b + b*dl/avgdl)).
//   - idf subsumes the old df-weighting (a rare matched term scores; a common one barely moves the
//     total) and additive term scoring subsumes the old partial-coverage fallback (one matched term
//     still scores — no false "no matches"). No AND gate, no bespoke tiers.
// Query terms are expanded through _tags.md (synonym -> canonical) and treated as alternatives; the
// best-scoring variant of each query term contributes. Lean conversational stopwords are dropped.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadTags, normalize, type TagVocab } from "./lib/tags.ts";

const args = process.argv.slice(2);
let vault = process.env.IMPRINT_VAULT ?? "./vault";
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
  console.error('usage: imprint recall "<query>" [--vault DIR] [--limit N]');
  process.exit(1);
}

const vocab = loadTags(vault);

// Conversational stopwords. The pitch is "you talk in plain language, the agent searches underneath" —
// a query is a SENTENCE ("what do I believe about money"), not keywords. These words are sentence glue
// that appear everywhere and discriminate nothing, so they only add noise to BM25. Kept lean (~30) and
// we never strip a query to nothing — if every term is a stopword we keep the originals.
const STOPWORDS = new Set([
  "what", "do", "i", "am", "on", "my", "about", "the", "a", "an", "should",
  "me", "is", "of", "to", "for", "in", "and", "or", "think", "know", "believe",
  "status", "timeline", "period", "decision", "plan", "info", "details",
  "current", "latest", "where", "how", "when", "which", "who", "notes",
]);

// Tokenize on Unicode letters and numbers so non-ASCII content (Cyrillic, German umlauts, ß) tokenizes
// to whole words instead of being stripped. The same tokenizer runs on both the query and the note
// body/title/tags so the write and read sides agree on word boundaries. Lowercasing is locale-agnostic.
const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// A synonym key in _tags.md can be multi-token or accented (`big-query`, `on-call`, `net worth`). The
// alnum/Unicode tokenizer splits those into pieces, so a query like `big-query` would never reach the
// `big-query -> bigquery` synonym via per-token normalize. To make those keys reachable from the query
// side, scan the raw whitespace-split query for any synonym key (single token AND adjacent n-grams) and,
// for each match, contribute the canonical's TOKENS as extra query terms. The per-token path below still
// runs, so single-token synonyms keep working too.
//   Returns the tokenized canonicals discovered from multi-token/hyphenated synonym keys.
const phraseSynonymTokens = (q: string): string[] => {
  const out: string[] = [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  // Try the whole phrase, then every contiguous n-gram down to single words, joined by both space and
  // hyphen (a key may be written either way). A hit maps to its canonical, which we then tokenize.
  for (let n = words.length; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const span = words.slice(i, i + n);
      for (const key of [span.join(" "), span.join("-")]) {
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
const queryTerms = baseTerms.map((w) => [...new Set([w, normalize(vocab, w)])]);
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
    // Be tolerant per entry. A broken symlink or otherwise unreadable entry makes statSync/readdir throw.
    // Skip just that entry so one bad node never aborts the whole walk or hides a populated vault.
    try {
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (entry.endsWith(".md")) out.push(p);
    } catch { continue; }
  }
  return out;
}

let files: string[] = [];
try { files = walk(vault); } catch { console.error(`no vault at ${vault} — run \`imprint init\` first`); process.exit(1); }

// Parse the frontmatter `tags: [...]` into NORMALIZED canonical tags (write and search agree on one
// concept = one tag), and `aliases: [...]` (the note's own alternate names — an identity surface).
function frontmatterList(fm: string, key: string): string[] {
  const line = fm.match(new RegExp(`${key}:\\s*\\[(.*?)\\]`, "i"))?.[1] ?? "";
  return line.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean);
}

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
  const raw = readFileSync(path, "utf8");
  // Accept CRLF (`\r\n`) fences so Windows-authored notes parse frontmatter. Without `\r?` the closing
  // `---\r` line never matches and the whole frontmatter falls through to the body, losing tag boosts.
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = fmMatch?.[1] ?? "";
  const body = fmMatch ? raw.slice(fmMatch.index! + fmMatch[0].length) : raw;

  const titleText = raw.match(/^#\s+(.+)$/m)?.[1] ?? "";
  const aliases = frontmatterList(fm, "aliases").join(" ");
  const tags = frontmatterList(fm, "tags").map((t) => normalize(vocab, t));

  // Weighted term frequency: each occurrence contributes its field's boost. Filename tokens join the
  // title surface (the slug IS the note's identity). Body uses the raw note text minus frontmatter.
  const tf = new Map<string, number>();
  const add = (tokens: string[], weight: number) => {
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
  };
  add([...tokenize(titleText), ...tokenize(path)], TITLE_BOOST);
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

for (const d of docs) {
  let score = 0;
  const scored = new Set<string>(); // a matched term contributes once, even if two query groups reach it
  for (const group of queryTerms) {
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
