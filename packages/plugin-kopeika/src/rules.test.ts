import { describe, expect, test } from "bun:test";
import {
  loadRules,
  ruleMatches,
  firstMatch,
  summarizeUnknowns,
  type Rule,
} from "./rules.ts";
import { tx, tmpCsv, cleanupTmp } from "./test-helpers.ts";
import type { Transaction, TxType } from "./types.ts";

/** Build a Rule inline. */
function rule(p: Partial<Rule> & Pick<Rule, "pattern" | "matchType">): Rule {
  return {
    field: "merchant_raw",
    category: "Cat",
    type: null,
    regex: p.matchType === "regex" ? new RegExp(p.pattern, "i") : null,
    ...p,
  };
}

describe("ruleMatches", () => {
  test("substring is case-insensitive", () => {
    const r = rule({ pattern: "rewe", matchType: "substring" });
    expect(ruleMatches(r, tx({ merchant_raw: "REWE Berlin" }))).toBe(true);
    expect(ruleMatches(r, tx({ merchant_raw: "ALDI" }))).toBe(false);
  });

  test("exact requires a full case-sensitive equality", () => {
    const r = rule({ pattern: "REWE", matchType: "exact" });
    expect(ruleMatches(r, tx({ merchant_raw: "REWE" }))).toBe(true);
    expect(ruleMatches(r, tx({ merchant_raw: "REWE Berlin" }))).toBe(false);
    expect(ruleMatches(r, tx({ merchant_raw: "rewe" }))).toBe(false);
  });

  test("regex matches (case-insensitive via compiled flag)", () => {
    const r = rule({ pattern: "^uber( eats)?$", matchType: "regex" });
    expect(ruleMatches(r, tx({ merchant_raw: "Uber" }))).toBe(true);
    expect(ruleMatches(r, tx({ merchant_raw: "UBER EATS" }))).toBe(true);
    expect(ruleMatches(r, tx({ merchant_raw: "Ubering" }))).toBe(false);
  });

  test("field defaults are honored: matches on a non-default field", () => {
    const r = rule({ pattern: "salary", matchType: "substring", field: "note" });
    expect(ruleMatches(r, tx({ merchant_raw: "Employer", note: "monthly salary" }))).toBe(true);
    expect(ruleMatches(r, tx({ merchant_raw: "salary co", note: "x" }))).toBe(false);
  });
});

describe("firstMatch precedence", () => {
  test("FIRST matching rule wins, even if a later rule also matches", () => {
    const rules: Rule[] = [
      rule({ pattern: "REWE", matchType: "substring", category: "Groceries" }),
      rule({ pattern: "REWE", matchType: "substring", category: "Wrong" }),
    ];
    const m = firstMatch(rules, tx({ merchant_raw: "REWE Berlin" }));
    expect(m?.category).toBe("Groceries");
  });

  test("returns null when nothing matches", () => {
    const rules: Rule[] = [rule({ pattern: "REWE", matchType: "substring" })];
    expect(firstMatch(rules, tx({ merchant_raw: "ALDI" }))).toBeNull();
  });

  test("optional type override is carried on the matched rule", () => {
    const r = rule({ pattern: "Salary", matchType: "substring", category: "Income", type: "income" as TxType });
    const m = firstMatch([r], tx({ merchant_raw: "Salary ACME" }));
    expect(m?.type).toBe("income");
  });
});

describe("loadRules", () => {
  test("missing file -> empty rule set", () => {
    expect(loadRules("/no/such/rules.csv")).toEqual([]);
  });

  test("loads rules in file order, defaults field to merchant_raw", () => {
    const path = tmpCsv(
      "rules.csv",
      "pattern,match_type,field,category,type\nREWE,substring,,Groceries,\nSalary,substring,note,Income,income\n",
    );
    try {
      const rules = loadRules(path);
      expect(rules).toHaveLength(2);
      expect(rules[0]!.field).toBe("merchant_raw");
      expect(rules[0]!.category).toBe("Groceries");
      expect(rules[0]!.type).toBeNull();
      expect(rules[1]!.field).toBe("note");
      expect(rules[1]!.type).toBe("income");
    } finally {
      cleanupTmp(path);
    }
  });

  test("compiles a regex rule", () => {
    const path = tmpCsv(
      "rules.csv",
      "pattern,match_type,field,category,type\n^uber,regex,,Transport,\n",
    );
    try {
      const rules = loadRules(path);
      expect(rules[0]!.matchType).toBe("regex");
      expect(rules[0]!.regex).toBeInstanceOf(RegExp);
      expect(ruleMatches(rules[0]!, tx({ merchant_raw: "Uber Trip" }))).toBe(true);
    } finally {
      cleanupTmp(path);
    }
  });

  test("blank line is skipped", () => {
    const path = tmpCsv(
      "rules.csv",
      "pattern,match_type,field,category,type\n,,,,\nREWE,substring,,Groceries,\n",
    );
    try {
      expect(loadRules(path)).toHaveLength(1);
    } finally {
      cleanupTmp(path);
    }
  });

  test("invalid match_type throws", () => {
    const path = tmpCsv("rules.csv", "pattern,match_type,field,category,type\nX,fuzzy,,C,\n");
    try {
      expect(() => loadRules(path)).toThrow(/invalid match_type/);
    } finally {
      cleanupTmp(path);
    }
  });

  test("unsupported field throws", () => {
    const path = tmpCsv("rules.csv", "pattern,match_type,field,category,type\nX,substring,amount_eur,C,\n");
    try {
      expect(() => loadRules(path)).toThrow(/unsupported field/);
    } finally {
      cleanupTmp(path);
    }
  });

  test("invalid type throws", () => {
    const path = tmpCsv("rules.csv", "pattern,match_type,field,category,type\nX,substring,,C,bogus\n");
    try {
      expect(() => loadRules(path)).toThrow(/invalid type/);
    } finally {
      cleanupTmp(path);
    }
  });

  test("invalid regex throws", () => {
    const path = tmpCsv("rules.csv", "pattern,match_type,field,category,type\n(,regex,,C,\n");
    try {
      expect(() => loadRules(path)).toThrow(/invalid regex/);
    } finally {
      cleanupTmp(path);
    }
  });
});

describe("summarizeUnknowns", () => {
  test("aggregates only uncategorized rows by merchant, sorted by spend desc", () => {
    const txs: Transaction[] = [
      tx({ merchant_raw: "A", amount_eur: -10, category: "" }),
      tx({ merchant_raw: "A", amount_eur: -5, category: "" }),
      tx({ merchant_raw: "B", amount_eur: -50, category: "" }),
      tx({ merchant_raw: "C", amount_eur: -1, category: "Groceries" }), // categorized -> excluded
    ];
    const out = summarizeUnknowns(txs);
    expect(out.map((u) => u.merchant_raw)).toEqual(["B", "A"]);
    expect(out[0]!.totalEur).toBe(50);
    expect(out[1]!.count).toBe(2);
    expect(out[1]!.totalEur).toBe(15);
    expect(out.find((u) => u.merchant_raw === "C")).toBeUndefined();
  });

  test("rows with missing amount_eur are counted but excluded from totalEur", () => {
    const txs: Transaction[] = [
      tx({ merchant_raw: "X", amount_eur: null, category: "" }),
      tx({ merchant_raw: "X", amount_eur: -20, category: "" }),
    ];
    const out = summarizeUnknowns(txs);
    expect(out[0]!.missingEurCount).toBe(1);
    expect(out[0]!.totalEur).toBe(20);
    expect(out[0]!.count).toBe(2);
  });
});
