import { describe, expect, test } from "bun:test";
import { parseNormanDump } from "./norman-dump.ts";

/** A synthetic raw Norman transaction as the API returns it. */
function tx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publicId: "aaaaaaaa-0000-0000-0000-000000000001",
    valueDate: "2026-03-14T00:00:00Z",
    amount: "-19.99",
    description: "Example Cloud — cloud.example.com",
    category: { name: "Software", publicId: "11111111-0000-0000-0000-00000000000a" },
    userStatus: "VERIFIED",
    ...overrides,
  };
}

describe("parseNormanDump", () => {
  test("maps category names to pack keys, keeps the signed amount and the uuid", () => {
    const { rows } = parseNormanDump(JSON.stringify([tx()]));
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.date).toBe("2026-03-14");
    expect(r.amount).toBe(-19.99);
    expect(r.taxCategory).toBe("software");
    expect(r.normanCategory).toBe("Software");
    expect(r.normanId).toBe("aaaaaaaa-0000-0000-0000-000000000001");
    expect(r.verified).toBe(true);
    expect(r.currency).toBe("EUR");
  });

  test("the full name -> pack mapping (meals stays GROSS, services is revenue)", () => {
    const cases: [string, string][] = [
      ["Software", "software"],
      ["Equipment", "equipment_gwg"],
      ["Office supplies", "office"],
      ["Meals", "meals"],
      ["Transportation", "transport"],
      ["Education", "education"],
      ["Services", "revenue"],
      ["Capital contribution", "capital_contribution"],
      ["Personal", "personal"],
    ];
    const dump = cases.map(([name], i) =>
      tx({ publicId: `bbbbbbbb-0000-0000-0000-00000000000${i}`, category: { name } }),
    );
    const { rows } = parseNormanDump(JSON.stringify(dump));
    expect(rows.map((r) => r.taxCategory)).toEqual(cases.map(([, key]) => key));
  });

  test("zero-amount card-auth holds are skipped and counted", () => {
    const dump = [tx(), tx({ publicId: "cccccccc-0000-0000-0000-000000000002", amount: 0 })];
    const { rows, skippedZeroAmount } = parseNormanDump(JSON.stringify(dump));
    expect(rows.length).toBe(1);
    expect(skippedZeroAmount).toBe(1);
  });

  test("amortization metadata makes the row a neutral asset_purchase, not an expense", () => {
    const { rows } = parseNormanDump(
      JSON.stringify([
        tx({
          amount: "-700.00",
          description: "Manual entry: workstation (business share)",
          category: { name: "Equipment" },
          categoryMetadata: { amortization: { usefulLifetime: 1 } },
          iban: null,
        }),
      ]),
    );
    const r = rows[0]!;
    expect(r.activatedAsset).toBe(true);
    expect(r.taxCategory).toBe("asset_purchase");
  });

  test("a plain Equipment row without amortization stays equipment_gwg", () => {
    const { rows } = parseNormanDump(
      JSON.stringify([tx({ category: { name: "Equipment" }, categoryMetadata: {} })]),
    );
    expect(rows[0]!.activatedAsset).toBe(false);
    expect(rows[0]!.taxCategory).toBe("equipment_gwg");
  });

  test("category uuids resolve via the --category-map table; ids alone also work", () => {
    const uuidToKey = new Map([["11111111-0000-0000-0000-00000000000a", "education"]]);
    // Object with an unknown name but a mapped uuid.
    const a = tx({ category: { name: "Weiterbildung", publicId: "11111111-0000-0000-0000-00000000000a" } });
    // Bare uuid string.
    const b = tx({ publicId: "dddddddd-0000-0000-0000-000000000003", category: "11111111-0000-0000-0000-00000000000a" });
    const { rows } = parseNormanDump(JSON.stringify([a, b]), uuidToKey);
    expect(rows[0]!.taxCategory).toBe("education");
    expect(rows[0]!.normanCategory).toBe("Weiterbildung");
    expect(rows[1]!.taxCategory).toBe("education");
  });

  test("an unknown or missing category leaves the row undisposed (queues, never guessed)", () => {
    const dump = [
      tx({ category: { name: "Goods/Materials" } }),
      tx({ publicId: "eeeeeeee-0000-0000-0000-000000000004", category: null }),
    ];
    const { rows } = parseNormanDump(JSON.stringify(dump));
    expect(rows[0]!.taxCategory).toBe("");
    expect(rows[0]!.normanCategory).toBe("Goods/Materials");
    expect(rows[1]!.taxCategory).toBe("");
    expect(rows[1]!.normanCategory).toBe("");
  });

  test("a verbatim API page ({results: [...]}) also reads", () => {
    const { rows } = parseNormanDump(JSON.stringify({ results: [tx()] }));
    expect(rows.length).toBe(1);
  });

  test("bad shape, missing publicId, bad date or amount fail loud", () => {
    expect(() => parseNormanDump("not json")).toThrow(/not valid JSON/);
    expect(() => parseNormanDump('{"foo": 1}')).toThrow(/expected a JSON array/);
    expect(() => parseNormanDump(JSON.stringify([tx({ publicId: "" })]))).toThrow(/no publicId/);
    expect(() => parseNormanDump(JSON.stringify([tx({ valueDate: "14.03.2026" })]))).toThrow(/bad or missing valueDate/);
    expect(() => parseNormanDump(JSON.stringify([tx({ amount: "abc" })]))).toThrow(/non-numeric amount/);
  });

  test("a positive Services payout keeps its sign (income nets on the revenue side)", () => {
    const { rows } = parseNormanDump(
      JSON.stringify([tx({ amount: "125.40", category: { name: "Services" }, description: "Payout" })]),
    );
    expect(rows[0]!.amount).toBe(125.4);
    expect(rows[0]!.taxCategory).toBe("revenue");
  });
});
