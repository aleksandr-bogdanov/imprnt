// Tag vocabulary: load vault/_tags.md, normalize a term through the synonym map.
// Deterministic, no LLM. The map is bidirectional, applied at write AND at search.
// Under `## Tags`, only tag-list lines (comma-separated kebab tokens) count. Prose lines in the
// section are ignored on load and never touched on append. Parsing is per-token: one bad token
// (a space, an underscore, stray punctuation) is skipped without dropping the valid tokens around
// it - all-or-nothing line parsing once let a single bad token poison the whole vocabulary.
//
// The vocabulary is AUTO-GROWING, not a gated allowlist: ingest applies the best-fitting tag, and
// `imprnt check` syncs anything new into the list via `appendTags` below. Coining a tag needs no
// human approval — a tag is just a string the note already carries. The discipline that keeps the
// list lean moved to a non-blocking audit (check flags near-duplicate tags for a conscious synonym
// merge), off the write path. One concept = one tag is still the goal, enforced by that audit.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type TagVocab = { approved: Set<string>; synonyms: Map<string, string> };

function section(text: string, name: string): string {
  return text.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|\\s*$)`, "i"))?.[1] ?? "";
}

// A kebab-case tag token: Unicode letters, digits, hyphens. The vault is Unicode-first (the
// tokenizer matches \p{L}\p{N} so Cyrillic vaults work), so tags are too - ASCII-only here once
// made every non-ASCII tag corrupt _tags.md.
const TAG_TOKEN = /^[\p{L}\p{N}-]+$/u;

// The valid tag tokens on a line. Per-token salvage: an invalid token is skipped, never fatal to
// its neighbors. A pure prose line yields nothing (its comma segments contain spaces).
function tagTokens(line: string): string[] {
  return line.split(",").map((s) => s.trim()).filter((s) => TAG_TOKEN.test(s));
}

// True if a line under `## Tags` is part of the tag list. A tag line is one where the MAJORITY of
// its comma-separated segments are valid tag tokens. "at least one valid token" was too permissive:
// a prose comment ("Keep this list lean, one-concept") has one kebab-valid segment and got mistaken
// for the list. Majority keeps round-1 salvage alive ("health, net worth, insurance" = 2 of 3 valid,
// still a tag line) while rejecting prose where most segments carry interior spaces.
function isTagLine(line: string): boolean {
  const t = line.trim();
  if (t === "" || t.startsWith("##") || t.startsWith("<!--")) return false;
  const segs = t.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (segs.length === 0) return false;
  const valid = segs.filter((s) => TAG_TOKEN.test(s)).length;
  return valid * 2 > segs.length;
}

// Normalize a raw tag to its writable kebab form: lowercase, spaces and underscores to hyphens.
// Returns "" when no valid token remains - appendTags never writes what loadTags cannot read back.
function kebab(tag: string): string {
  const t = tag.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return TAG_TOKEN.test(t) ? t : "";
}

export function loadTags(vault: string): TagVocab {
  const approved = new Set<string>();
  const synonyms = new Map<string, string>();
  const p = join(vault, "_tags.md");
  if (!existsSync(p)) return { approved, synonyms };
  const text = readFileSync(p, "utf8");

  // Only valid tag tokens under `## Tags` count. Prose lines and bad tokens are skipped per-token,
  // so a hand-edited "health, net worth, insurance" still loads health + insurance.
  for (const line of section(text, "Tags").split(/\r?\n/)) {
    for (const t of tagTokens(line)) approved.add(t.toLowerCase());
  }
  for (const line of section(text, "Synonyms").split(/\r?\n/)) {
    const m = line.match(/^(.*?)\s*->\s*(\S+)\s*$/);
    if (!m) continue;
    const canon = m[2].trim().toLowerCase();
    for (const syn of m[1].split(",").map((s) => s.trim().toLowerCase())) {
      if (syn) synonyms.set(syn, canon);
    }
  }
  return { approved, synonyms };
}

// Map a term to its canonical tag if known; otherwise return it unchanged.
// Kebab the input first so underscore/space variants ("Tax_Filing") still hit the synonym map,
// then follow the chain to its fixed point so notes and queries that enter a chain at different
// points (money->finances->wealth) meet at the same canonical. The `seen` guard makes a cycle
// (a->b->a) terminate deterministically at the first term already visited.
export function normalize(vocab: TagVocab, term: string): string {
  let cur = kebab(term) || term.toLowerCase();
  const seen = new Set<string>([cur]);
  for (;;) {
    const next = vocab.synonyms.get(cur);
    if (next === undefined || seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}

// Auto-grow the vocabulary: append new canonical tags to _tags.md's `## Tags` list, preserving all
// surrounding formatting (touches only the tag line). Deterministic, no LLM. Returns the tags it
// actually wrote, in their kebab form. Guards: no-op if _tags.md is absent (that's `imprnt init`'s
// job, not check's) or nothing is new after normalization.
export function appendTags(vault: string, newTags: string[]): string[] {
  const p = join(vault, "_tags.md");
  if (!existsSync(p) || newTags.length === 0) return [];
  // Kebab-normalize and re-filter against the file: callers pass raw note tags, and a tag that only
  // normalizes here (tax_filing -> tax-filing) would otherwise re-append on every sync pass. The
  // skip keeps consecutive passes byte-identical. Unsalvageable tags are dropped, never written.
  const { approved } = loadTags(vault);
  const tags: string[] = [];
  for (const raw of newTags) {
    const t = kebab(raw);
    if (t && !approved.has(t) && !tags.includes(t)) tags.push(t);
  }
  if (tags.length === 0) return [];
  const text = readFileSync(p, "utf8");
  const lines = text.split("\n");
  const h = lines.findIndex((l) => /^##\s*Tags\s*$/i.test(l.trim()));
  if (h < 0) {
    // No `## Tags` header (hand-trimmed file): create the section at the end. Silently no-oping
    // here let check report the vocabulary in sync while nothing had synced.
    const base = text.replace(/\s+$/, "");
    const sec = `## Tags\n${tags.join(", ")}\n`;
    writeFileSync(p, base === "" ? sec : `${base}\n\n${sec}`);
    return tags;
  }
  // Append to the LAST tag line in the `## Tags` section (header to the next `##` or EOF). Scanning
  // the whole section, not just the contiguous run right under the header, is what lets a leading
  // prose comment ("Keep this list lean") sit above the real list without stealing the append - the
  // new tag still lands on the actual list below it. A prose line is never a target and never touched.
  let last = -1;
  for (let i = h + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("##")) break;
    if (isTagLine(lines[i])) last = i;
  }
  if (last < 0) lines.splice(h + 1, 0, tags.join(", "));
  else lines[last] = `${lines[last].replace(/\s+$/, "")}, ${tags.join(", ")}`;
  writeFileSync(p, lines.join("\n"));
  return tags;
}
