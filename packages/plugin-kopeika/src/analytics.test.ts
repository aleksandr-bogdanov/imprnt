import { describe, expect, test } from "bun:test";
import {
  buildReport,
  buildSpendGroups,
  isAnalyticsExcluded,
  latestCompleteMonth,
  BANK_FEES_CATEGORY,
  UNCATEGORIZED_CATEGORY,
  EXCLUDE_CATEGORY,
  SAVINGS_CATEGORY,
} from "./analytics.ts";
import { tx } from "./test-helpers.ts";
import type { Tiers } from "./tiers.ts";
import type { Transaction } from "./types.ts";

describe("isAnalyticsExcluded", () => {
  test("matched internal transfer is excluded", () => {
    expect(isAnalyticsExcluded(tx({ is_transfer: true }))).toBe(true);
  });

  test("type transfer / exchange excluded", () => {
    expect(isAnalyticsExcluded(tx({ type: "transfer" }))).toBe(true);
    expect(isAnalyticsExcluded(tx({ type: "exchange" }))).toBe(true);
  });

  test('category "Exclude" excluded', () => {
    expect(isAnalyticsExcluded(tx({ category: EXCLUDE_CATEGORY }))).toBe(true);
  });

  test("ordinary spend is NOT excluded", () => {
    expect(isAnalyticsExcluded(tx({ type: "spend", category: "Groceries" }))).toBe(false);
  });
});

describe("buildReport per-month aggregation", () => {
  const txs: Transaction[] = [
    tx({ date: "2025-01-05", amount_eur: 2000, type: "income", merchant_raw: "Salary" }),
    tx({ date: "2025-01-10", amount_eur: -500, type: "spend", category: "Rent" }),
    tx({ date: "2025-01-15", amount_eur: -100, type: "spend", category: "Groceries" }),
    tx({ date: "2025-02-05", amount_eur: 2000, type: "income", merchant_raw: "Salary" }),
    tx({ date: "2025-02-20", amount_eur: -300, type: "spend", category: "Groceries" }),
  ];

  test("income, spend, saved per month", () => {
    const r = buildReport(txs);
    expect(r.months.map((m) => m.month)).toEqual(["2025-01", "2025-02"]);
    const jan = r.months[0]!;
    expect(jan.income).toBe(2000);
    expect(jan.spend).toBe(600);
    expect(jan.saved).toBe(1400);
    const feb = r.months[1]!;
    expect(feb.spend).toBe(300);
    expect(feb.saved).toBe(1700);
  });

  test("savings rate = saved / income", () => {
    const r = buildReport(txs);
    expect(r.months[0]!.savingsRate).toBeCloseTo(1400 / 2000, 10);
  });

  test("overall roll-up sums months", () => {
    const r = buildReport(txs);
    expect(r.overall.income).toBe(4000);
    expect(r.overall.spend).toBe(900);
    expect(r.overall.saved).toBe(3100);
    expect(r.overall.monthCount).toBe(2);
  });

  test("category breakdown sorted by amount desc with shares", () => {
    const r = buildReport(txs);
    const cats = r.overall.categories;
    expect(cats[0]!.category).toBe("Rent");
    expect(cats[0]!.amount).toBe(500);
    expect(cats[0]!.share).toBeCloseTo(500 / 900, 10);
    expect(cats[1]!.category).toBe("Groceries");
    expect(cats[1]!.amount).toBe(400);
  });
});

