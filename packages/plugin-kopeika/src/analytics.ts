/**
 * Analytics layer: turn the normalized ledger into per-month and per-category
 * income / spend / savings figures, plus an overall summary and a per-month
 * trend series. Pure and deterministic — no LLM, no I/O. Every consumer (the
 * `report` text table and the HTML dashboard) reads from {@link buildReport}.
 *
 * What counts:
 *   - income = sum of positive amount_eur on non-excluded rows
 *   - spend  = sum of |negative amount_eur| on non-excluded rows
 *   - saved  = income - spend (the emotional center of the report)
 *   - savings rate = saved / income (raw; the display layer clamps to 0-100%)
 *
 * What does NOT count (see {@link isAnalyticsExcluded}): internal transfers,
 * currency exchanges, and rows a rule has marked `Exclude` (synthetic/junk
 * merchants like "Отложение" or "Main Account"). Excluding these everywhere is
 * the difference between a real cash-flow picture and double-counted noise.
 *
 * Rows missing amount_eur (no FX rate) cannot be summed and are counted as a
 * warning rather than guessed at — consistent with the FX layer's "never guess".
 */

import { tierOf, tiersConfigured, type Tiers } from "./tiers.ts";
import type { Transaction } from "./types.ts";

/** Spend bucket label for fee-type rows. Fees get their own line, always. */
export const BANK_FEES_CATEGORY = "Bank fees";
/** Spend bucket label for non-excluded rows that no rule has categorized yet. */
export const UNCATEGORIZED_CATEGORY = "Uncategorized";
/** Category value a rule assigns to rows that must be dropped from analytics. */
export const EXCLUDE_CATEGORY = "Exclude";
/**
 * Category for money deliberately moved into a savings/investment account
 * (e.g. a Trading212 deposit). These rows are STILL excluded from income/spend
 * — they are transfers, not consumption — but their magnitude is surfaced
 * separately as `invested` so "I put €1,500 aside" never reads as a void.
 */
export const SAVINGS_CATEGORY = "Savings";

/** Transaction types that are never real income or spend. */
const EXCLUDED_TYPES: ReadonlySet<string> = new Set(["transfer", "exchange"]);

/**
 * Single source of truth for "this row is not real income or spend".
 *
 * A row is excluded when ANY of these hold:
 *   - it is a matched internal transfer (`is_transfer === true`)
 *   - its type is `transfer` or `exchange`
 *   - a rule marked it `category === "Exclude"`
 *
 * Used everywhere in reporting so the rule lives in exactly one place.
 */
export function isAnalyticsExcluded(txn: Transaction): boolean {
  if (txn.is_transfer) return true;
  if (EXCLUDED_TYPES.has(txn.type)) return true;
  if (txn.category === EXCLUDE_CATEGORY) return true;
  return false;
}

/** One category's share of spend within a scope (a month or the whole range). */
export interface CategorySpend {
  category: string;
  amount: number; // EUR, always >= 0
  /** Fraction of total spend in scope, in [0, 1]. 0 when scope spend is 0. */
  share: number;
  count: number;
}

/** Aggregated figures for one calendar month. */
export interface MonthSummary {
  month: string; // YYYY-MM
  income: number; // EUR, >= 0
  spend: number; // EUR, >= 0
  saved: number; // income - spend (may be negative)
  /** saved / income, raw (may exceed 1 or go negative). Display layer clamps. */
  savingsRate: number;
  /** EUR deliberately moved into savings/investment accounts this month (>= 0). */
  invested: number;
  /**
   * Mandatory (floor) spend this month — fixed obligations the household owes no
   * matter what. null when no tiers are configured (floor unknown, not zero).
   * When non-null, floor + flex === spend.
   */
  floor: number | null;
  /** Optional (flex) spend this month — discretionary, can be flexed down. null when no tiers configured. */
  flex: number | null;
  /** Spend by category for this month, sorted by amount desc. */
  categories: CategorySpend[];
  /** Non-excluded rows in this month that had no amount_eur. */
  missingEurCount: number;
}

