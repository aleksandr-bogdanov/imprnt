/**
 * T-Bank (Tinkoff) card-operations connector.
 *
 * The export is semicolon-delimited, fully quoted, UTF-8, with a comma decimal
 * separator and DD.MM.YYYY HH:MM:SS timestamps. One file carries every card and
 * account together. Verified header (15 columns):
 *   Дата операции;Дата платежа;Номер карты;Статус;Сумма операции;Валюта операции;
 *   Сумма платежа;Валюта платежа;Кэшбэк;Категория;MCC;Описание;
 *   Бонусы (включая кэшбэк);Округление на инвесткопилку;Сумма операции с округлением
 *
 * Rules (from the real export):
 *   - SKIP any row whose Статус != "OK" (FAILED etc.).
 *   - date = the date part of Дата операции (always present; Дата платежа may be blank).
 *   - amount/currency = Сумма платежа / Валюта платежа — the settlement leg, i.e.
 *     what actually moved in the account's own currency. For a foreign-currency
 *     purchase (operation in TRY, settled in RUB) this keeps the row in RUB and the
 *     original amount is recorded in the note. Falls back to the operation amount
 *     only if the settlement amount is blank.
 *   - amount is already signed (negative = outflow).
 *   - type: Категория "Услуги банка" -> fee (lands in the Bank fees bucket);
 *     otherwise by sign (negative -> spend, positive -> income). Income vs spend is
 *     decided downstream by the sign of amount_eur, so the only types that change a
 *     number are transfer/exchange (excluded) — and this connector never guesses an
 *     internal transfer. P2P moves between own accounts (a person-to-person name, a
 *     cross-bank top-up, "Перевод между счетами") are classified per case in data/rules.csv
 *     with a type=transfer override, never hardcoded here.
 *   - note carries T-Bank's own Категория as a non-authoritative hint for authoring
 *     rules, plus the original foreign amount when the operation currency differs.
 *
 * The file has no running-balance column, so balance is always null; a T-Bank
 * savings/investment stock is tracked as an anchor in data/savings.csv. account and
 * owner come from the CLI flags and are applied by the import pipeline, not here.
 */

import { parseCsv } from "../csv.ts";
import type { ParsedRow, TxType } from "../types.ts";

const REQUIRED_HEADERS = [
  "Дата операции",
  "Статус",
  "Сумма операции",
  "Валюта операции",
  "Сумма платежа",
  "Валюта платежа",
  "Категория",
  "Описание",
] as const;

const BANK_FEE_CATEGORY = "Услуги банка";

/** Parse a T-Bank money string ("−1 234,56") to a number. Throws on garbage. */
function parseAmount(raw: string): number {
  // Strip thousand separators (plain, non-breaking, and narrow spaces) and switch
  // the decimal comma to a dot before Number().
  const normalized = raw.replace(/[\s  ]/g, "").replace(",", ".");
  return Number(normalized);
}

/** "23.06.2026 10:11:09" / "23.06.2026" -> "2026-06-23". "" on a bad shape. */
function toIsoDate(raw: string): string {
  const dmy = raw.trim().slice(0, 10).split(".");
  if (dmy.length !== 3) return "";
  const [dd, mm, yyyy] = dmy;
  if (!/^\d{2}$/.test(dd!) || !/^\d{2}$/.test(mm!) || !/^\d{4}$/.test(yyyy!)) return "";
  return `${yyyy}-${mm}-${dd}`;
}

/** The "HH:MM:SS" part of "23.06.2026 10:11:09", or "" when the export omits it. */
function timePart(raw: string): string {
  const t = raw.trim().slice(11);
  return /^\d{2}:\d{2}:\d{2}$/.test(t) ? t : "";
}

export function parseTbank(text: string): ParsedRow[] {
  const { header, records } = parseCsv(text, ";");
  for (const required of REQUIRED_HEADERS) {
    if (!header.includes(required)) {
      throw new Error(
        `parseTbank: missing expected column "${required}". Header was: [${header.join(", ")}]`,
      );
    }
  }

  const rows: ParsedRow[] = [];
  for (const rec of records) {
    if (rec.get("Статус").trim() !== "OK") continue; // skip FAILED / non-final rows

    const opTimestamp = rec.get("Дата операции");
    const date = toIsoDate(opTimestamp);
    if (date === "") continue; // no usable date -> cannot dedup or FX; skip defensively

    // Settlement leg is authoritative (account's own currency); fall back to the
    // operation leg only when the settlement amount is blank.
    let amountRaw = rec.get("Сумма платежа").trim();
    let currency = rec.get("Валюта платежа").trim().toUpperCase();
    if (amountRaw === "") {
      amountRaw = rec.get("Сумма операции").trim();
      currency = rec.get("Валюта операции").trim().toUpperCase();
    }
    if (amountRaw === "") continue; // no monetary value -> nothing to record

    const amount = parseAmount(amountRaw);
    if (!Number.isFinite(amount)) {
      throw new Error(`parseTbank: non-numeric amount "${amountRaw}" on ${date}`);
    }
    if (currency === "") currency = "RUB"; // export currencies are ISO; default defensively

    const description = rec.get("Описание").trim();
    const tbankCategory = rec.get("Категория").trim();

    const type: TxType = tbankCategory === BANK_FEE_CATEGORY ? "fee" : amount < 0 ? "spend" : "income";

    // note: T-Bank's category (a hint for rule-authoring, never the source of truth)
    // plus the original foreign amount when the operation currency differs from the
    // settlement currency, so a converted purchase keeps its native figure.
    const opAmountRaw = rec.get("Сумма операции").trim();
    const opCurrency = rec.get("Валюта операции").trim().toUpperCase();
    const noteParts: string[] = [];
    if (tbankCategory !== "") noteParts.push(tbankCategory);
    if (opCurrency !== "" && opCurrency !== currency && opAmountRaw !== "") {
      noteParts.push(`ориг. ${opAmountRaw} ${opCurrency}`);
    }

    rows.push({
      date,
      merchant_raw: description,
      amount_native: amount,
      currency,
      type,
      fee: 0, // the export has no per-transaction fee column
      note: noteParts.join(" · "),
      // Internal transfers are classified per case in rules.csv, not guessed here.
      transferCandidate: false,
      // RUB (and any non-EUR) is FX-converted by the pipeline via rates.csv. An EUR
      // card row is already EUR, so pass it through.
      amountEur: currency === "EUR" ? amount : null,
      // The export carries no running-balance column.
      balance: null,
      // Intraday time disambiguates two otherwise-identical same-day rows (two equal
      // taxi fares, two equal P2P transfers) that would share an id on date alone.
      dedupExtra: timePart(opTimestamp),
    });
  }

  return rows;
}
