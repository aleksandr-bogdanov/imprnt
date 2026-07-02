/**
 * Alfa-Bank statement connector — RU savings only.
 *
 * The export bundles every account into one comma-delimited, BOM-prefixed, UTF-8
 * file with a comma decimal separator and DD.MM.YYYY dates. Verified header:
 *   operationDate,transactionDate,accountName,accountNumber,cardName,cardNumber,
 *   merchant,amount,currency,status,category,mcc,type,comment,bonusValue,bonusTitle
 *
 * The RU side is savings-only (see the project scope: RU card spend and income are
 * not tracked), so this connector keeps ONLY the savings-vehicle accounts — term
 * deposits and savings accounts, accountName matching /депозит|накопительн/i — and
 * drops the spend accounts (credit card, current account) by design.
 *
 * Amounts are unsigned; direction comes from the `type` column (Пополнение = inflow,
 * Списание = outflow). An interest payout ("Выплата проц…") is income; every other
 * move into the deposit is the savings principal and maps to transfer, which is what
 * the account-scope savings stock carries (interest is upside, like an ETF dividend).
 * Currency "RUR" is normalized to ISO "RUB" so the FX table resolves it. account and
 * owner come from the CLI flags, applied by the pipeline.
 */

import { parseCsv } from "../csv.ts";
import type { ParsedRow, TxType } from "../types.ts";

const REQUIRED_HEADERS = [
  "operationDate",
  "accountName",
  "merchant",
  "amount",
  "currency",
  "type",
] as const;

/** accountName values that denote a savings vehicle (the only rows we keep). */
const SAVINGS_ACCOUNT = /депозит|накопительн/i;
/** An interest payout is income, not savings principal. */
const INTEREST = /выплата\s+проц|процент/i;

/** "16.06.2026" -> "2026-06-16". "" on a bad shape. */
function toIsoDate(raw: string): string {
  const dmy = raw.trim().slice(0, 10).split(".");
  if (dmy.length !== 3) return "";
  const [dd, mm, yyyy] = dmy;
  if (!/^\d{2}$/.test(dd!) || !/^\d{2}$/.test(mm!) || !/^\d{4}$/.test(yyyy!)) return "";
  return `${yyyy}-${mm}-${dd}`;
}

/** The "HH:MM:SS" part of "16.06.2026 10:11:09", or "" when the export omits it
 *  (the verified export is date-only, so this is normally "" and ids are unchanged). */
function timePart(raw: string): string {
  const t = raw.trim().slice(11);
  return /^\d{2}:\d{2}:\d{2}$/.test(t) ? t : "";
}

/** Parse an unsigned Alfa amount ("50 000,00") to a positive magnitude. */
function parseMagnitude(raw: string): number {
  return Number(raw.replace(/\s/g, "").replace(",", "."));
}

export function parseAlfa(text: string): ParsedRow[] {
  // Strip a UTF-8 BOM so the first header ("operationDate") matches cleanly.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const { header, records } = parseCsv(clean);
  for (const required of REQUIRED_HEADERS) {
    if (!header.includes(required)) {
      throw new Error(
        `parseAlfa: missing expected column "${required}". Header was: [${header.join(", ")}]`,
      );
    }
  }

  const rows: ParsedRow[] = [];
  for (const rec of records) {
    const accountName = rec.get("accountName").trim();
    if (!SAVINGS_ACCOUNT.test(accountName)) continue; // savings vehicles only; spend accounts dropped

    const opTimestamp = rec.get("operationDate");
    const date = toIsoDate(opTimestamp);
    if (date === "") continue; // no usable date -> cannot dedup or FX; skip defensively

    const magnitude = parseMagnitude(rec.get("amount").trim());
    if (!Number.isFinite(magnitude)) {
      throw new Error(`parseAlfa: non-numeric amount "${rec.get("amount")}" on ${date}`);
    }
    const direction = rec.get("type").trim() === "Списание" ? -1 : 1; // Пополнение = inflow
    const amount = direction * magnitude;

    // Alfa writes the legacy code "RUR"; normalize to the ISO "RUB" the rate table uses.
    let currency = rec.get("currency").trim().toUpperCase();
    if (currency === "RUR") currency = "RUB";

    const merchant = rec.get("merchant").trim();
    const comment = header.includes("comment") ? rec.get("comment").trim() : "";
    const category = header.includes("category") ? rec.get("category").trim() : "";

    // Interest on the deposit is income (upside, not principal). Every other move into
    // a savings vehicle is the savings principal -> transfer (counted by the stock).
    const isInterest = INTEREST.test(merchant) || INTEREST.test(comment);
    const type: TxType = isInterest ? "income" : "transfer";

    rows.push({
      date,
      merchant_raw: merchant !== "" ? merchant : accountName,
      amount_native: amount,
      currency,
      type,
      fee: 0,
      note: category,
      transferCandidate: type === "transfer",
      amountEur: currency === "EUR" ? amount : null,
      balance: null,
      // Intraday time disambiguates two otherwise-identical same-day rows should
      // the export carry it; "" on the verified date-only shape keeps ids as-is.
      dedupExtra: timePart(opTimestamp),
    });
  }

  return rows;
}
