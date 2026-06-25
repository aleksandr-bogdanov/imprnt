import { beforeEach, describe, expect, test } from "bun:test";
import { parseN26 } from "./n26.ts";
import { setIdentity } from "../identity.ts";

// Internal-transfer detection reads the own-name/IBAN identity that the CLI loads
// from data/profile.json at runtime. Tests install a fixture identity explicitly.
beforeEach(() => setIdentity(["Jordan Rivers", "Sam Rivers"], ["DE89370400440532013000"]));

const HEADER =
  '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

describe("parseN26", () => {
  test("EUR row: amount_native = Amount (EUR), currency EUR, amountEur set", () => {
    const rows = parseN26(
      csv('2025-01-15,2025-01-15,REWE,DE111,Presentment,Groceries,Main,-12.34,,,'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2025-01-15",
      merchant_raw: "REWE",
      amount_native: -12.34,
      currency: "EUR",
      amountEur: -12.34, // N26 Amount (EUR) is authoritative; no FX lookup needed
      type: "spend",
      fee: 0,
      note: "Groceries",
    });
  });

  test("foreign-currency row: native takes sign from EUR amount, currency = Original Currency", () => {
    const rows = parseN26(
      csv('2025-03-01,2025-03-01,Istanbul Cafe,,Presentment,-,Main,-10.00,350.00,TRY,35'),
    );
    expect(rows[0]).toMatchObject({
      amount_native: -350, // unsigned orig magnitude, signed from the negative EUR
      currency: "TRY",
      amountEur: -10, // EUR amount carried verbatim
    });
  });

  test("DROPS a row with no Booking Date", () => {
    const rows = parseN26(
      csv(
        ',2025-01-15,NoDate,,Presentment,ref,Main,-1,,,',
        '2025-01-16,2025-01-16,HasDate,,Presentment,ref,Main,-2,,,',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.merchant_raw).toBe("HasDate");
  });

  test('Payment Reference "-" and "" both yield empty note', () => {
    const rows = parseN26(
      csv(
        '2025-01-15,2025-01-15,A,,Presentment,-,Main,-1,,,',
        '2025-01-15,2025-01-15,B,,Presentment,,Main,-1,,,',
      ),
    );
    expect(rows[0]!.note).toBe("");
    expect(rows[1]!.note).toBe("");
  });

  test("type mapping: Presentment->spend, Direct Debit->spend, Refund->income, MoneyBeam->transfer, Credit/Debit Transfer->transfer, other->unknown", () => {
    const rows = parseN26(
      csv(
        '2025-01-01,,A,,Presentment,-,Main,-1,,,',
        '2025-01-01,,B,,Direct Debit,-,Main,-1,,,',
        '2025-01-01,,C,,Presentment Refund,-,Main,1,,,',
        '2025-01-01,,D,,MoneyBeam,-,Main,-1,,,',
        '2025-01-01,,E,,Credit Transfer,-,Main,1,,,',
        '2025-01-01,,F,,Debit Transfer,-,Main,-1,,,',
        '2025-01-01,,G,,Mystery,-,Main,-1,,,',
      ),
    );
    expect(rows.map((r) => r.type)).toEqual([
      "spend",
      "spend",
      "income",
      "transfer",
      "transfer",
      "transfer",
      "unknown",
    ]);
  });

  test("transferCandidate: MoneyBeam type", () => {
    const rows = parseN26(csv('2025-01-01,,Anyone,,MoneyBeam,-,Main,-1,,,'));
    expect(rows[0]!.transferCandidate).toBe(true);
  });

  test("transferCandidate: own IBAN (case-insensitive)", () => {
    const rows = parseN26(
      csv('2025-01-01,,Vendor,de89370400440532013000,Credit Transfer,-,Main,1,,,'),
    );
    expect(rows[0]!.transferCandidate).toBe(true);
  });

  test("transferCandidate: own name in Partner Name", () => {
    const rows = parseN26(csv('2025-01-01,,Jordan Rivers,,Credit Transfer,-,Main,1,,,'));
    expect(rows[0]!.transferCandidate).toBe(true);
  });

  test("transferCandidate false for an ordinary vendor", () => {
    const rows = parseN26(csv('2025-01-01,,Random Shop,DE999,Presentment,-,Main,-1,,,'));
    expect(rows[0]!.transferCandidate).toBe(false);
  });

  test("non-Latin partner name is preserved", () => {
    const rows = parseN26(csv('2025-01-01,,Отложение,,Credit Transfer,-,Main,-1,,,'));
    expect(rows[0]!.merchant_raw).toBe("Отложение");
  });

  test("positive sign carries to native amount on foreign-currency inflow", () => {
    const rows = parseN26(csv('2025-01-01,,Refund,,Presentment Refund,-,Main,5.00,175.00,TRY,35'));
    expect(rows[0]!.amount_native).toBe(175);
    expect(rows[0]!.amountEur).toBe(5);
  });

  test("missing required header throws", () => {
    expect(() => parseN26('"Booking Date","Partner Name"\n2025,X\n')).toThrow(/missing expected column/);
  });

  test("non-numeric Amount (EUR) throws", () => {
    expect(() => parseN26(csv('2025-01-01,,X,,Presentment,-,Main,abc,,,'))).toThrow(
      /non-numeric Amount \(EUR\)/,
    );
  });

  test("connector does NOT compute an id", () => {
    const rows = parseN26(csv('2025-01-01,,X,,Presentment,-,Main,-1,,,'));
    expect((rows[0] as unknown as Record<string, unknown>).id).toBeUndefined();
  });
});
