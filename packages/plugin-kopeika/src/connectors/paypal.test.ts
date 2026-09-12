import { describe, expect, test } from "bun:test";
import { parseEuroNumber, parsePaypal } from "./paypal.ts";

const STMT_HEADER =
  '"Date","Time","Time Zone","Description","Currency","Gross","Fee","Net","Balance","Transaction ID","From Email Address","Name","Bank Name","Bank Account","Shipping and Handling Amount","Sales Tax","Invoice ID","Reference Txn ID"';
const ACT_HEADER =
  '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Item Title","Invoice Number","Balance","Subject","Balance Impact"';

function stmt(...rows: string[]): string {
  return "﻿" + [STMT_HEADER, ...rows].join("\r\n") + "\r\n";
}
function act(...rows: string[]): string {
  return "﻿" + [ACT_HEADER, ...rows].join("\r\n") + "\r\n";
}

describe("parseEuroNumber", () => {
  test("decimal comma, dot thousands, sign, blank", () => {
    expect(parseEuroNumber("-4,99", "x")).toBe(-4.99);
    expect(parseEuroNumber("1.234,56", "x")).toBe(1234.56);
    expect(parseEuroNumber("", "x")).toBe(0);
    expect(() => parseEuroNumber("abc", "x")).toThrow(/non-numeric/);
  });
});

describe("parsePaypal statement shape (personal account)", () => {
  test("a student payment is income named after the payer, id rides on Transaction ID", () => {
    const rows = parsePaypal(
      stmt('"09.01.2026","10:00:00","Europe/Berlin","Mobile Payment","EUR","40,00","0,00","40,00","367,61","1AB2CD3EF","x@y.de","Arina Capanu","","","0,00","0,00","",""'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-01-09",
      merchant_raw: "Arina Capanu",
      amount_native: 40,
      currency: "EUR",
      type: "income",
      fee: 0,
      note: "Mobile Payment",
      transferCandidate: false,
      amountEur: null,
      balance: 367.61,
      dedupExtra: "1AB2CD3EF",
    });
  });

  test("a card withdrawal is a transfer candidate, fee is absolute, empty name falls back to the type", () => {
    const rows = parsePaypal(
      stmt('"12.03.2026","10:00:00","Europe/Berlin","General Card Withdrawal","EUR","-100,00","-0,35","-100,35","1,00","ZZZ","","","","","0,00","0,00","",""'),
    );
    expect(rows[0]).toMatchObject({ merchant_raw: "General Card Withdrawal", type: "transfer", transferCandidate: true, fee: 0.35, amount_native: -100 });
  });

  test("holds, reversals and conversions: holds skipped, conversion is an exchange", () => {
    const rows = parsePaypal(
      stmt(
        '"12.07.2026","10:00:00","Europe/Berlin","Account Hold for Open Authorization","EUR","-10,00","0,00","-10,00","1,00","H1","","","","","0,00","0,00","",""',
        '"12.07.2026","10:00:00","Europe/Berlin","Reversal of General Account Hold","EUR","10,00","0,00","10,00","11,00","H2","","","","","0,00","0,00","",""',
        '"12.07.2026","10:00:00","Europe/Berlin","General Currency Conversion","USD","47,45","0,00","47,45","0,00","C1","","","","","0,00","0,00","",""',
        '"12.07.2026","10:00:00","Europe/Berlin","Payment Refund","EUR","5,00","0,00","5,00","16,00","R1","","Some Shop","","","0,00","0,00","",""',
      ),
    );
    expect(rows.map((r) => r.type)).toEqual(["exchange", "income"]);
    expect(rows[0]!.currency).toBe("USD");
  });
});

describe("parsePaypal activity report shape (business account)", () => {
  test("keeps Completed money-moving rows only, DD/MM/YYYY dates, note from item title", () => {
    const rows = parsePaypal(
      act(
        '"03/01/2026","06:59:16","PST","Zalando Payments GmbH","Express Checkout Payment","Completed","EUR","-27,75","0,00","-27,75","a@b","c@d","T1","","","100,00","","Debit"',
        '"14/01/2026","06:59:16","PST","Tatiana Kligman","Mobile Payment","Completed","EUR","480,00","0,00","480,00","a@b","c@d","T2","","","580,00","","Credit"',
        '"15/01/2026","06:59:16","PST","Somebody","General Authorization","Pending","EUR","-9,00","0,00","-9,00","a@b","c@d","T3","","","580,00","","Memo"',
        '"16/01/2026","06:59:16","PST","Somebody","General Card Deposit","Denied","EUR","50,00","0,00","50,00","a@b","c@d","T4","","","580,00","","Memo"',
        '"11/09/2026","01:10:34","PDT","Mix Management GmbH","Website Payment","Completed","EUR","-50,00","0,00","-50,00","a@b","c@d","T5","Room 1 (deposit)","","530,00","","Debit"',
      ),
    );
    expect(rows.map((r) => r.dedupExtra)).toEqual(["T1", "T2", "T5"]);
    expect(rows[0]).toMatchObject({ date: "2026-01-03", type: "spend", amount_native: -27.75 });
    expect(rows[1]).toMatchObject({ date: "2026-01-14", type: "income", merchant_raw: "Tatiana Kligman", balance: 580 });
    expect(rows[2]!.note).toBe("Room 1 (deposit) · Website Payment");
  });

  test("rejects a file that is neither shape", () => {
    expect(() => parsePaypal("Date,Currency,Gross,Fee,Transaction ID,Name\n")).toThrow(/neither/);
  });
});
