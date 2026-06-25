/**
 * Spend tier: mandatory (the floor) vs optional (the flex).
 *
 * This is a SEPARATE axis from both category and recurrence:
 *   - category  = what a thing is for (Rent, Groceries, Entertainment)
 *   - tier      = is it a fixed obligation? (rent yes, a späti beer no)
 *   - recurring = how often it appears (see recurring.ts)
 *
 * Crucially, recurring ≠ mandatory. Groceries and Amazon recur every month but
 * are NOT the floor — you can flex them down in a hard month, you can't flex rent.
 * The floor is what the household owes no matter what; everything else is choice.
 *
 * Tiers are declared in data/tiers.csv (scope,value,tier) and matched two ways:
 *   - scope=category : whole category is mandatory (Rent, Insurance, Kids, …)
 *   - scope=merchant : merchant_raw contains this substring (Vattenfall, Claude, …)
 * Anything not matched as mandatory is optional. No LLM, no I/O in the classifier.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseCsv } from "./csv.ts";

/** The mandatory side of the world, pre-lowercased for case-insensitive matching. */
export interface Tiers {
  /** Categories whose every row is mandatory (matched case-insensitively, exact). */
  mandatoryCategories: ReadonlySet<string>;
  /** merchant_raw substrings that mark a row mandatory (case-insensitive contains). */
  mandatoryMerchants: readonly string[];
}

/** The two tiers. "mandatory" = floor, "optional" = flex. */
export type Tier = "mandatory" | "optional";

const VALID_SCOPES: ReadonlySet<string> = new Set(["category", "merchant"]);
const VALID_TIERS: ReadonlySet<string> = new Set(["mandatory", "optional"]);

/**
 * Load and validate data/tiers.csv. A missing or empty file yields an empty tier
 * set — every row is then optional (no floor declared), which the report layer
 * detects and treats as "tiers not configured" rather than "floor is €0".
 *
 * Only `mandatory` rows carry information; `optional` rows are accepted (so the
 * file can be exhaustive if the user wants) but are a no-op, since optional is
 * the default for anything unmatched.
 */
export function loadTiers(path: string): Tiers {
  if (!existsSync(path)) return { mandatoryCategories: new Set(), mandatoryMerchants: [] };
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return { mandatoryCategories: new Set(), mandatoryMerchants: [] };

  const { records } = parseCsv(text);
  const mandatoryCategories = new Set<string>();
  const mandatoryMerchants: string[] = [];

  records.forEach((rec, i) => {
    const scope = rec.get("scope").trim().toLowerCase();
    const value = rec.get("value").trim();
    const tier = rec.get("tier").trim().toLowerCase();

    if (scope === "" && value === "" && tier === "") return; // blank line

    if (!VALID_SCOPES.has(scope)) {
      throw new Error(`loadTiers: row ${i + 2}: invalid scope "${scope}" (expected category|merchant)`);
    }
    if (!VALID_TIERS.has(tier)) {
      throw new Error(`loadTiers: row ${i + 2}: invalid tier "${tier}" (expected mandatory|optional)`);
    }
    if (value === "") {
      throw new Error(`loadTiers: row ${i + 2}: empty value`);
    }

    if (tier !== "mandatory") return; // optional is the default; nothing to record
    if (scope === "category") mandatoryCategories.add(value.toLowerCase());
    else mandatoryMerchants.push(value.toLowerCase());
  });

  return { mandatoryCategories, mandatoryMerchants };
}

/** True when no mandatory rows were declared — the floor is unknown, not zero. */
export function tiersConfigured(tiers: Tiers): boolean {
  return tiers.mandatoryCategories.size > 0 || tiers.mandatoryMerchants.length > 0;
}

/**
 * Classify one row's tier. Mandatory iff its category is a mandatory category OR
 * its merchant_raw contains a mandatory merchant substring; otherwise optional.
 * Matching is case-insensitive on both axes. Pure — safe to call in hot loops.
 */
export function tierOf(tiers: Tiers, category: string, merchantRaw: string): Tier {
  if (tiers.mandatoryCategories.has(category.toLowerCase())) return "mandatory";
  const m = merchantRaw.toLowerCase();
  if (tiers.mandatoryMerchants.some((sub) => m.includes(sub))) return "mandatory";
  return "optional";
}
