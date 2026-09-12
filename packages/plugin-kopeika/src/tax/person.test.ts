import { describe, expect, test } from "bun:test";
import { taxRuleMatches, type TaxRule } from "./person.ts";
import type { Transaction } from "../types.ts";

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: "x", date: "2026-08-18", data_source: "paypal", account: "paypal-shoom", owner: "anna",
    merchant_raw: "Ekaterina Grinchenko", merchant_clean: "", amount_native: 250, currency: "EUR", amount_eur: 250,
    category: "", type: "income", is_transfer: false, transfer_group: "", fee: 0, note: "", source_file: "",
    balance: null, tax_person: "", tax_category: "", tax_source: "",
    ...over,
  } as Transaction;
}
function rule(over: Partial<TaxRule>): TaxRule {
  return { pattern: "*", match: "client", field: "merchant_raw", category: "revenue_ku", accounts: [], from: "", note: "", regex: null, ...over };
}
const clients = new Set(["ekaterina grinchenko", "tatiana kligman"]);

describe("taxRuleMatches", () => {
  test("client rule fires on a registered payer, case- and space-insensitive, never on a stranger", () => {
    expect(taxRuleMatches(rule({}), tx({}), clients)).toBe(true);
    expect(taxRuleMatches(rule({}), tx({ merchant_raw: "  EKATERINA   Grinchenko " }), clients)).toBe(true);
    expect(taxRuleMatches(rule({}), tx({ merchant_raw: "Maria Kirichenko" }), clients)).toBe(false);
    expect(taxRuleMatches(rule({}), tx({ merchant_raw: "Transfer from TATIANA KLIGMAN" }), clients)).toBe(true);
    expect(taxRuleMatches(rule({}), tx({ merchant_raw: "Payment from TATIANA KLIGMAN" }), clients)).toBe(true);
    expect(taxRuleMatches(rule({}), tx({}), undefined)).toBe(false);
  });
  test("from is an inclusive lower bound on the row date", () => {
    expect(taxRuleMatches(rule({ from: "2026-07-16" }), tx({ date: "2026-07-15" }), clients)).toBe(false);
    expect(taxRuleMatches(rule({ from: "2026-07-16" }), tx({ date: "2026-07-16" }), clients)).toBe(true);
  });
  test("accounts scope accepts several accounts", () => {
    const r = rule({ accounts: ["paypal-shoom", "revolut-anna"] });
    expect(taxRuleMatches(r, tx({ account: "revolut-anna" }), clients)).toBe(true);
    expect(taxRuleMatches(r, tx({ account: "revolut-main" }), clients)).toBe(false);
  });
  test("substring rules still work with no client registry", () => {
    expect(taxRuleMatches(rule({ match: "substring", pattern: "splice", category: "software" }), tx({ merchant_raw: "Splice.com" }))).toBe(true);
  });
});
