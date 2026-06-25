import { describe, expect, test } from "bun:test";
import { loadTiers, tierOf, tiersConfigured, type Tiers } from "./tiers.ts";
import { tmpCsv, cleanupTmp } from "./test-helpers.ts";

function tiers(cats: string[], merchants: string[]): Tiers {
  return {
    mandatoryCategories: new Set(cats.map((c) => c.toLowerCase())),
    mandatoryMerchants: merchants.map((m) => m.toLowerCase()),
  };
}

describe("tierOf", () => {
  test("mandatory category -> mandatory (floor)", () => {
    const t = tiers(["Rent"], []);
    expect(tierOf(t, "Rent", "Deutsche Wohnen")).toBe("mandatory");
  });

  test("category match is case-insensitive", () => {
    const t = tiers(["Rent"], []);
    expect(tierOf(t, "RENT", "x")).toBe("mandatory");
    expect(tierOf(t, "rent", "x")).toBe("mandatory");
  });

  test("mandatory merchant substring -> mandatory", () => {
    const t = tiers([], ["Vattenfall"]);
    expect(tierOf(t, "Utilities", "VATTENFALL EUROPE GMBH")).toBe("mandatory");
  });

  test("unmatched -> optional (flex default)", () => {
    const t = tiers(["Rent"], ["Vattenfall"]);
    expect(tierOf(t, "Entertainment", "Spati Beer")).toBe("optional");
  });

  test("either axis hitting is enough (category OR merchant)", () => {
    const t = tiers(["Rent"], ["Claude"]);
    expect(tierOf(t, "Software", "Anthropic Claude")).toBe("mandatory"); // merchant hit
    expect(tierOf(t, "Rent", "Random Landlord")).toBe("mandatory"); // category hit
  });

  test("empty tiers -> everything optional", () => {
    const t = tiers([], []);
    expect(tierOf(t, "Rent", "Vattenfall")).toBe("optional");
  });
});

describe("tiersConfigured", () => {
  test("true when any mandatory category or merchant is declared", () => {
    expect(tiersConfigured(tiers(["Rent"], []))).toBe(true);
    expect(tiersConfigured(tiers([], ["Vattenfall"]))).toBe(true);
  });

  test("false when nothing mandatory declared (floor unknown, not zero)", () => {
    expect(tiersConfigured(tiers([], []))).toBe(false);
  });
});

describe("loadTiers", () => {
  test("missing file -> empty (unconfigured) tiers", () => {
    const t = loadTiers("/no/such/tiers.csv");
    expect(tiersConfigured(t)).toBe(false);
  });

  test("loads category + merchant mandatory rows, lower-cased", () => {
    const path = tmpCsv(
      "tiers.csv",
      "scope,value,tier\ncategory,Rent,mandatory\nmerchant,Vattenfall,mandatory\n",
    );
    try {
      const t = loadTiers(path);
      expect(t.mandatoryCategories.has("rent")).toBe(true);
      expect(t.mandatoryMerchants).toContain("vattenfall");
      expect(tierOf(t, "Rent", "x")).toBe("mandatory");
      expect(tierOf(t, "x", "VATTENFALL")).toBe("mandatory");
    } finally {
      cleanupTmp(path);
    }
  });

  test("optional rows are accepted but record nothing (no-op)", () => {
    const path = tmpCsv(
      "tiers.csv",
      "scope,value,tier\ncategory,Entertainment,optional\ncategory,Rent,mandatory\n",
    );
    try {
      const t = loadTiers(path);
      expect(t.mandatoryCategories.has("entertainment")).toBe(false);
      expect(t.mandatoryCategories.has("rent")).toBe(true);
    } finally {
      cleanupTmp(path);
    }
  });

  test("blank line tolerated", () => {
    const path = tmpCsv("tiers.csv", "scope,value,tier\n,,\ncategory,Rent,mandatory\n");
    try {
      expect(loadTiers(path).mandatoryCategories.has("rent")).toBe(true);
    } finally {
      cleanupTmp(path);
    }
  });

  test("invalid scope throws", () => {
    const path = tmpCsv("tiers.csv", "scope,value,tier\nregion,Berlin,mandatory\n");
    try {
      expect(() => loadTiers(path)).toThrow(/invalid scope/);
    } finally {
      cleanupTmp(path);
    }
  });

  test("invalid tier throws", () => {
    const path = tmpCsv("tiers.csv", "scope,value,tier\ncategory,Rent,maybe\n");
    try {
      expect(() => loadTiers(path)).toThrow(/invalid tier/);
    } finally {
      cleanupTmp(path);
    }
  });

  test("empty value throws", () => {
    const path = tmpCsv("tiers.csv", "scope,value,tier\ncategory,,mandatory\n");
    try {
      expect(() => loadTiers(path)).toThrow(/empty value/);
    } finally {
      cleanupTmp(path);
    }
  });
});
