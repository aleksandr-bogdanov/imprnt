import { describe, expect, test } from "bun:test";
import { parseTrading212 } from "./trading212.ts";

const HEADER =
  "Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee)";

/** Build a row positionally; pass only the fields the test cares about. */
function row(opts: {
  action: string;
  time?: string;
  name?: string;
  notes?: string;
  total?: string;
  totalCur?: string;
}): string {
  const f = new Array(19).fill("");
  f[0] = opts.action;
  f[1] = opts.time ?? "2025-01-15 10:00:00.000";
  f[4] = opts.name ?? "";
  f[5] = opts.notes ?? "";
  f[13] = opts.total ?? "";
  f[14] = opts.totalCur ?? "";
  return f.join(",");
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

describe("parseTrading212", () => {
  test("Deposit -> transfer, EUR amountEur set, transferCandidate true", () => {
    const rows = parseTrading212(csv(row({ action: "Deposit", total: "1500.00", totalCur: "EUR" })));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2025-01-15",
      merchant_raw: "Deposit", // no security Name -> action label
      amount_native: 1500,
      currency: "EUR",
      type: "transfer",
      transferCandidate: true,
      amountEur: 1500,
    });
  });

  test("Market buy -> exchange, merchant_raw = security Name", () => {
    const rows = parseTrading212(
      csv(row({ action: "Market buy", name: "Apple Inc", total: "-200.00", totalCur: "EUR" })),
    );
    expect(rows[0]).toMatchObject({
      merchant_raw: "Apple Inc",
      type: "exchange",
      transferCandidate: false,
    });
  });

  test("Dividend / Interest -> income", () => {
    const rows = parseTrading212(
      csv(
        row({ action: "Dividend", name: "Apple Inc", total: "3.00", totalCur: "EUR" }),
        row({ action: "Interest on cash", total: "1.00", totalCur: "EUR" }),
      ),
    );
    expect(rows.map((r) => r.type)).toEqual(["income", "income"]);
  });

  test("Withdrawal -> transfer", () => {
    const rows = parseTrading212(csv(row({ action: "Withdrawal", total: "-500", totalCur: "EUR" })));
    expect(rows[0]!.type).toBe("transfer");
    expect(rows[0]!.transferCandidate).toBe(true);
  });

  test("unknown action -> unknown type", () => {
    const rows = parseTrading212(csv(row({ action: "Card debit", total: "-5", totalCur: "EUR" })));
    expect(rows[0]!.type).toBe("unknown");
  });

  test("non-EUR Total -> amountEur null (pipeline must FX it), currency upper-cased", () => {
    const rows = parseTrading212(
      csv(row({ action: "Market buy", name: "Nvidia", total: "-100", totalCur: "usd" })),
    );
    expect(rows[0]!.currency).toBe("USD");
    expect(rows[0]!.amountEur).toBeNull();
  });

  test("empty Currency (Total) defaults to EUR", () => {
    const rows = parseTrading212(csv(row({ action: "Deposit", total: "10", totalCur: "" })));
    expect(rows[0]!.currency).toBe("EUR");
    expect(rows[0]!.amountEur).toBe(10);
  });

  test("DROPS a row with an empty Total (non-monetary action)", () => {
    const rows = parseTrading212(
      csv(
        row({ action: "Market buy", name: "Share movement", total: "" }),
        row({ action: "Deposit", total: "10", totalCur: "EUR" }),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.merchant_raw).toBe("Deposit");
  });

  test("DROPS a row with an empty Time", () => {
    const rows = parseTrading212(csv(row({ action: "Deposit", time: "", total: "10", totalCur: "EUR" })));
    expect(rows).toHaveLength(0);
  });

  test("note falls back to the action label when Notes empty", () => {
    const rows = parseTrading212(csv(row({ action: "Deposit", total: "10", totalCur: "EUR" })));
    expect(rows[0]!.note).toBe("Deposit");
  });

  test("note uses Notes when present", () => {
    const rows = parseTrading212(
      csv(row({ action: "Deposit", notes: "monthly", total: "10", totalCur: "EUR" })),
    );
    expect(rows[0]!.note).toBe("monthly");
  });

  test("date is the date part of Time", () => {
    const rows = parseTrading212(
      csv(row({ action: "Deposit", time: "2024-12-31 23:59:59.123", total: "1", totalCur: "EUR" })),
    );
    expect(rows[0]!.date).toBe("2024-12-31");
  });

  test("missing required header throws", () => {
    expect(() => parseTrading212("Action,Time\nDeposit,2025\n")).toThrow(/missing expected column/);
  });

  test("non-numeric Total throws", () => {
    expect(() => parseTrading212(csv(row({ action: "Deposit", total: "abc", totalCur: "EUR" })))).toThrow(
      /non-numeric Total/,
    );
  });
});
