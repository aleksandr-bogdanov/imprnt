import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tx } from "../test-helpers.ts";
import { loadPack } from "./pack.ts";
import { afaForYear, buildEuer, type Asset } from "./euer.ts";

// The real shipped Germany pack — the tests double as a pack sanity check.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pack = loadPack(ROOT, "de");

const book = (over: Parameters<typeof tx>[0]) =>
  tx({ tax_person: "anna", tax_source: "import", ...over });

describe("buildEuer", () => {
  test("income nets Stornos; gross and corrections are reported separately", () => {
    const ledger = [
      book({ tax_category: "revenue_ku", amount_eur: 480, amount_native: 480, type: "income", date: "2026-03-23" }),
      book({ tax_category: "revenue_ku", amount_eur: -480, amount_native: -480, type: "income", date: "2026-03-23" }),
      book({ tax_category: "revenue_ku", amount_eur: 250, amount_native: 250, type: "income", date: "2026-05-26" }),
    ];
    const r = buildEuer(ledger, "anna", "2026", pack, []);
    expect(r.incomeTotal).toBe(250);
    expect(r.incomeGross).toBe(730);
    expect(r.incomeCorrections).toBe(-480);
  });

  test("pre-split Bewirtung passes through; only the 70% side is deductible", () => {
    const ledger = [
      book({ tax_category: "meals_deductible", amount_eur: -29.26, date: "2026-02-26" }),
      book({ tax_category: "meals_nondeductible", amount_eur: -12.54, date: "2026-02-26" }),
    ];
    const r = buildEuer(ledger, "anna", "2026", pack, []);
    expect(r.expenseDeductibleTotal).toBe(29.26);
    expect(r.expenseNondeductibleTotal).toBe(12.54);
    expect(r.profit).toBe(-29.26);
  });

  test("a gross meals row splits 70/30 deterministically at report time", () => {
    const ledger = [book({ tax_category: "meals", amount_eur: -388.36, date: "2026-06-01" })];
    const r = buildEuer(ledger, "anna", "2026", pack, []);
    // 388.36 * 0.7 = 271.852 -> 271.85, remainder 116.51 (the Norman-verified split).
    expect(r.expenseDeductibleTotal).toBe(271.85);
    expect(r.expenseNondeductibleTotal).toBe(116.51);
  });

  test("neutral categories and other persons' rows stay out of every total", () => {
    const ledger = [
      book({ tax_category: "capital_contribution", amount_eur: 500, type: "income", date: "2026-01-01" }),
      book({ tax_category: "revenue_ku", amount_eur: 100, type: "income", date: "2026-01-02" }),
      tx({ tax_person: "alex", tax_category: "software", tax_source: "rule", amount_eur: -50, date: "2026-01-03" }),
    ];
    const r = buildEuer(ledger, "anna", "2026", pack, []);
    expect(r.incomeTotal).toBe(100);
    expect(r.expenseDeductibleTotal).toBe(0);
    expect(r.neutral.length).toBe(1);
  });

  test("undisposed and unknown categories surface instead of vanishing", () => {
    const ledger = [book({ tax_category: "", amount_eur: -10, date: "2026-01-01" })];
    const r = buildEuer(ledger, "anna", "2026", pack, []);
    expect(r.unknownCategories.get("(undisposed)")!.rows).toBe(1);
    expect(r.profit).toBe(0);
  });
});

describe("afaForYear", () => {
  const base: Asset = {
    label: "workstation",
    acquired: "2026-08-04",
    grossEur: 1814.05,
    businessShare: 0.7,
    usefulLifeMonths: 1,
    note: "",
  };

  test("one-year rule (life=1): the full business share writes off in the acquisition year", () => {
    expect(afaForYear(base, 2026)).toBe(1269.84);
    expect(afaForYear(base, 2027)).toBe(0);
  });

  test("36-month life pro-rates by months in service and sums exactly to the base", () => {
    const a = { ...base, usefulLifeMonths: 36 };
    const y2026 = afaForYear(a, 2026); // Aug-Dec = 5 months
    const y2027 = afaForYear(a, 2027); // 12 months
    const y2028 = afaForYear(a, 2028);
    const y2029 = afaForYear(a, 2029); // remainder
    expect(y2026).toBe(176.35); // 1269.84/36 = 35.27/mo * 5
    expect(y2027).toBe(423.24);
    expect(round2(y2026 + y2027 + y2028 + y2029)).toBe(1269.84);
    expect(afaForYear(a, 2030)).toBe(0);
  });

  test("a year before acquisition claims nothing", () => {
    expect(afaForYear(base, 2025)).toBe(0);
  });
});

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
