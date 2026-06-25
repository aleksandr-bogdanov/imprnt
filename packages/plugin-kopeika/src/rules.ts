/**
 * Ratified categorization rules.
 *
 * Rules live in data/rules.csv: pattern,match_type,field,category,type.
 *   - match_type ∈ {substring, regex, exact}
 *   - field defaults to "merchant_raw" when blank
 *   - applied in file order; FIRST match wins
 *   - type is optional; when set it overrides the connector-assigned type
 *
 * This is the deterministic heart of categorization — no LLM is involved. The
 * `categorize` command applies these to uncategorized rows; `--review` reports
 * the unknown merchants so the user can author a rule for each once.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseCsv } from "./csv.ts";
import { isTxType, type Transaction, type TxType } from "./types.ts";

export const MATCH_TYPES = ["substring", "regex", "exact"] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

function isMatchType(value: string): value is MatchType {
  return (MATCH_TYPES as readonly string[]).includes(value);
}

export interface Rule {
  pattern: string;
  matchType: MatchType;
  field: keyof Transaction;
  category: string;
  type: TxType | null;
  /** Pre-compiled for regex rules; null otherwise. */
  regex: RegExp | null;
}

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "merchant_raw",
  "merchant_clean",
  "note",
  "account",
  "data_source",
]);

/** Load and validate data/rules.csv. Missing file => empty rule set. */
export function loadRules(path: string): Rule[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return [];

  const { records } = parseCsv(text);
  const rules: Rule[] = [];

  records.forEach((rec, i) => {
    const pattern = rec.get("pattern");
    const matchTypeRaw = rec.get("match_type").trim();
    const fieldRaw = rec.get("field").trim() || "merchant_raw";
    const category = rec.get("category").trim();
    const typeRaw = rec.get("type").trim();

    if (pattern === "" && matchTypeRaw === "" && category === "") return; // blank line

    if (!isMatchType(matchTypeRaw)) {
      throw new Error(
        `loadRules: row ${i + 2}: invalid match_type "${matchTypeRaw}" (expected substring|regex|exact)`,
      );
    }
    if (!ALLOWED_FIELDS.has(fieldRaw)) {
      throw new Error(
        `loadRules: row ${i + 2}: unsupported field "${fieldRaw}" (allowed: ${[...ALLOWED_FIELDS].join(", ")})`,
      );
    }

    let type: TxType | null = null;
    if (typeRaw !== "") {
      if (!isTxType(typeRaw)) {
        throw new Error(`loadRules: row ${i + 2}: invalid type "${typeRaw}"`);
      }
      type = typeRaw;
    }

    let regex: RegExp | null = null;
    if (matchTypeRaw === "regex") {
      try {
        regex = new RegExp(pattern, "i");
      } catch (err) {
        throw new Error(
          `loadRules: row ${i + 2}: invalid regex "${pattern}": ${(err as Error).message}`,
        );
      }
    }

    rules.push({
      pattern,
      matchType: matchTypeRaw,
      field: fieldRaw as keyof Transaction,
      category,
      type,
      regex,
    });
  });

  return rules;
}

/** Read a transaction field as a string for matching. */
function fieldValue(tx: Transaction, field: keyof Transaction): string {
  const v = tx[field];
  return typeof v === "string" ? v : String(v);
}

/** Test one rule against one transaction. */
export function ruleMatches(rule: Rule, tx: Transaction): boolean {
  const value = fieldValue(tx, rule.field);
  switch (rule.matchType) {
    case "substring":
      return value.toLowerCase().includes(rule.pattern.toLowerCase());
    case "exact":
      return value === rule.pattern;
    case "regex":
      // regex is guaranteed non-null for regex match_type by loadRules.
      return rule.regex!.test(value);
    default: {
      // Exhaustiveness guard: if a new MatchType is added without a branch,
      // this fails loudly instead of silently not matching.
      const _never: never = rule.matchType;
      throw new Error(`ruleMatches: unhandled match_type ${String(_never)}`);
    }
  }
}

/** First matching rule for a transaction, or null. */
export function firstMatch(rules: readonly Rule[], tx: Transaction): Rule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, tx)) return rule;
  }
  return null;
}

export interface UnknownMerchant {
  merchant_raw: string;
  count: number;
  /** Summed |amount_eur| across occurrences with a known EUR value. */
  totalEur: number;
  /** Occurrences with a missing amount_eur (no FX rate) — excluded from totalEur. */
  missingEurCount: number;
}

/**
 * Aggregate uncategorized rows by merchant_raw, sorted by spend (totalEur) desc.
 * Used by `categorize --review` so the user assigns each merchant once.
 */
export function summarizeUnknowns(txs: readonly Transaction[]): UnknownMerchant[] {
  const byMerchant = new Map<string, UnknownMerchant>();
  for (const tx of txs) {
    if (tx.category !== "") continue;
    const key = tx.merchant_raw;
    const existing = byMerchant.get(key);
    const entry: UnknownMerchant =
      existing ?? { merchant_raw: key, count: 0, totalEur: 0, missingEurCount: 0 };
    entry.count += 1;
    if (tx.amount_eur === null) {
      entry.missingEurCount += 1;
    } else {
      entry.totalEur += Math.abs(tx.amount_eur);
    }
    byMerchant.set(key, entry);
  }
  return [...byMerchant.values()].sort((a, b) => b.totalEur - a.totalEur);
}
