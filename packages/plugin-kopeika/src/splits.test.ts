import { describe, expect, test } from "bun:test";
import { expandSplits, legTiers, loadSplits, saveSplits, splitProblems, parentOf, legId } from "./splits.ts";
import { tx, tmpCsv, cleanupTmp } from "./test-helpers.ts";

const csv = `id,seq,eur,category,mandatory,books,tax_category,note
r1,1,-58.30,music,,anna,equipment_gwg,Shure PGA48
r1,2,-21.49,health,no,,,"COSRX, retinol"
r1,3,-27.01,health,,,,DHC oil
r2,1,-10,household,,,,does not sum
`;

describe("splits", () => {
  test("load, expand, report", () => {
    const p = tmpCsv("splits.csv", csv);
    const splits = loadSplits(p);
    expect(splits.get("r1")!.length).toBe(3);
    const ledger = [
      tx({ id: "r1", amount_native: -106.8, amount_eur: -106.8, category: "music", merchant_raw: "Amazon" }),
      tx({ id: "r2", amount_native: -37.13, amount_eur: -37.13, category: "kids" }),
      tx({ id: "r3", amount_native: -5, amount_eur: -5 }),
    ];
    expect(splitProblems(ledger, splits)).toEqual(["split r2 (2025-01-15 Some Merchant): legs sum to -10.00, the row is -37.13"]);
    const out = expandSplits(ledger, splits);
    expect(out.map((t) => t.id)).toEqual(["r1#1", "r1#2", "r1#3", "r2", "r3"]);
    expect(out[0]).toMatchObject({ amount_eur: -58.3, amount_native: -58.3, category: "music", tax_person: "anna", tax_category: "equipment_gwg", tax_source: "pin", note: "Shure PGA48", merchant_raw: "Amazon" });
    expect(out[1]).toMatchObject({ amount_eur: -21.49, category: "health", tax_person: "", tax_source: "", note: "COSRX, retinol" });
    expect(out[3]!.amount_eur).toBe(-37.13); // the non-summing split leaves the row whole
    expect([...legTiers(splits)]).toEqual([["r1#2", "optional"]]);
    expect(parentOf("r1#2")).toBe("r1");
    expect(parentOf("r1")).toBe("r1");
    expect(legId("r1", 3)).toBe("r1#3");
    // round trip
    saveSplits(p, splits);
    expect(loadSplits(p).get("r1")![1]!.note).toBe("COSRX, retinol");
    cleanupTmp(p);
  });
});