/** Totals across the selected range, plus the per-month series for trends. */
export interface OverallSummary {
  income: number;
  spend: number;
  saved: number;
  savingsRate: number;
  /** EUR moved into savings/investment accounts across the range (>= 0). */
  invested: number;
  /** Mandatory (floor) spend across the range. null when no tiers configured. floor + flex === spend when non-null. */
  floor: number | null;
  /** Optional (flex) spend across the range. null when no tiers configured. */
  flex: number | null;
  /** Number of months covered (for the floor/flex per-month average). */
  monthCount: number;
  /** Spend by category across the whole range, sorted by amount desc. */
  categories: CategorySpend[];
  /** Non-excluded rows in range missing amount_eur. */
  missingEurCount: number;
  /** Non-excluded rows in range that had an amount_eur (the counted population). */
  countedRows: number;
}

/** A fully computed report over a (possibly filtered) set of transactions. */
export interface Report {
  /** Per-month summaries, ascending by month. */
  months: MonthSummary[];
  /** Totals + trend across every month in `months`. */
  overall: OverallSummary;
  /** Rows considered after range filtering but before exclusion (for context). */
  consideredRows: number;
  /** Rows dropped by {@link isAnalyticsExcluded} within the range. */
  excludedRows: number;
}

/** Options that bound which months a report covers. Both are inclusive. */
export interface ReportRange {
  /** Only include months >= this YYYY-MM. Undefined = no lower bound. */
  from?: string;
  /** Only include this single YYYY-MM. Takes precedence over `from`. */
  month?: string;
}

/** Extract YYYY-MM from an ISO YYYY-MM-DD date. */
function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** True when `month` falls inside the requested range. */
function inRange(month: string, range: ReportRange): boolean {
  if (range.month !== undefined) return month === range.month;
  if (range.from !== undefined) return month >= range.from;
  return true;
}

/**
 * Which spend bucket a non-excluded outflow belongs to:
 * fee-type rows -> "Bank fees"; categorized rows -> their category;
 * everything else -> "Uncategorized".
 */
function spendCategoryOf(txn: Transaction): string {
  if (txn.type === "fee") return BANK_FEES_CATEGORY;
  if (txn.category !== "") return txn.category;
  return UNCATEGORIZED_CATEGORY;
}

/** Round to 2 decimals, normalizing -0 to 0 so totals serialize cleanly. */
function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * Mutable accumulator for one month while scanning. Category totals are kept in
 * a Map keyed by category label; finalized into a sorted array at the end.
 */
interface MonthAcc {
  income: number;
  spend: number;
  invested: number;
  floor: number;
  flex: number;
  missingEurCount: number;
  categoryAmounts: Map<string, number>;
  categoryCounts: Map<string, number>;
}

function newMonthAcc(): MonthAcc {
  return {
    income: 0,
    spend: 0,
    invested: 0,
    floor: 0,
    flex: 0,
    missingEurCount: 0,
    categoryAmounts: new Map(),
    categoryCounts: new Map(),
  };
}

/** Sort categories by amount desc, then label asc for a stable deterministic order. */
function sortCategories(entries: CategorySpend[]): CategorySpend[] {
  return [...entries].sort((a, b) => {
    if (b.amount !== a.amount) return b.amount - a.amount;
    return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
  });
}

/** Build the finalized, sorted CategorySpend[] for a given spend total. */
function finalizeCategories(
  amounts: Map<string, number>,
  counts: Map<string, number>,
  totalSpend: number,
): CategorySpend[] {
  const entries: CategorySpend[] = [];
  for (const [category, amount] of amounts) {
    const rounded = round2(amount);
    entries.push({
      category,
      amount: rounded,
      share: totalSpend > 0 ? rounded / totalSpend : 0,
      count: counts.get(category) ?? 0,
    });
  }
  return sortCategories(entries);
}

/** savings rate = saved / income; 0 when there is no income to save from. */
function savingsRateOf(income: number, saved: number): number {
  return income > 0 ? saved / income : 0;
}

/**
 * Compute a full report from the ledger over an optional month range.
 *
 * Transactions are filtered to the range, dropped if {@link isAnalyticsExcluded},
 * and otherwise summed by month and category. Rows missing amount_eur are
 * counted (never guessed). Returns months ascending plus an overall roll-up.
 */
