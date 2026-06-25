import { describe, expect, test } from "bun:test";
import {
  loadSavingsConfig,
  savingsConfigured,
  savingsFlowEur,
  savingsFlowByMonth,
  savingsStock,
  savingsStockByMonth,
  savingsSeries,
  recentMonthlyRate,
  type SavingsConfig,
} from "./savings.ts";
import { tx, tmpCsv, cleanupTmp } from "./test-helpers.ts";

/** A config covering both ways savings is declared, plus a manual anchor. */
const CONFIG: SavingsConfig = {
  accounts: [{ match: "trading212", label: "trading212" }],
  markers: [{ match: "house", label: "HOUSE" }],
  anchors: [{ label: "Lump-sum", balanceEur: 10000 }],
};

describe("loadSavingsConfig", () => {
  test("missing file -> empty, not configured", () => {
    const c = loadSavingsConfig("/no/such/savings.csv");
    expect(savingsConfigured(c)).toBe(false);
  });

  test("parses account, marker, and anchor rows", () => {
    const path = tmpCsv(
      "savings.csv",
      "scope,value,balance_eur\naccount,trading212,\nmarker,HOUSE,\nanchor,Lump-sum,10000\n",
    );
    try {
      const c = loadSavingsConfig(path);
      expect(c.accounts).toEqual([{ match: "trading212", label: "trading212" }]);
      expect(c.markers).toEqual([{ match: "house", label: "HOUSE" }]);
      expect(c.anchors).toEqual([{ label: "Lump-sum", balanceEur: 10000 }]);
      expect(savingsConfigured(c)).toBe(true);
    } finally {
      cleanupTmp(path);
    }
  });

  test("anchor without a balance throws", () => {
    const path = tmpCsv("savings.csv", "scope,value,balance_eur\nanchor,Lump-sum,\n");
    try {
      expect(() => loadSavingsConfig(path)).toThrow(/needs a balance_eur/);
    } finally {
      cleanupTmp(path);
    }
  });

  test("unknown scope throws", () => {
    const path = tmpCsv("savings.csv", "scope,value,balance_eur\nfund,trading212,\n");
    try {
      expect(() => loadSavingsConfig(path)).toThrow(/invalid scope/);
    } finally {
      cleanupTmp(path);
    }
  });
});

describe("savingsFlowEur", () => {
  test("a deposit into a savings account counts (signed +)", () => {
    expect(savingsFlowEur(tx({ account: "trading212", type: "transfer", amount_eur: 500 }), CONFIG)).toBe(500);
  });

  test("a withdrawal from a savings account is a negative flow (raiding lowers savings)", () => {
    expect(savingsFlowEur(tx({ account: "trading212", type: "transfer", amount_eur: -200 }), CONFIG)).toBe(-200);
  });

  test("a non-transfer row in a savings account (a dividend, a buy) is NOT new savings", () => {
    expect(savingsFlowEur(tx({ account: "trading212", type: "income", amount_eur: 7 }), CONFIG)).toBe(0);
    expect(savingsFlowEur(tx({ account: "trading212", type: "exchange", amount_eur: -300 }), CONFIG)).toBe(0);
  });

  test("a move into a marked space (HOUSE) counts, case-insensitively", () => {
    expect(savingsFlowEur(tx({ merchant_raw: "HOUSE", type: "transfer", amount_eur: 300 }), CONFIG)).toBe(300);
    expect(savingsFlowEur(tx({ merchant_raw: "house", type: "transfer", amount_eur: 300 }), CONFIG)).toBe(300);
  });

  test("an ordinary spend row is not savings", () => {
    expect(savingsFlowEur(tx({ account: "n26-house", type: "spend", amount_eur: -40 }), CONFIG)).toBe(0);
  });

  test("a missing FX value contributes 0, never a guess", () => {
    expect(savingsFlowEur(tx({ account: "trading212", type: "transfer", amount_eur: null }), CONFIG)).toBe(0);
  });

  test("a marker substring (warehouse) does NOT match the exact HOUSE label", () => {
    expect(savingsFlowEur(tx({ merchant_raw: "WAREHOUSE LTD", type: "spend", amount_eur: -10 }), CONFIG)).toBe(0);
  });
});

describe("savingsFlowByMonth", () => {
  test("nets deposits and withdrawals per month, ascending", () => {
    const txs = [
      tx({ date: "2026-01-10", account: "trading212", type: "transfer", amount_eur: 500 }),
      tx({ date: "2026-01-20", merchant_raw: "HOUSE", type: "transfer", amount_eur: 300 }),
      tx({ date: "2026-02-05", account: "trading212", type: "transfer", amount_eur: -100 }),
      tx({ date: "2026-02-15", account: "n26-house", type: "spend", amount_eur: -40 }), // ignored
    ];
    const byMonth = savingsFlowByMonth(txs, CONFIG);
    expect([...byMonth]).toEqual([
      ["2026-01", 800],
      ["2026-02", -100],
    ]);
  });
});

