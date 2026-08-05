/**
 * The EÜR builder (§ 4 Abs. 3 EStG): deterministic arithmetic over the tax
 * axis of the ledger, mapped onto Anlage EÜR lines via the country pack.
 *
 * What counts:
 *   - every ledger row with tax_person = <who> and a date inside the year
 *   - income categories net their signed sums (Stornos subtract)
 *   - expense categories sum as positive cost figures
 *   - a gross `split` category (Bewirtung) is split deterministically at
 *     report time (70/30); pre-split rows (Lexoffice) pass through untouched
 *   - `nondeductible` categories are shown but excluded from the profit
 *   - `neutral` categories (Privateinlage/-entnahme) are listed, in no total
 *   - AfA comes from profiles/<who>/assets.json, straight-line by months in
 *     service, useful_life_months <= 1 = full write-off in the acquisition
 *     year (the BMF 26.02.2021 one-year rule for computer hardware — the
 *     Norman lesson: auto-amortisation must be visible and overridable)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Transaction } from "../types.ts";
import type { TaxPack, PackCategory } from "./pack.ts";

export interface Asset {
  label: string;
  /** ISO date the asset went into service. */
  acquired: string;
  grossEur: number;
  /** 0..1 business share of the gross. */
  businessShare: number;
  usefulLifeMonths: number;
  note: string;
}

export interface EuerCategoryTotal {
  category: PackCategory;
  rows: number;
  /** Income: net signed sum. Expense: positive cost figure. */
  amountEur: number;
}

export interface EuerReport {
  who: string;
  year: string;
  income: EuerCategoryTotal[];
  expenses: EuerCategoryTotal[];
  neutral: EuerCategoryTotal[];
  /** AfA for the year, per asset. */
  afa: { asset: Asset; claimEur: number }[];
  incomeTotal: number;
  /** Deductible expenses only (incl. AfA), the figure profit subtracts. */
  expenseDeductibleTotal: number;
  /** Non-deductible expense shown beside the report (Bewirtung 30%). */
  expenseNondeductibleTotal: number;
  profit: number;
  /** Reconciliation help: gross positives and corrections on the income side. */
  incomeGross: number;
  incomeCorrections: number;
  /** Rows on the person's books that no pack category matched. */
  unknownCategories: Map<string, { rows: number; amountEur: number }>;
  missingEurRows: number;
}