describe("buildReport exclusion of transfers / exchanges / Exclude", () => {
  test("transfers, exchanges and Exclude rows do NOT count as income or spend", () => {
    const txs: Transaction[] = [
      tx({ date: "2025-01-01", amount_eur: -100, type: "spend", category: "Groceries" }),
      tx({ date: "2025-01-02", amount_eur: -1000, type: "transfer", is_transfer: true }),
      tx({ date: "2025-01-03", amount_eur: -500, type: "exchange" }),
      tx({ date: "2025-01-04", amount_eur: -50, category: EXCLUDE_CATEGORY, type: "spend" }),
      tx({ date: "2025-01-05", amount_eur: 3000, type: "income" }),
    ];
    const r = buildReport(txs);
    expect(r.overall.spend).toBe(100); // only the Groceries row
    expect(r.overall.income).toBe(3000);
    expect(r.excludedRows).toBe(3);
    expect(r.consideredRows).toBe(5);
  });

  test("Savings rows are excluded from spend but surfaced as invested", () => {
    const txs: Transaction[] = [
      tx({ date: "2025-01-01", amount_eur: -1500, type: "transfer", category: SAVINGS_CATEGORY, is_transfer: true }),
      tx({ date: "2025-01-02", amount_eur: -100, type: "spend", category: "Groceries" }),
    ];
    const r = buildReport(txs);
    expect(r.overall.invested).toBe(1500);
    expect(r.overall.spend).toBe(100); // savings transfer not in spend
    expect(r.months[0]!.invested).toBe(1500);
  });
});

describe("buildReport spend bucketing", () => {
  test("fee-type rows bucket to Bank fees", () => {
    const txs: Transaction[] = [tx({ date: "2025-01-01", amount_eur: -2, type: "fee", category: "" })];
    const r = buildReport(txs);
    expect(r.overall.categories[0]!.category).toBe(BANK_FEES_CATEGORY);
  });

  test("uncategorized non-fee spend buckets to Uncategorized", () => {
    const txs: Transaction[] = [tx({ date: "2025-01-01", amount_eur: -2, type: "spend", category: "" })];
    const r = buildReport(txs);
    expect(r.overall.categories[0]!.category).toBe(UNCATEGORIZED_CATEGORY);
  });
});

describe("buildReport missing-FX handling", () => {
  test("rows with null amount_eur are counted, never guessed", () => {
    const txs: Transaction[] = [
      tx({ date: "2025-01-01", amount_eur: null, type: "spend", category: "Groceries" }),
      tx({ date: "2025-01-02", amount_eur: -50, type: "spend", category: "Groceries" }),
    ];
    const r = buildReport(txs);
    expect(r.overall.spend).toBe(50);
    expect(r.overall.missingEurCount).toBe(1);
    expect(r.overall.countedRows).toBe(1);
    expect(r.months[0]!.missingEurCount).toBe(1);
  });
});

describe("buildReport range filtering", () => {
  const txs: Transaction[] = [
    tx({ date: "2025-01-01", amount_eur: -10, type: "spend" }),
    tx({ date: "2025-02-01", amount_eur: -20, type: "spend" }),
    tx({ date: "2025-03-01", amount_eur: -30, type: "spend" }),
  ];

  test("from is an inclusive lower bound", () => {
    const r = buildReport(txs, { from: "2025-02" });
    expect(r.months.map((m) => m.month)).toEqual(["2025-02", "2025-03"]);
  });

  test("month selects a single month and takes precedence over from", () => {
    const r = buildReport(txs, { from: "2025-01", month: "2025-02" });
    expect(r.months.map((m) => m.month)).toEqual(["2025-02"]);
  });
});

describe("buildReport floor vs flex split", () => {
  const tiers: Tiers = { mandatoryCategories: new Set(["rent"]), mandatoryMerchants: [] };
  const txs: Transaction[] = [
    tx({ date: "2025-01-01", amount_eur: -500, type: "spend", category: "Rent" }),
    tx({ date: "2025-01-02", amount_eur: -100, type: "spend", category: "Groceries" }),
  ];

  test("floor + flex === spend when tiers configured", () => {
    const r = buildReport(txs, {}, tiers);
    expect(r.overall.floor).toBe(500);
    expect(r.overall.flex).toBe(100);
    expect((r.overall.floor ?? 0) + (r.overall.flex ?? 0)).toBe(r.overall.spend);
    expect(r.months[0]!.floor).toBe(500);
    expect(r.months[0]!.flex).toBe(100);
  });

  test("floor/flex are null when no tiers configured (floor unknown, not zero)", () => {
    const r = buildReport(txs);
    expect(r.overall.floor).toBeNull();
    expect(r.overall.flex).toBeNull();
    expect(r.months[0]!.floor).toBeNull();
  });

  test("empty (unconfigured) tiers also yield null floor/flex", () => {
    const empty: Tiers = { mandatoryCategories: new Set(), mandatoryMerchants: [] };
    const r = buildReport(txs, {}, empty);
    expect(r.overall.floor).toBeNull();
  });
});

