import { beforeEach, describe, expect, test } from "bun:test";
import { parseRevolut } from "./revolut.ts";
import { setIdentity } from "../identity.ts";

// Own-name transfer detection reads the identity the CLI loads from
// data/profile.json at runtime. Tests install a fixture identity explicitly.
beforeEach(() => setIdentity(["Jordan Rivers", "Sam Rivers"], []));

const HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

describe("parseRevolut", () => {
  test("parses a completed card payment with signed amount and fee", () => {
    const rows = parseRevolut(
      csv("Card Payment,Current,2025-01-15 10:00:00,2025-01-15 11:00:00,REWE,-12.34,0.10,EUR,COMPLETED,100.00"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2025-01-15",
      merchant_raw: "REWE",
      amount_native: -12.34,
      currency: "EUR",
      type: "spend",
      fee: 0.1,
      note: "",
      transferCandidate: false,
      amountEur: null, // pipeline resolves FX; connector never sets EUR for revolut
    });
  });

  test("captures the running Balance column (stock layer)", () => {
    const rows = parseRevolut(
      csv("Card Payment,Current,2025-01-15 10:00:00,2025-01-15 11:00:00,REWE,-12.34,0,EUR,COMPLETED,87.66"),
    );
    expect(rows[0]!.balance).toBe(87.66);
  });

  test("a blank Balance yields null, never a guessed 0", () => {
    const rows = parseRevolut(
      csv("Card Payment,Current,2025-01-15 10:00:00,2025-01-15 11:00:00,REWE,-12.34,0,EUR,COMPLETED,"),
    );
    expect(rows[0]!.balance).toBeNull();
  });

  test("a non-numeric Balance throws rather than coercing", () => {
    expect(() =>
      parseRevolut(
        csv("Card Payment,Current,2025-01-15 10:00:00,2025-01-15 11:00:00,REWE,-12.34,0,EUR,COMPLETED,n/a"),
      ),
    ).toThrow(/non-numeric Balance/);
  });

  test("DROPS a non-COMPLETED row (REVERTED)", () => {
    const rows = parseRevolut(
      csv(
        "Card Payment,Current,2025-01-15 10:00:00,,REWE Reverted,-12.34,0,EUR,REVERTED,100.00",
        "Card Payment,Current,2025-01-16 10:00:00,2025-01-16 11:00:00,ALDI,-5.00,0,EUR,COMPLETED,95.00",
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.merchant_raw).toBe("ALDI");
  });

  test("DROPS PENDING and DECLINED rows", () => {
    const rows = parseRevolut(
      csv(
        "Card Payment,Current,2025-01-15 10:00:00,2025-01-15,Pend,-1,0,EUR,PENDING,1",
        "Card Payment,Current,2025-01-15 10:00:00,2025-01-15,Decl,-1,0,EUR,DECLINED,1",
      ),
    );
    expect(rows).toHaveLength(0);
  });

  test("date uses Completed Date, date part only", () => {
    const rows = parseRevolut(
      csv("Topup,Current,2025-02-01 09:00:00,2025-02-02 23:59:59,Top,50,0,EUR,COMPLETED,1"),
    );
    expect(rows[0]!.date).toBe("2025-02-02");
  });

  test("type mapping: ATM->spend, Topup->income, Transfer->transfer, Fee->fee, Exchange->exchange, unknown->unknown", () => {
    const rows = parseRevolut(
      csv(
        "ATM,Current,2025-01-01,2025-01-01,Cash,-20,0,EUR,COMPLETED,1",
        "Topup,Current,2025-01-01,2025-01-01,Top,20,0,EUR,COMPLETED,1",
        "Transfer,Current,2025-01-01,2025-01-01,Move,-20,0,EUR,COMPLETED,1",
        "Fee,Current,2025-01-01,2025-01-01,Charge,-1,0,EUR,COMPLETED,1",
        "Exchange,Current,2025-01-01,2025-01-01,FX,-20,0,EUR,COMPLETED,1",
        "Weird,Current,2025-01-01,2025-01-01,Huh,-20,0,EUR,COMPLETED,1",
      ),
    );
    expect(rows.map((r) => r.type)).toEqual([
      "spend",
      "income",
      "transfer",
      "fee",
      "exchange",
      "unknown",
    ]);
  });

  test("transferCandidate true when description matches own-name transfer regex", () => {
    const rows = parseRevolut(
      csv(
        "Transfer,Current,2025-01-01,2025-01-01,Transfer to JORDAN RIVERS,-100,0,EUR,COMPLETED,1",
        "Transfer,Current,2025-01-01,2025-01-01,Transfer to Some Vendor,-100,0,EUR,COMPLETED,1",
      ),
    );
    expect(rows[0]!.transferCandidate).toBe(true);
    expect(rows[1]!.transferCandidate).toBe(false);
  });

  test("dedupExtra carries the Started Date time, so two identical same-day rows stay distinct", () => {
    const rows = parseRevolut(
      csv(
        "Card Payment,Current,2026-05-10 09:12:00,2026-05-10 09:13:00,BVG Ticket,-3.50,0,EUR,COMPLETED,50.00",
        "Card Payment,Current,2026-05-10 18:40:00,2026-05-10 18:41:00,BVG Ticket,-3.50,0,EUR,COMPLETED,46.50",
      ),
    );
    expect(rows.map((r) => r.dedupExtra)).toEqual(["09:12:00", "18:40:00"]);
  });

  test("dedupExtra is empty when Started Date has no time part", () => {
    const rows = parseRevolut(
      csv("Card Payment,Current,2025-01-15,2025-01-15,REWE,-12.34,0,EUR,COMPLETED,100.00"),
    );
    expect(rows[0]!.dedupExtra).toBe("");
  });

  test("empty fee parses as 0", () => {
    const rows = parseRevolut(
      csv("Card Payment,Current,2025-01-01,2025-01-01,X,-1,,EUR,COMPLETED,1"),
    );
    expect(rows[0]!.fee).toBe(0);
  });

  test("currency is upper-cased", () => {
    const rows = parseRevolut(
      csv("Card Payment,Current,2025-01-01,2025-01-01,X,-1,0,usd,COMPLETED,1"),
    );
    expect(rows[0]!.currency).toBe("USD");
  });

  test("embedded comma in a quoted description survives", () => {
    const rows = parseRevolut(
      csv('Card Payment,Current,2025-01-01,2025-01-01,"OKTAN Brzeski, Grzenkowicz",-1,0,EUR,COMPLETED,1'),
    );
    expect(rows[0]!.merchant_raw).toBe("OKTAN Brzeski, Grzenkowicz");
  });

  test("missing required header throws", () => {
    expect(() => parseRevolut("Type,Amount\nCard Payment,-1\n")).toThrow(/missing expected column/);
  });

  test("non-numeric Amount throws", () => {
    expect(() =>
      parseRevolut(csv("Card Payment,Current,2025-01-01,2025-01-01,X,abc,0,EUR,COMPLETED,1")),
    ).toThrow(/non-numeric Amount/);
  });

  test("connector does NOT compute an id (no id field on ParsedRow)", () => {
    const rows = parseRevolut(csv("Card Payment,Current,2025-01-01,2025-01-01,X,-1,0,EUR,COMPLETED,1"));
    expect((rows[0] as unknown as Record<string, unknown>).id).toBeUndefined();
  });
});
