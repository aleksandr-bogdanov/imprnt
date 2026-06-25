import { describe, expect, test } from "bun:test";
import { parseTbank } from "./tbank.ts";

// The 15 verified columns, in order. All fixtures are fully quoted and
// semicolon-delimited, exactly as the real T-Bank export.
const COLUMNS = [
  "Дата операции",
  "Дата платежа",
  "Номер карты",
  "Статус",
  "Сумма операции",
  "Валюта операции",
  "Сумма платежа",
  "Валюта платежа",
  "Кэшбэк",
  "Категория",
  "MCC",
  "Описание",
  "Бонусы (включая кэшбэк)",
  "Округление на инвесткопилку",
  "Сумма операции с округлением",
] as const;

type Col = (typeof COLUMNS)[number];

const DEFAULTS: Record<Col, string> = {
  "Дата операции": "23.06.2026 10:00:00",
  "Дата платежа": "23.06.2026",
  "Номер карты": "*2612",
  "Статус": "OK",
  "Сумма операции": "-100,00",
  "Валюта операции": "RUB",
  "Сумма платежа": "-100,00",
  "Валюта платежа": "RUB",
  "Кэшбэк": "",
  "Категория": "Супермаркеты",
  "MCC": "5411",
  "Описание": "Магазин",
  "Бонусы (включая кэшбэк)": "0,00",
  "Округление на инвесткопилку": "0,00",
  "Сумма операции с округлением": "-100,00",
};

/** Quote and semicolon-join one row from defaults plus overrides. */
function row(overrides: Partial<Record<Col, string>> = {}): string {
  return COLUMNS.map((c) => `"${overrides[c] ?? DEFAULTS[c]}"`).join(";");
}

const HEADER = COLUMNS.map((c) => `"${c}"`).join(";");

/** A full document (CRLF line endings, like the real export) from row strings. */
function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\r\n") + "\r\n";
}

