/**
 * Foreign-exchange conversion to EUR.
 *
 * Rates live in data/rates.csv with columns: month(YYYY-MM),currency,rate_to_eur.
 * amount_eur = amount_native * rate_to_eur. EUR always converts at 1 (no rate
 * row required). A month of `*` is a wildcard fallback that applies to any month
 * for that currency. Resolution order for a (month, currency) lookup:
 *   1. exact (month, currency)
 *   2. wildcard (*, currency)
 *   3. EUR -> rate 1
 *   4. otherwise: amount_eur left null and the missing pair reported.
 * kopeika never guesses a rate.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseCsv } from "./csv.ts";
import type { Transaction } from "./types.ts";

export interface RateTable {
  /** key = `${month}|${currency}` (currency upper-cased). */
  rates: Map<string, number>;
}

export interface FxResult {
  amount_eur: number | null;
  /** Set when conversion failed for lack of a rate. */
  missing: { month: string; currency: string } | null;
}

/**
 * Load data/rates.csv. A missing file yields an empty table (only EUR converts).
 * A row whose month is `*` is stored as a wildcard key (`*|CUR`) and used as the
 * fallback when no exact (month, currency) row exists — see {@link toEur}.
 */
export function loadRates(path: string): RateTable {
  const rates = new Map<string, number>();
  if (!existsSync(path)) {
    return { rates };
  }
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) {
    return { rates };
  }
  const { records } = parseCsv(text);
  for (const rec of records) {
    const month = rec.get("month").trim();
    const currency = rec.get("currency").trim().toUpperCase();
    const raw = rec.get("rate_to_eur").trim();
    if (month === "" && currency === "" && raw === "") continue; // tolerate blank line
    const rate = Number(raw);
    if (!Number.isFinite(rate)) {
      throw new Error(
        `loadRates: non-numeric rate_to_eur "${raw}" for ${month}/${currency} in ${path}`,
      );
    }
    rates.set(`${month}|${currency}`, rate);
  }
  return { rates };
}

/** Extract YYYY-MM from an ISO YYYY-MM-DD date. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/**
 * Convert a native amount to EUR for a given date.
 * EUR passes through unchanged. Any other currency resolves in order:
 * exact (month, currency) -> wildcard (*, currency). When neither matches, the
 * amount is left null and the missing pair reported — kopeika never guesses.
 */
export function toEur(amount_native: number, currency: string, isoDate: string, table: RateTable): FxResult {
  const cur = currency.toUpperCase();
  if (cur === "EUR") {
    return { amount_eur: amount_native, missing: null };
  }
  const month = monthOf(isoDate);
  // Exact month wins; the `*` wildcard row is the any-month fallback.
  const rate = table.rates.get(`${month}|${cur}`) ?? table.rates.get(`*|${cur}`);
  if (rate === undefined) {
    return { amount_eur: null, missing: { month, currency: cur } };
  }
  return { amount_eur: round2(amount_native * rate), missing: null };
}

/**
 * Backfill amount_eur on rows imported before their FX rate existed. A row whose
 * (month, currency) now resolves in the table gets amount_native * rate — pure
 * deterministic arithmetic, the same conversion import would have done. Rows
 * whose rate is still missing stay null (kopeika never guesses). Mutates the
 * rows in place and returns how many were filled, so callers know whether the
 * ledger needs rewriting.
 */
export function backfillEur(txs: readonly Transaction[], table: RateTable): number {
  let filled = 0;
  for (const tx of txs) {
    if (tx.amount_eur !== null) continue;
    const fx = toEur(tx.amount_native, tx.currency, tx.date, table);
    if (fx.amount_eur !== null) {
      tx.amount_eur = fx.amount_eur;
      filled += 1;
    }
  }
  return filled;
}

/**
 * Look up a currency's rate_to_eur (how many EUR one unit is worth), using the
 * same exact-then-wildcard resolution as {@link toEur}. EUR is always 1. Returns
 * null when no rate is known — callers decide what to do rather than guess. Used
 * by the projection to render a EUR figure in RUB (RUB-per-EUR = 1 / this).
 */
export function rateToEur(table: RateTable, currency: string, isoDate?: string): number | null {
  const cur = currency.toUpperCase();
  if (cur === "EUR") return 1;
  if (isoDate !== undefined) {
    const exact = table.rates.get(`${monthOf(isoDate)}|${cur}`);
    if (exact !== undefined) return exact;
  }
  return table.rates.get(`*|${cur}`) ?? null;
}

/** Round to 2 decimals, avoiding negative-zero. */
export function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r;
}
