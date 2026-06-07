// Tag vocabulary: load vault/_tags.md, normalize a term through the synonym map.
// Deterministic, no LLM. The map is bidirectional — applied at write AND at search.
//
// The vocabulary is AUTO-GROWING, not a gated allowlist: ingest applies the best-fitting tag, and
// `imprint check` syncs anything new into the list via `appendTags` below. Coining a tag needs no
// human approval — a tag is just a string the note already carries. The discipline that keeps the
// list lean moved to a non-blocking audit (check flags near-duplicate tags for a conscious synonym
// merge), off the write path. One concept = one tag is still the goal, enforced by that audit.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type TagVocab = { approved: Set<string>; synonyms: Map<string, string> };

function section(text: string, name: string): string {
  return text.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|\\s*$)`, "i"))?.[1] ?? "";
}

export function loadTags(vault: string): TagVocab {
  const approved = new Set<string>();
  const synonyms = new Map<string, string>();
  const p = join(vault, "_tags.md");
  if (!existsSync(p)) return { approved, synonyms };
  const text = readFileSync(p, "utf8");

  for (const t of section(text, "Tags").split(/[,\n]/).map((s) => s.trim().toLowerCase())) {
    if (t && !t.startsWith("<!--")) approved.add(t);
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
// surrounding formatting (touches only the tag line). Deterministic, no LLM. Returns the tags added.
// Guards: no-op if _tags.md is absent (that's `imprint init`'s job, not check's) or nothing is new.
export function appendTags(vault: string, newTags: string[]): string[] {
  const p = join(vault, "_tags.md");
  if (!existsSync(p) || newTags.length === 0) return [];
  const lines = readFileSync(p, "utf8").split("\n");
  const h = lines.findIndex((l) => /^##\s*Tags\s*$/i.test(l.trim()));
  if (h < 0) return [];
  // Find the last contiguous content line under the header (skip leading blanks, stop at next ## / blank).
  let last = -1;
  for (let i = h + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") { if (last >= 0) break; else continue; }
    if (t.startsWith("##")) break;
    last = i;
  }
  if (last < 0) lines.splice(h + 1, 0, newTags.join(", "));
  else lines[last] = `${lines[last].replace(/\s+$/, "")}, ${newTags.join(", ")}`;
  writeFileSync(p, lines.join("\n"));
  return newTags;
}
