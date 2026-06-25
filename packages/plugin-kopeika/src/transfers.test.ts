import { describe, expect, test } from "bun:test";
import { matchTransfers, DEFAULT_TRANSFER_OPTIONS } from "./transfers.ts";
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
