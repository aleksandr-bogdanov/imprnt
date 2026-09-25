import { describe, expect, test } from "bun:test";
import { matchCardFunding, matchTransfers, DEFAULT_TRANSFER_OPTIONS } from "./transfers.ts";
import { tx } from "./test-helpers.ts";
import type { Transaction } from "./types.ts";

describe("matchTransfers", () => {
  test("pairs opposite-sign legs across DIFFERENT accounts within tolerance + window", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "transfer", date: "2025-01-11" }),
    ];
    const res = matchTransfers(txs);
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]!.outflow.id).toBe("out");
    expect(res.pairs[0]!.inflow.id).toBe("in");
    expect(res.unmatched).toHaveLength(0);

    const out = res.updated.find((t) => t.id === "out")!;
    const inn = res.updated.find((t) => t.id === "in")!;
    expect(out.is_transfer).toBe(true);
    expect(inn.is_transfer).toBe(true);
    expect(out.transfer_group).not.toBe("");
    expect(out.transfer_group).toBe(inn.transfer_group); // shared group id
  });

  test("near-miss EUR difference > tolerance is NOT paired", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 102, type: "transfer", date: "2025-01-10" }),
    ];
    const res = matchTransfers(txs);
    expect(res.pairs).toHaveLength(0);
    expect(res.unmatched).toHaveLength(2);
  });

  test("EUR difference exactly at €1.50 tolerance still pairs (<=)", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 101.5, type: "transfer", date: "2025-01-10" }),
    ];
    expect(matchTransfers(txs).pairs).toHaveLength(1);
  });

  test("dates outside the 3-day window are NOT paired", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "transfer", date: "2025-01-14" }),
    ];
    expect(matchTransfers(txs).pairs).toHaveLength(0);
  });

  test("exactly 3-day gap still pairs (<=)", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "transfer", date: "2025-01-13" }),
    ];
    expect(matchTransfers(txs).pairs).toHaveLength(1);
  });

  test("same-account opposite legs are NOT paired (must cross accounts)", () => {
    const txs: Transaction[] = [
      tx({ id: "a", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "b", account: "n26", amount_eur: 100, type: "transfer", date: "2025-01-10" }),
    ];
    const res = matchTransfers(txs);
    expect(res.pairs).toHaveLength(0);
    expect(res.unmatched).toHaveLength(2);
  });

  test("same-sign legs across accounts are NOT paired", () => {
    const txs: Transaction[] = [
      tx({ id: "a", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "b", account: "revolut", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
    ];
    expect(matchTransfers(txs).pairs).toHaveLength(0);
  });

  test("a candidate with no amount_eur cannot be matched (reported unmatched)", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: null, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "transfer", date: "2025-01-10" }),
    ];
    const res = matchTransfers(txs);
    expect(res.pairs).toHaveLength(0);
    // The null-EUR leg is filtered out of the candidate pool entirely, so only
    // the usable inflow shows up as unmatched.
    expect(res.unmatched.map((t) => t.id)).toEqual(["in"]);
  });

  test("non-candidate rows (plain spend) are ignored", () => {
    const txs: Transaction[] = [
      tx({ id: "s1", account: "n26", amount_eur: -100, type: "spend", date: "2025-01-10" }),
      tx({ id: "s2", account: "revolut", amount_eur: 100, type: "spend", date: "2025-01-10" }),
    ];
    const res = matchTransfers(txs);
    expect(res.pairs).toHaveLength(0);
    expect(res.unmatched).toHaveLength(0);
  });

  test("a leg flagged is_transfer (without type transfer) is a candidate", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "spend", is_transfer: true, date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "spend", is_transfer: true, date: "2025-01-10" }),
    ];
    expect(matchTransfers(txs).pairs).toHaveLength(1);
  });

  test("matched spend/unknown legs are re-typed to transfer", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "spend", is_transfer: true, date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "income", is_transfer: true, date: "2025-01-10" }),
    ];
    const res = matchTransfers(txs);
    expect(res.updated.find((t) => t.id === "out")!.type).toBe("transfer");
    expect(res.updated.find((t) => t.id === "in")!.type).toBe("transfer");
  });

  test("idempotent: re-running over the updated ledger finds no new pairs", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "transfer", date: "2025-01-11" }),
    ];
    const first = matchTransfers(txs);
    expect(first.pairs).toHaveLength(1);
    const second = matchTransfers(first.updated);
    expect(second.pairs).toHaveLength(0); // already grouped -> excluded from re-matching
    // The grouping is preserved on the second pass.
    expect(second.updated.find((t) => t.id === "out")!.transfer_group).toBe(
      first.updated.find((t) => t.id === "out")!.transfer_group,
    );
  });

  test("does not mutate the caller's input objects", () => {
    const input = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "transfer", date: "2025-01-10" }),
    ];
    matchTransfers(input);
    expect(input[0]!.is_transfer).toBe(false);
    expect(input[0]!.transfer_group).toBe("");
  });

  test("cross-currency match works because comparison is on EUR", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_native: -100, currency: "EUR", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_native: 2500, currency: "CZK", amount_eur: 100, type: "transfer", date: "2025-01-10" }),
    ];
    expect(matchTransfers(txs).pairs).toHaveLength(1);
  });

  test("custom options widen the window", () => {
    const txs: Transaction[] = [
      tx({ id: "out", account: "n26", amount_eur: -100, type: "transfer", date: "2025-01-10" }),
      tx({ id: "in", account: "revolut", amount_eur: 100, type: "transfer", date: "2025-01-20" }),
    ];
    expect(matchTransfers(txs, DEFAULT_TRANSFER_OPTIONS).pairs).toHaveLength(0);
    expect(matchTransfers(txs, { toleranceEur: 1.5, maxDayGap: 30 }).pairs).toHaveLength(1);
  });
});