export function buildReport(
  txs: readonly Transaction[],
  range: ReportRange = {},
  tiers?: Tiers,
): Report {
  // Floor/flex is only meaningful when a mandatory side has actually been declared.
  // Without it, every row would fall to "optional" and misreport the floor as €0.
  const splitTiers = tiers !== undefined && tiersConfigured(tiers);
  const monthAccs = new Map<string, MonthAcc>();
  const overallAmounts = new Map<string, number>();
  const overallCounts = new Map<string, number>();
  let overallIncome = 0;
  let overallSpend = 0;
  let overallInvested = 0;
  let overallFloor = 0;
  let overallFlex = 0;
  let overallMissing = 0;
  let overallCounted = 0;
  let consideredRows = 0;
  let excludedRows = 0;

  for (const tx of txs) {
    const month = monthOf(tx.date);
    if (!inRange(month, range)) continue;
    consideredRows += 1;

    const getAcc = (): MonthAcc => {
      let a = monthAccs.get(month);
      if (a === undefined) {
        a = newMonthAcc();
        monthAccs.set(month, a);
      }
      return a;
    };

    // Money moved into a savings/investment account is excluded from income &
    // spend (it's a transfer, not consumption) but surfaced as `invested` so the
    // act of putting money aside is never invisible.
    if (tx.category === SAVINGS_CATEGORY && tx.amount_eur !== null) {
      const amt = Math.abs(tx.amount_eur);
      getAcc().invested += amt;
      overallInvested += amt;
    }

    if (isAnalyticsExcluded(tx)) {
      excludedRows += 1;
      continue;
    }

    const acc = getAcc();

    if (tx.amount_eur === null) {
      acc.missingEurCount += 1;
      overallMissing += 1;
      continue; // cannot sum a row with no EUR value — count it, don't guess
    }

    overallCounted += 1;
    const eur = tx.amount_eur;
    if (eur > 0) {
      acc.income += eur;
      overallIncome += eur;
    } else if (eur < 0) {
      const abs = -eur;
      acc.spend += abs;
      overallSpend += abs;
      const category = spendCategoryOf(tx);
      acc.categoryAmounts.set(category, (acc.categoryAmounts.get(category) ?? 0) + abs);
      acc.categoryCounts.set(category, (acc.categoryCounts.get(category) ?? 0) + 1);
      overallAmounts.set(category, (overallAmounts.get(category) ?? 0) + abs);
      overallCounts.set(category, (overallCounts.get(category) ?? 0) + 1);
      // Floor vs flex: classify by the SAME spend rows so floor + flex === spend.
      // Tier reads the resolved category (incl. "Uncategorized"/"Bank fees") and
      // the raw merchant — recurrence plays no part here; obligation does.
      if (splitTiers) {
        const tier = tierOf(tiers!, category, tx.merchant_raw);
        if (tier === "mandatory") {
          acc.floor += abs;
          overallFloor += abs;
        } else {
          acc.flex += abs;
          overallFlex += abs;
        }
      }
    }
    // eur === 0 contributes to neither income nor spend by definition.
  }

  const months: MonthSummary[] = [...monthAccs.keys()]
    .sort()
    .map((month) => {
      const acc = monthAccs.get(month)!;
      const income = round2(acc.income);
      const spend = round2(acc.spend);
      const saved = round2(income - spend);
      return {
        month,
        income,
        spend,
        saved,
        savingsRate: savingsRateOf(income, saved),
        invested: round2(acc.invested),
        floor: splitTiers ? round2(acc.floor) : null,
        flex: splitTiers ? round2(acc.flex) : null,
        categories: finalizeCategories(acc.categoryAmounts, acc.categoryCounts, spend),
        missingEurCount: acc.missingEurCount,
      };
    });

  const overallIncomeR = round2(overallIncome);
  const overallSpendR = round2(overallSpend);
  const overallSaved = round2(overallIncomeR - overallSpendR);

  const overall: OverallSummary = {
    income: overallIncomeR,
    spend: overallSpendR,
    saved: overallSaved,
    savingsRate: savingsRateOf(overallIncomeR, overallSaved),
    invested: round2(overallInvested),
    floor: splitTiers ? round2(overallFloor) : null,
    flex: splitTiers ? round2(overallFlex) : null,
    monthCount: months.length,
    categories: finalizeCategories(overallAmounts, overallCounts, overallSpendR),
    missingEurCount: overallMissing,
    countedRows: overallCounted,
  };

  return { months, overall, consideredRows, excludedRows };
}

