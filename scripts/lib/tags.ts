// Tag vocabulary: load vault/_tags.md, normalize a term through the synonym map.
// Deterministic, no LLM. The map is bidirectional — applied at write AND at search.
import { readFileSync, existsSync } from "node:fs";
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