describe("latestCompleteMonth (injectable now)", () => {
  test("returns the latest month strictly before the current calendar month", () => {
    const txs: Transaction[] = [
      tx({ date: "2025-01-01", amount_eur: -10, type: "spend" }),
      tx({ date: "2025-02-01", amount_eur: -10, type: "spend" }),
      tx({ date: "2025-03-01", amount_eur: -10, type: "spend" }),
    ];
    const r = buildReport(txs);
    expect(latestCompleteMonth(r, new Date("2025-03-15T00:00:00Z"))).toBe("2025-02");
  });

  test("falls back to the latest month when only the current month exists", () => {
    const txs: Transaction[] = [tx({ date: "2025-03-01", amount_eur: -10, type: "spend" })];
    const r = buildReport(txs);
    expect(latestCompleteMonth(r, new Date("2025-03-15T00:00:00Z"))).toBe("2025-03");
  });

  test("empty report -> null", () => {
    expect(latestCompleteMonth(buildReport([]), new Date("2025-03-15T00:00:00Z"))).toBeNull();
  });
});

describe("buildSpendGroups", () => {
  const tiers: Tiers = {
    mandatoryCategories: new Set(["rent", "subscriptions"]),
    mandatoryMerchants: [],
  };
  const txs: Transaction[] = [
    tx({ date: "2026-05-03", amount_eur: -900, category: "Rent", merchant_raw: "GEHAG" }),
    tx({ date: "2026-05-05", amount_eur: -12, category: "Subscriptions", merchant_raw: "Claude" }),
    tx({ date: "2026-05-09", amount_eur: -40, category: "Subscriptions", merchant_raw: "Spotify" }),
    tx({ date: "2026-05-10", amount_eur: -60, category: "Groceries", merchant_raw: "REWE" }),
    tx({ date: "2026-05-20", amount_eur: -30, category: "Groceries", merchant_raw: "ALDI" }),
    tx({ date: "2026-05-22", amount_eur: -25, category: "Eating out", merchant_raw: "Pizza" }),
    tx({ date: "2026-05-25", amount_eur: 2000, type: "income", merchant_raw: "Salary" }), // income, ignored
    tx({ date: "2026-05-26", amount_eur: -500, is_transfer: true, merchant_raw: "to broker" }), // transfer, excluded
    tx({ date: "2026-04-15", amount_eur: -99, category: "Groceries" }), // other month, ignored
  ];

  test("splits mandatory vs non-mandatory with matching totals", () => {
    const groups = buildSpendGroups(txs, "2026-05", tiers);
    expect(groups.map((g) => g.tier)).toEqual(["mandatory", "non-mandatory"]);
    const mand = groups[0]!;
    const flex = groups[1]!;
    expect(mand.total).toBe(900 + 12 + 40); // Rent + Subscriptions
    expect(flex.total).toBe(60 + 30 + 25); // Groceries + Eating out
  });

  test("categories sorted by total desc, each carrying its transactions", () => {
    const groups = buildSpendGroups(txs, "2026-05", tiers);
    const mand = groups[0]!;
    expect(mand.categories.map((c) => c.category)).toEqual(["Rent", "Subscriptions"]);
    const subs = mand.categories.find((c) => c.category === "Subscriptions")!;
    expect(subs.count).toBe(2);
    expect(subs.txns.map((t) => t.merchant)).toEqual(["Spotify", "Claude"]); // 40 before 12
  });

  test("no tiers configured -> everything is non-mandatory", () => {
    const groups = buildSpendGroups(txs, "2026-05");
    expect(groups[0]!.total).toBe(0);
    expect(groups[0]!.categories).toHaveLength(0);
    expect(groups[1]!.total).toBe(900 + 12 + 40 + 60 + 30 + 25);
  });
});