/**
 * Pick the detail month for the default (no-flag) text view: the most recent
 * COMPLETE month, i.e. the latest month strictly before the current calendar
 * month. Falls back to the latest available month when no earlier month exists
 * (e.g. the ledger only contains the current month). Returns null for an empty
 * report. `now` is injectable so the choice is deterministic and testable.
 */
export function latestCompleteMonth(report: Report, now: Date = new Date()): string | null {
  if (report.months.length === 0) return null;
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const complete = report.months.filter((m) => m.month < currentMonth);
  if (complete.length > 0) return complete[complete.length - 1]!.month;
  return report.months[report.months.length - 1]!.month;
}

// --- Spend grouping: tier -> category -> transactions -----------------------

/** One spend transaction, the leaf of the grouped view. */
export interface SpendTxn {
  date: string;
  merchant: string;
  eur: number; // positive magnitude
  account: string;
}

/** A category within a tier: its total and the transactions that make it up. */
export interface SpendCategoryGroup {
  category: string;
  total: number;
  count: number;
  txns: SpendTxn[];
}

/** "mandatory" (the stuff you owe no matter what) vs "non-mandatory" (choice). */
export type SpendTier = "mandatory" | "non-mandatory";

/** All spend in one tier, broken into categories. */
export interface SpendTierGroup {
  tier: SpendTier;
  total: number;
  categories: SpendCategoryGroup[];
}

/**
 * Group real spend into mandatory vs non-mandatory, then by category, with the
 * underlying transactions kept on each category so the UI can unfold it. `period`
 * is a date prefix: "2026-05" selects one month, "2026" the whole year. Same
 * exclusion + categorization rules as {@link buildReport}, so the totals match.
 * Mandatory is read from tiers (the floor); when no tiers are configured every
 * row falls to non-mandatory. Tiers come back mandatory-first, categories by
 * total desc, transactions by amount desc.
 */
export function buildSpendGroups(
  txs: readonly Transaction[],
  period: string,
  tiers?: Tiers,
): SpendTierGroup[] {
  const splitTiers = tiers !== undefined && tiersConfigured(tiers);
  // tier -> category -> accumulator
  const byTier = new Map<SpendTier, Map<string, SpendCategoryGroup>>([
    ["mandatory", new Map()],
    ["non-mandatory", new Map()],
  ]);

  for (const tx of txs) {
    if (!tx.date.startsWith(period)) continue; // "2026-05" -> a month, "2026" -> a year
    if (isAnalyticsExcluded(tx)) continue;
    if (tx.amount_eur === null || tx.amount_eur >= 0) continue; // spend only
    const abs = -tx.amount_eur;
    const category = spendCategoryOf(tx);
    const tier: SpendTier =
      splitTiers && tierOf(tiers!, category, tx.merchant_raw) === "mandatory" ? "mandatory" : "non-mandatory";

    const cats = byTier.get(tier)!;
    let group = cats.get(category);
    if (group === undefined) {
      group = { category, total: 0, count: 0, txns: [] };
      cats.set(category, group);
    }
    group.total += abs;
    group.count += 1;
    group.txns.push({ date: tx.date, merchant: tx.merchant_raw, eur: round2(abs), account: tx.account });
  }

  const tierOrder: SpendTier[] = ["mandatory", "non-mandatory"];
  const out: SpendTierGroup[] = [];
  for (const tier of tierOrder) {
    const cats = [...byTier.get(tier)!.values()].map((g) => ({
      ...g,
      total: round2(g.total),
      txns: [...g.txns].sort((a, b) => b.eur - a.eur || (a.date < b.date ? 1 : -1)),
    }));
    cats.sort((a, b) => b.total - a.total || (a.category < b.category ? -1 : 1));
    const total = round2(cats.reduce((s, c) => s + c.total, 0));
    out.push({ tier, total, categories: cats });
  }
  return out;
}
