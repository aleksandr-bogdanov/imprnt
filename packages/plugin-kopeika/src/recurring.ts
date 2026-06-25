/**
 * Recurring-merchant detection.
 *
 * "Recurring" means a merchant shows up as spend in many distinct calendar
 * months — a frequency signal, nothing more. It is deliberately NOT the same as
 * mandatory (see tiers.ts): rent recurs AND is mandatory; groceries and Amazon
 * recur but are flex. The tier column in the output makes that split visible.
 *
 * The detected set is the deterministic backbone of the whole tool: ~70 merchants
 * tagged once cover most of the monthly spend, so categorizing them is the high-
 * leverage work. Pure and side-effect-free — every input is a ledger slice, the
 * output is a sorted summary. No LLM, no I/O.
 */

import { isAnalyticsExcluded } from "./analytics.ts";
import { tierOf, type Tier, type Tiers } from "./tiers.ts";
import type { Transaction } from "./types.ts";

/** One merchant that recurs across the ledger, with its frequency + spend shape. */
export interface RecurringMerchant {
  merchant_raw: string;
  /** Distinct YYYY-MM months this merchant appeared in (the recurrence strength). */
  monthsCount: number;
  /** Total |EUR| spent across all occurrences. */
  totalEur: number;
  /** totalEur / monthsCount — the typical monthly bite. */
  perMonth: number;
  /** Number of individual transactions. */
  count: number;
  /** The category currently assigned (most recent non-empty wins; "—" if none). */
  category: string;
  /** Mandatory (floor) or optional (flex) — the orthogonal-to-recurrence axis. */
  tier: Tier;
  /** Distinct accounts the merchant was charged on. */
  accounts: string[];
  /** Earliest month seen (YYYY-MM). */
  firstMonth: string;
  /** Latest month seen (YYYY-MM). */
  lastMonth: string;
}

/** Tuning knobs for what counts as "recurring". */
export interface RecurringOptions {
  /** Minimum distinct months a merchant must appear in to qualify. Default 4. */
  minMonths?: number;
  /** Only consider rows on/after this YYYY-MM (inclusive). Undefined = no bound. */
  from?: string;
}

export const DEFAULT_RECURRING_OPTIONS: Required<Pick<RecurringOptions, "minMonths">> = {
  minMonths: 4,
};

/** Mutable per-merchant accumulator while scanning the ledger once. */
interface Acc {
  months: Set<string>;
  totalEur: number;
  count: number;
  accounts: Set<string>;
  category: string;
  firstMonth: string;
  lastMonth: string;
}

/**
 * Detect recurring merchants in a ledger slice.
 *
 * A row contributes when it is real spend: not analytics-excluded (no transfers,
 * exchanges, or Exclude-tagged rows), has a negative amount_eur, and a non-blank
 * merchant_raw. Merchants seen in `>= minMonths` distinct months are returned,
 * sorted by per-month spend descending (biggest recurring bite first).
 */
export function detectRecurring(
  txs: readonly Transaction[],
  tiers: Tiers,
  options: RecurringOptions = {},
): RecurringMerchant[] {
  const minMonths = options.minMonths ?? DEFAULT_RECURRING_OPTIONS.minMonths;
  const from = options.from;

  const byMerchant = new Map<string, Acc>();
  for (const tx of txs) {
    const month = tx.date.slice(0, 7);
    if (from !== undefined && month < from) continue;
    if (isAnalyticsExcluded(tx)) continue;
    if (tx.amount_eur === null || tx.amount_eur >= 0) continue; // spend only
    const key = tx.merchant_raw;
    if (key.trim() === "") continue; // unnamed rows can't be tagged once-forever

    let a = byMerchant.get(key);
    if (a === undefined) {
      a = {
        months: new Set(),
        totalEur: 0,
        count: 0,
        accounts: new Set(),
        category: tx.category,
        firstMonth: month,
        lastMonth: month,
      };
      byMerchant.set(key, a);
    }
    a.months.add(month);
    a.totalEur += Math.abs(tx.amount_eur);
    a.count += 1;
    a.accounts.add(tx.account);
    if (tx.category !== "") a.category = tx.category; // keep a concrete label if any row has one
    if (month < a.firstMonth) a.firstMonth = month;
    if (month > a.lastMonth) a.lastMonth = month;
  }

  const out: RecurringMerchant[] = [];
  for (const [merchant_raw, a] of byMerchant) {
    if (a.months.size < minMonths) continue;
    const category = a.category === "" ? "—" : a.category;
    out.push({
      merchant_raw,
      monthsCount: a.months.size,
      totalEur: a.totalEur,
      perMonth: a.totalEur / a.months.size,
      count: a.count,
      category,
      tier: tierOf(tiers, category, merchant_raw),
      accounts: [...a.accounts].sort(),
      firstMonth: a.firstMonth,
      lastMonth: a.lastMonth,
    });
  }

  // Biggest recurring monthly bite first; merchant name as a stable tie-break.
  return out.sort((x, y) => {
    if (y.perMonth !== x.perMonth) return y.perMonth - x.perMonth;
    return x.merchant_raw < y.merchant_raw ? -1 : x.merchant_raw > y.merchant_raw ? 1 : 0;
  });
}
