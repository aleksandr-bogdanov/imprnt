// imprnt · kleinanzeigen plugin — listing fact sheets.
//
// A fact sheet (listings/<id>.yaml) is the deterministic fuel for FAQ drafts: the answers buyers
// actually ask for (Artikelnummer, cables, version, condition, pickup area, price floor). The rater
// reads these to answer a question WITHOUT the model. A field left empty is the honest "I don't know
// this yet" — the rater turns an empty-but-asked field into `needs_fact`, never a guess.
//
// We parse a deliberately tiny flat-YAML subset (no dependency, per the zero-deps contract): top-level
// `key: value` lines, plus `key:` followed by `  - item` lines for a list. That's all a fact sheet needs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Facts = {
  listing: string;
  model: string;
  variant: string;
  artikelnummer: string; // empty = unverified, surfaces as needs_fact when asked
  includes: string[];
  condition: string;
  age: string; // empty = unknown
  software: string; // empty = unknown
  cable: string; // answer to "ist das Kabel/Koaxialkabel dabei?" — empty = unknown
  price: number | null;
  floor: number | null; // lowest Alex will take; an offer below this is flagged, never auto-accepted
  pickup_area: string;
  shipping: string; // free text: "Versand möglich gegen Aufpreis" / "nur Abholung"
};

// A FRESH object each call — note `includes: []` must be a new array per parse, never a shared module
// constant (a shared array would accumulate items across every parseFacts call).
function emptyFacts(listing: string): Facts {
  return {
    listing,
    model: "", variant: "", artikelnummer: "", includes: [],
    condition: "", age: "", software: "", cable: "",
    price: null, floor: null, pickup_area: "", shipping: "",
  };
}

// Strip a single matching pair of surrounding quotes; leave inner quotes alone.
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Parse the flat-YAML subset. Unknown keys are ignored (forward-compatible). A numeric field that
// isn't a number stays null rather than NaN, so a typo in a price never poisons an arithmetic compare.
export function parseFacts(text: string, listingFallback = ""): Facts {
  const f = emptyFacts(listingFallback);
  const lines = text.split(/\r?\n/);
  let listKey: keyof Facts | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, ""); // strip trailing comments (not inside quotes — fact sheets don't need that)
    if (!line.trim()) continue;

    // A list item under the most recent `key:` with an empty value.
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (f[listKey] as string[]).push(unquote(item[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1] as keyof Facts;
    const value = kv[2].trim();
    listKey = null;

    if (key === "includes") {
      if (value === "" ) { listKey = "includes"; continue; } // block list follows
      // inline list: [a, b, c]
      const inner = value.replace(/^\[/, "").replace(/\]$/, "");
      f.includes = inner.split(",").map((s) => unquote(s)).filter((s) => s.length > 0);
      continue;
    }
    if (key === "price" || key === "floor") {
      const n = Number(value);
      f[key] = Number.isFinite(n) ? n : null;
      continue;
    }
    if (key in f) {
      // control flow has excluded includes/price/floor above; everything left is a string field
      (f as unknown as Record<string, string>)[key] = unquote(value);
    }
  }
  return f;
}

// Load listings/<id>.yaml. Returns null when there's no fact sheet for this listing (the rater then
// can answer nothing and every FAQ becomes needs_fact — correct, never a guess).
export function loadFacts(listingId: string, listingsDir: string): Facts | null {
  const p = join(listingsDir, `${listingId}.yaml`);
  if (!existsSync(p)) return null;
  return parseFacts(readFileSync(p, "utf8"), listingId);
}