describe("savingsStock", () => {
  test("cumulative flow per destination plus anchors, with a breakdown", () => {
    const txs = [
      tx({ date: "2026-01-10", account: "trading212", type: "transfer", amount_eur: 500 }),
      tx({ date: "2026-03-10", account: "trading212", type: "transfer", amount_eur: 800 }),
      tx({ date: "2026-02-01", account: "trading212", type: "income", amount_eur: 12 }), // dividend, not stock
      tx({ date: "2026-01-20", merchant_raw: "HOUSE", type: "transfer", amount_eur: 300 }),
      tx({ date: "2026-04-20", merchant_raw: "HOUSE", type: "transfer", amount_eur: -100 }), // raided
    ];
    const stock = savingsStock(txs, CONFIG);
    // trading212 cost basis 1300, HOUSE 200, anchor 10000 -> 11500
    expect(stock.totalEur).toBe(11500);
    expect(stock.components).toEqual([
      { label: "trading212", eur: 1300, kind: "account" },
      { label: "HOUSE", eur: 200, kind: "marker" },
      { label: "Lump-sum", eur: 10000, kind: "anchor" },
    ]);
  });

  test("a destination with no rows still appears as a 0 component", () => {
    const stock = savingsStock([], CONFIG);
    expect(stock.totalEur).toBe(10000); // only the anchor
    expect(stock.components.map((c) => c.eur)).toEqual([0, 0, 10000]);
  });
});

describe("recentMonthlyRate", () => {
  const asOf = new Date("2026-07-15T00:00:00Z"); // current month 2026-07, incomplete

  test("averages the last N complete months, current partial month excluded", () => {
    const txs = [
      tx({ date: "2026-04-10", account: "trading212", type: "transfer", amount_eur: 600 }),
      tx({ date: "2026-05-10", account: "trading212", type: "transfer", amount_eur: 400 }),
      tx({ date: "2026-06-10", account: "trading212", type: "transfer", amount_eur: 800 }),
      tx({ date: "2026-07-10", account: "trading212", type: "transfer", amount_eur: 9999 }), // current month, excluded
    ];
    // window = last 3 complete months (Apr,May,Jun): (600+400+800)/3 = 600
    expect(recentMonthlyRate(txs, CONFIG, { lookbackMonths: 3, asOf })).toBe(600);
  });

  test("a gap month with no savings counts as a real zero in the average", () => {
    const txs = [
      tx({ date: "2026-04-10", account: "trading212", type: "transfer", amount_eur: 600 }),
      // May: nothing set aside
      tx({ date: "2026-06-10", account: "trading212", type: "transfer", amount_eur: 600 }),
    ];
    // window Apr,May,Jun = (600 + 0 + 600)/3 = 400
    expect(recentMonthlyRate(txs, CONFIG, { lookbackMonths: 3, asOf })).toBe(400);
  });

  test("no complete-month history -> 0", () => {
    const txs = [tx({ date: "2026-07-10", account: "trading212", type: "transfer", amount_eur: 500 })];
    expect(recentMonthlyRate(txs, CONFIG, { lookbackMonths: 6, asOf })).toBe(0);
  });
});

describe("savingsStockByMonth", () => {
  test("cumulative running stock, ascending, with a base floor", () => {
    const txs = [
      tx({ date: "2026-01-10", account: "trading212", type: "transfer", amount_eur: 500 }),
      tx({ date: "2026-02-10", merchant_raw: "HOUSE", type: "transfer", amount_eur: 300 }),
      tx({ date: "2026-03-10", account: "trading212", type: "transfer", amount_eur: -100 }), // raided
    ];
    const hist = savingsStockByMonth(txs, CONFIG, 1000); // base anchor 1000
    expect(hist).toEqual([
      { month: "2026-01", added: 500, stockEur: 1500 },
      { month: "2026-02", added: 300, stockEur: 1800 },
      { month: "2026-03", added: -100, stockEur: 1700 },
    ]);
  });

  test("no savings flow -> empty series", () => {
    expect(savingsStockByMonth([tx({ type: "spend", amount_eur: -10 })], CONFIG)).toEqual([]);
  });
});

describe("savingsSeries", () => {
  test("per-destination cumulative lines plus total, forward-filled", () => {
    const txs = [
      tx({ date: "2026-01-10", account: "trading212", type: "transfer", amount_eur: 500 }),
      tx({ date: "2026-02-10", merchant_raw: "HOUSE", type: "transfer", amount_eur: 300 }),
      tx({ date: "2026-03-10", account: "trading212", type: "transfer", amount_eur: 200 }),
    ];
    const s = savingsSeries(txs, CONFIG);
    expect(s.months).toEqual(["2026-01", "2026-02", "2026-03"]);
    const t212 = s.lines.find((l) => l.key === "trading212")!;
    const house = s.lines.find((l) => l.key === "house")!;
    expect(t212.values).toEqual([500, 500, 700]); // holds 500 through Feb, +200 in Mar
    expect(house.values).toEqual([0, 300, 300]); // 0 in Jan, +300 in Feb, holds
    // total includes the 10000 anchor at every month
    expect(s.total).toEqual([10500, 10800, 11000]);
  });
});