export function loadAssets(personDir: string): Asset[] {
  const path = join(personDir, "assets.json");
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message})`);
  }
  const list = Array.isArray(raw) ? raw : [];
  return list.map((a: Record<string, unknown>, i: number) => {
    const acquired = String(a.acquired ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(acquired)) {
      throw new Error(`${path}: asset ${i}: acquired must be YYYY-MM-DD`);
    }
    const grossEur = Number(a.gross_eur);
    const businessShare = Number(a.business_share ?? 1);
    const usefulLifeMonths = Number(a.useful_life_months);
    if (!Number.isFinite(grossEur) || grossEur <= 0) {
      throw new Error(`${path}: asset ${i}: gross_eur must be a positive number`);
    }
    if (!(businessShare > 0 && businessShare <= 1)) {
      throw new Error(`${path}: asset ${i}: business_share must be in (0, 1]`);
    }
    if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths < 1) {
      throw new Error(`${path}: asset ${i}: useful_life_months must be a positive integer`);
    }
    return {
      label: String(a.label ?? `asset ${i}`),
      acquired,
      grossEur,
      businessShare,
      usefulLifeMonths,
      note: String(a.note ?? ""),
    };
  });
}

/**
 * AfA claim for one asset in one calendar year. Straight-line over
 * useful_life_months, starting in the acquisition month. A life of 1 month
 * means the full base writes off in the acquisition year (how the one-year
 * Nutzungsdauer is stored so nothing pro-rates into the next year).
 */
export function afaForYear(asset: Asset, year: number): number {
  const base = round2(asset.grossEur * asset.businessShare);
  const startYear = Number(asset.acquired.slice(0, 4));
  const startMonth = Number(asset.acquired.slice(5, 7)); // 1..12
  const startIndex = startYear * 12 + (startMonth - 1);
  const endIndex = startIndex + asset.usefulLifeMonths - 1; // inclusive
  const yearFirst = year * 12;
  const yearLast = year * 12 + 11;
  const from = Math.max(startIndex, yearFirst);
  const to = Math.min(endIndex, yearLast);
  if (to < from) return 0;
  const monthly = base / asset.usefulLifeMonths;
  // Final year takes the remainder so the sum over years is exactly the base.
  const claim = to === endIndex ? base - round2(monthly) * (from - startIndex) : round2(monthly) * (to - from + 1);
  return round2(claim);
}

export function buildEuer(
  ledger: readonly Transaction[],
  who: string,
  year: string,
  pack: TaxPack,
  assets: readonly Asset[],
): EuerReport {
  const rows = ledger.filter((t) => t.tax_person === who && t.date.startsWith(year));

  const totals = new Map<string, { rows: number; amountEur: number }>();
  const unknown = new Map<string, { rows: number; amountEur: number }>();
  let missingEurRows = 0;
  let incomeGross = 0;
  let incomeCorrections = 0;

  const add = (map: Map<string, { rows: number; amountEur: number }>, key: string, eur: number): void => {
    const e = map.get(key) ?? { rows: 0, amountEur: 0 };
    e.rows += 1;
    e.amountEur = round2(e.amountEur + eur);
    map.set(key, e);
  };

  for (const t of rows) {
    if (t.amount_eur === null) {
      missingEurRows += 1;
      continue;
    }
    const cat = pack.categories.get(t.tax_category);
    if (!cat) {
      add(unknown, t.tax_category === "" ? "(undisposed)" : t.tax_category, t.amount_eur);
      continue;
    }
    if (cat.side === "income") {
      if (t.amount_eur >= 0) incomeGross = round2(incomeGross + t.amount_eur);
      else incomeCorrections = round2(incomeCorrections + t.amount_eur);
      add(totals, cat.key, t.amount_eur); // net signed
    } else if (cat.side === "expense") {
      if (cat.split) {
        // Gross Bewirtung row: split deterministically into the pair.
        const cost = -t.amount_eur;
        const deductible = round2(cost * cat.split.deductibleShare);
        add(totals, cat.split.into[0], deductible);
        add(totals, cat.split.into[1], round2(cost - deductible));
      } else {
        add(totals, cat.key, -t.amount_eur); // positive cost figure
      }
    } else {
      add(totals, cat.key, t.amount_eur);
    }
  }

  const income: EuerCategoryTotal[] = [];
  const expenses: EuerCategoryTotal[] = [];
  const neutral: EuerCategoryTotal[] = [];
  for (const [key, agg] of totals) {
    const category = pack.categories.get(key)!;
    const entry = { category, rows: agg.rows, amountEur: agg.amountEur };
    if (category.side === "income") income.push(entry);
    else if (category.side === "expense") expenses.push(entry);
    else neutral.push(entry);
  }
  income.sort((a, b) => b.amountEur - a.amountEur);
  expenses.sort((a, b) => b.amountEur - a.amountEur);

  const yearNum = Number(year);
  const afa = assets
    .map((asset) => ({ asset, claimEur: afaForYear(asset, yearNum) }))
    .filter((a) => a.claimEur !== 0);

  const incomeTotal = round2(income.reduce((s, c) => s + c.amountEur, 0));
  const afaTotal = round2(afa.reduce((s, a) => s + a.claimEur, 0));
  const expenseDeductibleTotal = round2(
    expenses.filter((e) => !e.category.nondeductible).reduce((s, c) => s + c.amountEur, 0) + afaTotal,
  );
  const expenseNondeductibleTotal = round2(
    expenses.filter((e) => e.category.nondeductible).reduce((s, c) => s + c.amountEur, 0),
  );

  return {
    who,
    year,
    income,
    expenses,
    neutral,
    afa,
    incomeTotal,
    expenseDeductibleTotal,
    expenseNondeductibleTotal,
    profit: round2(incomeTotal - expenseDeductibleTotal),
    incomeGross,
    incomeCorrections,
    unknownCategories: unknown,
    missingEurRows,
  };
}

function round2(n: number): number {
  // Decimal-correct half-up rounding: 1814.05 * 0.7 is 1269.834999… in binary
  // float but 1269.835 in decimal, and a tax figure must round to 1269.84.
  // toPrecision(12) snaps the binary noise back to the decimal value first.
  const r = Math.round(Number((n * 100).toPrecision(12))) / 100;
  return r === 0 ? 0 : r;
}
