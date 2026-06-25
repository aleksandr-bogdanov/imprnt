import { describe, expect, test } from "bun:test";
import { loadRates, toEur, monthOf, round2, type RateTable } from "./fx.ts";
import { tmpCsv, cleanupTmp } from "./test-helpers.ts";

/** Build a RateTable inline without touching disk. */
function table(entries: Record<string, number>): RateTable {
  return { rates: new Map(Object.entries(entries)) };
}

describe("monthOf", () => {
  test("extracts YYYY-MM from an ISO date", () => {
    expect(monthOf("2025-03-09")).toBe("2025-03");
  });
});

describe("round2", () => {
  test("rounds to 2 decimals", () => {
    expect(round2(1.005)).toBe(1.01); // epsilon nudge pushes the half up
    expect(round2(2.345)).toBe(2.35);
  });

  test("normalizes negative zero to 0", () => {
    expect(Object.is(round2(-0), 0)).toBe(true);
    expect(Object.is(round2(-0.001), 0)).toBe(true);
  });
});

describe("toEur", () => {
  test("EUR is identity, no rate row needed", () => {
    const r = toEur(-10, "EUR", "2025-01-15", table({}));
    expect(r.amount_eur).toBe(-10);
    expect(r.missing).toBeNull();
  });

  test("EUR identity is case-insensitive on currency", () => {
    expect(toEur(42, "eur", "2025-01-15", table({})).amount_eur).toBe(42);
  });

  test("amount_eur = amount_native * rate for the row's month", () => {
    const t = table({ "2025-01|CZK": 0.04 });
    const r = toEur(-100, "CZK", "2025-01-20", t);
    expect(r.amount_eur).toBe(-4);
    expect(r.missing).toBeNull();
  });

  test("result is rounded to 2 decimals", () => {
    const t = table({ "2025-01|CZK": 0.041234 });
    const r = toEur(100, "CZK", "2025-01-20", t);
    expect(r.amount_eur).toBe(4.12);
  });

  test("exact (month,currency) wins over the wildcard fallback", () => {
    const t = table({ "2025-01|CZK": 0.04, "*|CZK": 0.05 });
    expect(toEur(100, "CZK", "2025-01-20", t).amount_eur).toBe(4);
  });

  test("wildcard (*,currency) used when no exact month row", () => {
    const t = table({ "*|CZK": 0.05 });
    const r = toEur(100, "CZK", "2099-12-31", t);
    expect(r.amount_eur).toBe(5);
    expect(r.missing).toBeNull();
  });

  test("currency lookup is case-insensitive (matches upper-cased keys)", () => {
    const t = table({ "2025-01|TRY": 0.03 });
    expect(toEur(100, "try", "2025-01-05", t).amount_eur).toBe(3);
  });

  test("MISSING (month,currency) leaves amount_eur null and reports it", () => {
    const r = toEur(-100, "CZK", "2025-01-20", table({}));
    expect(r.amount_eur).toBeNull();
    expect(r.missing).toEqual({ month: "2025-01", currency: "CZK" });
  });

  test("missing report carries the upper-cased currency and the row's month", () => {
    const r = toEur(1, "czk", "2024-11-02", table({ "2025-01|CZK": 0.04 }));
    expect(r.missing).toEqual({ month: "2024-11", currency: "CZK" });
  });
});

describe("loadRates", () => {
  test("missing file -> empty table (only EUR converts)", () => {
    const t = loadRates("/no/such/path/rates.csv");
    expect(t.rates.size).toBe(0);
    expect(toEur(10, "EUR", "2025-01-01", t).amount_eur).toBe(10);
    expect(toEur(10, "CZK", "2025-01-01", t).amount_eur).toBeNull();
  });

  test("loads exact and wildcard rows, upper-casing currency", () => {
    const path = tmpCsv(
      "rates.csv",
      "month,currency,rate_to_eur\n2025-01,czk,0.04\n*,try,0.03\n",
    );
    try {
      const t = loadRates(path);
      expect(t.rates.get("2025-01|CZK")).toBe(0.04);
      expect(t.rates.get("*|TRY")).toBe(0.03);
      expect(toEur(100, "CZK", "2025-01-09", t).amount_eur).toBe(4);
      expect(toEur(100, "TRY", "2099-01-09", t).amount_eur).toBe(3);
    } finally {
      cleanupTmp(path);
    }
  });

  test("empty file -> empty table", () => {
    const path = tmpCsv("rates.csv", "");
    try {
      expect(loadRates(path).rates.size).toBe(0);
    } finally {
      cleanupTmp(path);
    }
  });

  test("blank data line is tolerated", () => {
    const path = tmpCsv("rates.csv", "month,currency,rate_to_eur\n,,\n2025-01,CZK,0.04\n");
    try {
      const t = loadRates(path);
      expect(t.rates.size).toBe(1);
      expect(t.rates.get("2025-01|CZK")).toBe(0.04);
    } finally {
      cleanupTmp(path);
    }
  });

  test("non-numeric rate throws", () => {
    const path = tmpCsv("rates.csv", "month,currency,rate_to_eur\n2025-01,CZK,abc\n");
    try {
      expect(() => loadRates(path)).toThrow(/non-numeric rate_to_eur/);
    } finally {
      cleanupTmp(path);
    }
  });
});