describe("matchCardFunding", () => {
  const purchase = tx({ id: "buy", account: "paypal-a", data_source: "paypal", date: "2026-09-15", time: "10:00", merchant_raw: "Temu.com", amount_native: -23.96, amount_eur: -23.96, type: "spend" });
  const funding = tx({ id: "fund", account: "paypal-a", data_source: "paypal", date: "2026-09-15", time: "10:00", merchant_raw: "General Card Deposit", amount_native: 23.96, amount_eur: 23.96, type: "transfer", is_transfer: true });

  test("pairs the bank copy of a card-funded PayPal purchase, the purchase stays spend", () => {
    const card = tx({ id: "card", account: "revolut", data_source: "revolut", date: "2026-09-17", merchant_raw: "Temu", amount_native: -23.96, amount_eur: -23.96, type: "spend" });
    const res = matchCardFunding([purchase, funding, card], new Set());
    expect(res.pairs).toHaveLength(1);
    const c = res.updated.find((t) => t.id === "card")!;
    expect(c.is_transfer).toBe(true);
    expect(c.transfer_group).toBe(res.updated.find((t) => t.id === "fund")!.transfer_group);
    expect(res.updated.find((t) => t.id === "buy")!.type).toBe("spend");
  });

  test("a same-amount charge at an unrelated merchant is not paired", () => {
    const other = tx({ id: "card", account: "revolut", data_source: "revolut", date: "2026-09-16", merchant_raw: "Amazon", amount_native: -23.96, amount_eur: -23.96, type: "spend" });
    expect(matchCardFunding([purchase, funding, other], new Set()).pairs).toHaveLength(0);
  });

  test("a PAYPAL * card descriptor pairs without a shared word", () => {
    const card = tx({ id: "card", account: "n26", data_source: "n26", date: "2026-09-18", merchant_raw: "PAYPAL *MAGCLOUD", amount_native: -23.96, amount_eur: -23.96, type: "spend" });
    expect(matchCardFunding([purchase, funding, card], new Set()).pairs).toHaveLength(1);
  });

  test("a squashed card descriptor matches the PayPal payee, a partly card-funded payment too", () => {
    const pay = tx({ id: "p", account: "paypal-b", data_source: "paypal", date: "2026-02-13", time: "", merchant_raw: "Sam Rivers", amount_native: -55, amount_eur: -55, type: "spend" });
    const leg = tx({ id: "f", account: "paypal-b", data_source: "paypal", date: "2026-02-13", time: "", merchant_raw: "General Card Deposit", amount_native: 5, amount_eur: 5, type: "transfer", is_transfer: true });
    const card = tx({ id: "c", account: "revolut", data_source: "revolut", date: "2026-02-14", merchant_raw: "Riverssam7", amount_native: -5, amount_eur: -5, type: "spend" });
    expect(matchCardFunding([pay, leg, card], new Set()).pairs).toHaveLength(1);
    const pay2 = tx({ id: "p2", account: "paypal-a", data_source: "paypal", date: "2026-07-31", time: "09:00", merchant_raw: "Berliner Bäder-Betriebe", amount_native: -5.6, amount_eur: -5.6, type: "spend" });
    const leg2 = tx({ id: "f2", account: "paypal-a", data_source: "paypal", date: "2026-07-31", time: "09:00", merchant_raw: "General Card Deposit", amount_native: 5.6, amount_eur: 5.6, type: "transfer", is_transfer: true });
    const card2 = tx({ id: "c2", account: "revolut", data_source: "revolut", date: "2026-08-01", merchant_raw: "Berlinerbae", amount_native: -5.6, amount_eur: -5.6, type: "spend" });
    expect(matchCardFunding([pay2, leg2, card2], new Set()).pairs).toHaveLength(1);
  });

  test("a decided bank row is held, never re-typed", () => {
    const card = tx({ id: "card", account: "revolut", data_source: "revolut", date: "2026-09-17", merchant_raw: "Temu", amount_native: -23.96, amount_eur: -23.96, type: "spend" });
    const res = matchCardFunding([purchase, funding, card], new Set(["card"]));
    expect(res.pairs).toHaveLength(0);
    expect(res.held).toHaveLength(1);
    expect(res.updated.find((t) => t.id === "card")!.is_transfer).toBe(false);
  });

  test("a bank row dated before the funding leg or past the window is not paired", () => {
    const early = tx({ id: "card", account: "revolut", data_source: "revolut", date: "2026-09-14", merchant_raw: "Temu", amount_native: -23.96, amount_eur: -23.96, type: "spend" });
    const late = tx({ id: "card2", account: "revolut", data_source: "revolut", date: "2026-09-21", merchant_raw: "Temu", amount_native: -23.96, amount_eur: -23.96, type: "spend" });
    expect(matchCardFunding([purchase, funding, early, late], new Set()).pairs).toHaveLength(0);
  });
});

test("a PayPal funding leg is never paired by amount with an own transfer", () => {
  const txs: Transaction[] = [
    tx({ id: "fund", account: "paypal-a", data_source: "paypal", merchant_raw: "General Card Deposit", amount_eur: 10, is_transfer: true, type: "transfer", date: "2026-01-07" }),
    tx({ id: "own", account: "revolut", data_source: "revolut", merchant_raw: "Transfer to joint", amount_eur: -10, is_transfer: true, type: "transfer", date: "2026-01-09" }),
  ];
  expect(matchTransfers(txs).pairs).toHaveLength(0);
});
