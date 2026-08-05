/**
 * Country tax data pack: the category set, EÜR line mapping, and SKR
 * account-code mapping. Germany ships as `categories.de.json` at the plugin
 * root. The core hardcodes no country — a pack is data someone authors.
 *
 * A category's `side` says how its rows enter the profit computation:
 *   income   — signed sum counts as Betriebseinnahmen
 *   expense  — signed sum (negated) counts as Betriebsausgaben
 *   neutral  — on the books for completeness, in no total (Privateinlage etc.)
 * `nondeductible: true` keeps an expense visible but out of the profit.
 * `split` marks a gross category the report splits deterministically (Bewirtung
 * 70/30) into its `into` pair at report time.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PackCategory {
  key: string;
  label: string;
  side: "income" | "expense" | "neutral";
  euerLine: string;
  euerLineLabel: string;
  nondeductible: boolean;
  split: { deductibleShare: number; into: [string, string] } | null;
}

export interface TaxPack {
  country: string;
  packYear: number;
  categories: Map<string, PackCategory>;
  /** SKR account code -> category key (import-time mapping for DATEV sources). */
  skr: Map<string, string>;
}

/** Load a country pack by code ("de" -> categories.de.json in the plugin root). */
export function loadPack(rootDir: string, country: string): TaxPack {
  const path = join(rootDir, `categories.${country.toLowerCase()}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `tax pack not found: ${path} — the country pack is shipped data; "de" is the one included pack`,
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`tax pack ${path} is not valid JSON (${(e as Error).message})`);
  }

  const categories = new Map<string, PackCategory>();
  const catsRaw = (raw.categories ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, c] of Object.entries(catsRaw)) {
    if (key.startsWith("_")) continue;
    const side = String(c.side ?? "");
    if (side !== "income" && side !== "expense" && side !== "neutral") {
      throw new Error(`tax pack: category "${key}" has invalid side "${side}"`);
    }
    let split: PackCategory["split"] = null;
    if (c.split !== undefined && c.split !== null) {
      const s = c.split as Record<string, unknown>;
      const into = Array.isArray(s.into) ? s.into.map(String) : [];
      const share = Number(s.deductible_share);
      if (into.length !== 2 || !Number.isFinite(share) || share <= 0 || share >= 1) {
        throw new Error(`tax pack: category "${key}" has an invalid split spec`);
      }
      split = { deductibleShare: share, into: [into[0]!, into[1]!] };
    }
    categories.set(key, {
      key,
      label: String(c.label ?? key),
      side,
      euerLine: String(c.euer_line ?? ""),
      euerLineLabel: String(c.euer_line_label ?? ""),
      nondeductible: c.nondeductible === true,
      split,
    });
  }

  const skr = new Map<string, string>();
  for (const skrKey of Object.keys(raw).filter((k) => k.startsWith("skr"))) {
    const table = raw[skrKey] as Record<string, unknown>;
    for (const [code, cat] of Object.entries(table)) {
      if (code.startsWith("_")) continue;
      const key = String(cat);
      if (!categories.has(key)) {
        throw new Error(`tax pack: ${skrKey} maps ${code} to unknown category "${key}"`);
      }
      skr.set(code, key);
    }
  }

  // Split targets must exist so the report never splits into a void.
  for (const c of categories.values()) {
    if (c.split) {
      for (const target of c.split.into) {
        if (!categories.has(target)) {
          throw new Error(`tax pack: "${c.key}" splits into unknown category "${target}"`);
        }
      }
    }
  }

  return {
    country: String(raw.country ?? country.toUpperCase()),
    packYear: Number(raw.pack_year) || 0,
    categories,
    skr,
  };
}
