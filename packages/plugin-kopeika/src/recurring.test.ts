import { describe, expect, test } from "bun:test";
import { detectRecurring } from "./recurring.ts";
import { tx } from "./test-helpers.ts";
import type { Tiers } from "./tiers.ts";
import type { Transaction } from "./types.ts";

const NO_TIERS: Tiers = { mandatoryCategories: new Set(), mandatoryMerchants: [] };

/** N monthly spend rows for one merchant, months YYYY-MM01..0N. */
function monthlySpend(merchant: string, months: string[], eur = -10): Transaction[] {
  return months.map((m) =>
    tx({ merchant_raw: merchant, date: `${m}-05`, amount_eur: eur, type: "spend", account: "n26" }),
  );
}

describe("detectRecurring threshold (default minMonths = 4)", () => {
  test("3 distinct months does NOT qualify", () => {
    const txs = monthlySpend("Netflix", ["2025-01", "2025-02", "2025-03"]);
    expect(detectRecurring(txs, NO_TIERS)).toHaveLength(0);
  });

  test("4 distinct months DOES qualify (boundary)", () => {
    const txs = monthlySpend("Netflix", ["2025-01", "2025-02", "2025-03", "2025-04"]);
    const out = detectRecurring(txs, NO_TIERS);
    expect(out).toHaveLength(1);
    expect(out[0]!.merchant_raw).toBe("Netflix");
    expect(out[0]!.monthsCount).toBe(4);
  });

  test("multiple charges in the SAME month count as one distinct month", () => {
    const txs = [
      ...monthlySpend("Netflix", ["2025-01", "2025-01", "2025-01"]),
      ...monthlySpend("Netflix", ["2025-02"]),
    ];
    expect(detectRecurring(txs, NO_TIERS)).toHaveLength(0); // only 2 distinct months
  });

  test("custom minMonths is honored", () => {
    const txs = monthlySpend("Spotify", ["2025-01", "2025-02"]);
    expect(detectRecurring(txs, NO_TIERS, { minMonths: 2 })).toHaveLength(1);
  });
});

describe("detectRecurring spend filtering", () => {
  test("income rows (positive eur) are not counted", () => {
    const txs = [
      tx({ merchant_raw: "Employer", date: "2025-01-01", amount_eur: 1000, type: "income" }),
      tx({ merchant_raw: "Employer", date: "2025-02-01", amount_eur: 1000, type: "income" }),
      tx({ merchant_raw: "Employer", date: "2025-03-01", amount_eur: 1000, type: "income" }),
      tx({ merchant_raw: "Employer", date: "2025-04-01", amount_eur: 1000, type: "income" }),
    ];
    expect(detectRecurring(txs, NO_TIERS)).toHaveLength(0);
  });

  test("analytics-excluded rows (transfers) are not counted", () => {
    const txs = ["2025-01", "2025-02", "2025-03", "2025-04"].map((m) =>
      tx({ merchant_raw: "Self", date: `${m}-01`, amount_eur: -100, type: "transfer", is_transfer: true }),
    );
    expect(detectRecurring(txs, NO_TIERS)).toHaveLength(0);
  });

  test("rows with missing amount_eur are skipped", () => {
    const txs = ["2025-01", "2025-02", "2025-03", "2025-04"].map((m) =>
      tx({ merchant_raw: "Foreign", date: `${m}-01`, amount_eur: null, type: "spend" }),
    );
    expect(detectRecurring(txs, NO_TIERS)).toHaveLength(0);
  });

  test("blank merchant_raw is skipped (cannot be tagged once-forever)", () => {
    const txs = monthlySpend("  ", ["2025-01", "2025-02", "2025-03", "2025-04"]);
    expect(detectRecurring(txs, NO_TIERS)).toHaveLength(0);
  });
});

describe("detectRecurring --from filter", () => {
  test("from excludes earlier months, dropping below threshold", () => {
    const txs = monthlySpend("Netflix", ["2025-01", "2025-02", "2025-03", "2025-04"]);
    // Only 2025-03 and 2025-04 survive -> 2 distinct months -> below 4.
    expect(detectRecurring(txs, NO_TIERS, { from: "2025-03" })).toHaveLength(0);
  });

  test("from is inclusive of its own month", () => {
    const txs = monthlySpend("Netflix", ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"]);
    const out = detectRecurring(txs, NO_TIERS, { from: "2025-03" });
    expect(out).toHaveLength(1);
    expect(out[0]!.monthsCount).toBe(4); // 03,04,05,06
    expect(out[0]!.firstMonth).toBe("2025-03");
  });
});

describe("detectRecurring output shape + sort", () => {
  test("perMonth = totalEur / monthsCount and sort is by perMonth desc", () => {
    const txs = [
      ...monthlySpend("Rent", ["2025-01", "2025-02", "2025-03", "2025-04"], -1000),
      ...monthlySpend("Coffee", ["2025-01", "2025-02", "2025-03", "2025-04"], -5),
    ];
    const out = detectRecurring(txs, NO_TIERS);
    expect(out.map((r) => r.merchant_raw)).toEqual(["Rent", "Coffee"]);
    expect(out[0]!.totalEur).toBe(4000);
    expect(out[0]!.perMonth).toBe(1000);
  });

  test("tier tag comes from the tiers argument", () => {
    const tiers: Tiers = { mandatoryCategories: new Set(["rent"]), mandatoryMerchants: [] };
    const txs = monthlySpend("Landlord", ["2025-01", "2025-02", "2025-03", "2025-04"], -1000).map((t) => ({
      ...t,
      category: "Rent",
    }));
    const out = detectRecurring(txs, tiers);
    expect(out[0]!.tier).toBe("mandatory");
    expect(out[0]!.category).toBe("Rent");
  });

  test("category falls back to dash when no row carries one", () => {
    const txs = monthlySpend("Mystery", ["2025-01", "2025-02", "2025-03", "2025-04"]);
    expect(detectRecurring(txs, NO_TIERS)[0]!.category).toBe("—");
  });

  test("accounts and first/last month are tracked", () => {
    const txs = [
      tx({ merchant_raw: "M", date: "2025-01-01", amount_eur: -10, type: "spend", account: "n26" }),
      tx({ merchant_raw: "M", date: "2025-02-01", amount_eur: -10, type: "spend", account: "revolut" }),
      tx({ merchant_raw: "M", date: "2025-03-01", amount_eur: -10, type: "spend", account: "n26" }),
      tx({ merchant_raw: "M", date: "2025-04-01", amount_eur: -10, type: "spend", account: "revolut" }),
    ];
    const out = detectRecurring(txs, NO_TIERS)[0]!;
    expect(out.accounts).toEqual(["n26", "revolut"]);
    expect(out.firstMonth).toBe("2025-01");
    expect(out.lastMonth).toBe("2025-04");
  });
});
