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

// True if a line under `## Tags` is part of the tag list (it carries at least one valid tag token).
// Prose lines (spaces inside every token, or non-tag punctuation) are not tag lines.
function isTagLine(line: string): boolean {
  const t = line.trim();
  if (t === "" || t.startsWith("##") || t.startsWith("<!--")) return false;
  return tagTokens(t).length > 0;
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
export function normalize(vocab: TagVocab, term: string): string {
  return vocab.synonyms.get(term.toLowerCase()) ?? term.toLowerCase();
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
  // The tag list is the contiguous run of tag lines right under the header (skipping a leading
  // blank). Append to the LAST line of that run. A prose line ends the run and is never touched.
  let last = -1;
  for (let i = h + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") { if (last >= 0) break; else continue; }
    if (!isTagLine(lines[i])) break;
    last = i;
  }
  if (last < 0) lines.splice(h + 1, 0, tags.join(", "));
  else lines[last] = `${lines[last].replace(/\s+$/, "")}, ${tags.join(", ")}`;
  writeFileSync(p, lines.join("\n"));
  return tags;
}