describe("parseTbank", () => {
  test("basic spend row: DD.MM.YYYY -> ISO, settlement amount, RUB, type spend, note=category", () => {
    const rows = parseTbank(csv(row()));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-06-23",
      merchant_raw: "Магазин",
      amount_native: -100,
      currency: "RUB",
      amountEur: null, // RUB is FX-converted by the pipeline, not here
      type: "spend",
      fee: 0,
      note: "Супермаркеты",
      transferCandidate: false,
      balance: null,
      dedupExtra: "10:00:00",
    });
  });

  test("dedupExtra carries the intraday time, so two identical same-day rows stay distinct", () => {
    const rows = parseTbank(
      csv(
        row({ "Дата операции": "17.05.2026 16:12:04", "Сумма операции": "1000,00", "Сумма платежа": "1000,00", "Категория": "Переводы", "Описание": "Иван П." }),
        row({ "Дата операции": "17.05.2026 16:01:22", "Сумма операции": "1000,00", "Сумма платежа": "1000,00", "Категория": "Переводы", "Описание": "Иван П." }),
      ),
    );
    expect(rows.map((r) => r.dedupExtra)).toEqual(["16:12:04", "16:01:22"]);
  });

  test("dedupExtra is empty when the timestamp has no time part", () => {
    const rows = parseTbank(csv(row({ "Дата операции": "17.05.2026" })));
    expect(rows[0]!.dedupExtra).toBe("");
  });

  test("positive amount -> income", () => {
    const rows = parseTbank(
      csv(row({ "Сумма операции": "7110,00", "Сумма платежа": "7110,00", "Категория": "Переводы", "Описание": "Tribute Kazan" })),
    );
    expect(rows[0]).toMatchObject({ amount_native: 7110, type: "income" });
  });

  test('Категория "Услуги банка" -> type fee', () => {
    const rows = parseTbank(
      csv(row({ "Категория": "Услуги банка", "Описание": "Плата за оповещения", "Сумма платежа": "-99,00", "Сумма операции": "-99,00" })),
    );
    expect(rows[0]!.type).toBe("fee");
  });

  test("skips a row whose Статус is not OK", () => {
    const rows = parseTbank(
      csv(
        row({ "Статус": "FAILED", "Описание": "Failed one" }),
        row({ "Статус": "OK", "Описание": "Good one" }),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.merchant_raw).toBe("Good one");
  });

  test("foreign-currency purchase: settles in RUB, original kept in the note", () => {
    const rows = parseTbank(
      csv(
        row({
          "Сумма операции": "-500,00",
          "Валюта операции": "TRY",
          "Сумма платежа": "-851,50",
          "Валюта платежа": "RUB",
          "Категория": "Такси",
          "Описание": "Яндекс Такси",
        }),
      ),
    );
    expect(rows[0]).toMatchObject({
      amount_native: -851.5,
      currency: "RUB",
      amountEur: null,
      note: "Такси · ориг. -500,00 TRY",
    });
  });

  test("blank settlement amount falls back to the operation leg", () => {
    const rows = parseTbank(
      csv(
        row({
          "Сумма операции": "-250,00",
          "Валюта операции": "RUB",
          "Сумма платежа": "",
          "Валюта платежа": "",
        }),
      ),
    );
    expect(rows[0]).toMatchObject({ amount_native: -250, currency: "RUB" });
  });

  test("EUR card row: amountEur is set directly, no FX needed", () => {
    const rows = parseTbank(
      csv(
        row({
          "Сумма операции": "-12,34",
          "Валюта операции": "EUR",
          "Сумма платежа": "-12,34",
          "Валюта платежа": "EUR",
        }),
      ),
    );
    expect(rows[0]).toMatchObject({ amount_native: -12.34, currency: "EUR", amountEur: -12.34 });
  });

  test("thousand separators (incl. non-breaking space) are stripped", () => {
    const rows = parseTbank(
      csv(row({ "Сумма операции": "-1 234,56", "Сумма платежа": "-1 234,56" })),
    );
    expect(rows[0]!.amount_native).toBe(-1234.56);
  });

  test("note is empty when category is blank and there is no currency conversion", () => {
    const rows = parseTbank(csv(row({ "Категория": "" })));
    expect(rows[0]!.note).toBe("");
  });

  test("transferCandidate is always false — internal transfers are classified via rules", () => {
    const rows = parseTbank(
      csv(
        row({ "Категория": "Переводы", "Описание": "Иван П.", "Сумма платежа": "-4000,00", "Сумма операции": "-4000,00" }),
        row({ "Категория": "Переводы", "Описание": "Перевод между счетами", "Сумма платежа": "-10000,00", "Сумма операции": "-10000,00" }),
      ),
    );
    expect(rows.every((r) => r.transferCandidate === false)).toBe(true);
  });

  test("a row with an unparseable date is dropped", () => {
    const rows = parseTbank(
      csv(
        row({ "Дата операции": "", "Описание": "NoDate" }),
        row({ "Дата операции": "2026-06-23", "Описание": "WrongShape" }), // ISO, not DD.MM.YYYY
        row({ "Дата операции": "23.06.2026 10:00:00", "Описание": "Good" }),
      ),
    );
    expect(rows.map((r) => r.merchant_raw)).toEqual(["Good"]);
  });

  test("missing required header throws", () => {
    expect(() => parseTbank('"Дата операции";"Описание"\r\n"23.06.2026";"X"\r\n')).toThrow(
      /missing expected column/,
    );
  });

  test("non-numeric amount throws", () => {
    expect(() => parseTbank(csv(row({ "Сумма платежа": "abc", "Сумма операции": "abc" })))).toThrow(
      /non-numeric amount/,
    );
  });

  test("connector does NOT compute an id", () => {
    const rows = parseTbank(csv(row()));
    expect((rows[0] as unknown as Record<string, unknown>).id).toBeUndefined();
  });
});
