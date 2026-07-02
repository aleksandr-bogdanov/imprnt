import { describe, expect, test } from "bun:test";
import { parseAlfa } from "./alfa.ts";

const COLUMNS = [
  "operationDate", "transactionDate", "accountName", "accountNumber", "cardName",
  "cardNumber", "merchant", "amount", "currency", "status", "category", "mcc",
  "type", "comment", "bonusValue", "bonusTitle",
] as const;

type Col = (typeof COLUMNS)[number];

const DEFAULTS: Record<Col, string> = {
  operationDate: "20.05.2026", transactionDate: "20.05.2026", accountName: "Срочный депозит",
  accountNumber: "42303810400000000001", cardName: "", cardNumber: "", merchant: "Открытие депозита",
  amount: "50000,00", currency: "RUR", status: "OK", category: "Пополнения", mcc: "",
  type: "Пополнение", comment: "", bonusValue: "0,00", bonusTitle: "",
};

function row(overrides: Partial<Record<Col, string>> = {}): string {
  return COLUMNS.map((c) => `"${overrides[c] ?? DEFAULTS[c]}"`).join(",");
}
const HEADER = COLUMNS.map((c) => `"${c}"`).join(",");
function csv(...rows: string[]): string {
  return "﻿" + [HEADER, ...rows].join("\r\n") + "\r\n"; // include a BOM like the real export
}

describe("parseAlfa", () => {
  test("deposit principal: kept, RUR->RUB, type transfer, positive from Пополнение", () => {
    const rows = parseAlfa(csv(row()));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-05-20",
      merchant_raw: "Открытие депозита",
      amount_native: 50000,
      currency: "RUB", // normalized from RUR so the FX table resolves it
      type: "transfer",
      transferCandidate: true,
      amountEur: null,
    });
  });

  test("interest payout is income, not savings principal", () => {
    const rows = parseAlfa(
      csv(row({ merchant: "Выплата проц по деп.№ BQ89", amount: "328,49", category: "Пополнения" })),
    );
    expect(rows[0]).toMatchObject({ amount_native: 328.49, type: "income" });
  });

  test("spend accounts (credit card, current) are dropped — savings only", () => {
    const rows = parseAlfa(
      csv(
        row({ accountName: "Счёт кредитной карты", merchant: "ООО БИГЛИОН", type: "Списание", amount: "1850,00" }),
        row({ accountName: "Текущий счёт", merchant: "Дмитрий К.", type: "Списание", amount: "4000,00" }),
        row({ accountName: "Срочный депозит" }), // the only one kept
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_native).toBe(50000); // only the Срочный депозит row survives
  });

  test("Списание yields a negative amount", () => {
    const rows = parseAlfa(
      csv(row({ accountName: "Накопительный счёт", type: "Списание", amount: "1000,00", merchant: "снятие" })),
    );
    expect(rows[0]!.amount_native).toBe(-1000);
  });

  test("thousand-separator spaces in the amount are stripped", () => {
    const rows = parseAlfa(csv(row({ amount: "50 000,00" })));
    expect(rows[0]!.amount_native).toBe(50000);
  });

  test("dedupExtra is empty on the verified date-only export (ids unchanged)", () => {
    const rows = parseAlfa(csv(row()));
    expect(rows[0]!.dedupExtra).toBe("");
  });

  test("dedupExtra carries the intraday time when the export has one", () => {
    const rows = parseAlfa(csv(row({ operationDate: "20.05.2026 10:11:09" })));
    expect(rows[0]!.date).toBe("2026-05-20");
    expect(rows[0]!.dedupExtra).toBe("10:11:09");
  });

  test("missing required header throws", () => {
    expect(() => parseAlfa('"operationDate","amount"\r\n"20.05.2026","1"\r\n')).toThrow(
      /missing expected column/,
    );
  });
});
