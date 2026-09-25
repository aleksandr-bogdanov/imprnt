/**
 * PayPal connector: the two CSV shapes PayPal hands out, one parser.
 *
 * Personal account, "Statements > custom range > CSV" (file named <id>-CSR-<from>-<to>-<generated>.CSV):
 *   "Date","Time","Time Zone","Description","Currency","Gross","Fee","Net","Balance","Transaction ID",
 *   "From Email Address","Name","Bank Name","Bank Account","Shipping and Handling Amount","Sales Tax",
 *   "Invoice ID","Reference Txn ID"
 *   Date is DD.MM.YYYY, Time Zone Europe/Berlin, every row is balance-affecting, no Status column.
 *   "Description" carries the PayPal transaction type ("Mobile Payment", "General Card Withdrawal", ...).
 *
 * Business account, "Activity report" (reports/dlog, file named Download.CSV):
 *   "Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net",...,"Balance",...,
 *   "Balance Impact"
 *   Date is DD/MM/YYYY in PST/PDT, "Status" is Completed|Pending|Denied and "Balance Impact" is
 *   Credit|Debit|Memo. Memo rows (authorizations, denied deposits) never moved money.
 *
 * Both: decimal comma with dot thousands ("1.234,56"), Gross signed from the account's point of view,
 * Fee negative when PayPal took one. Rules:
 *   - keep only Completed, balance-affecting rows (the statement shape is already that by construction).
 *   - SKIP holds and their reversals: a hold is money parked for an open authorization and released
 *     again, never a payment to anyone. The captured payment arrives as its own row.
 *   - Card deposits / withdrawals and bank deposits / user-initiated withdrawals move money between
 *     PayPal and the owner's own bank card: type=transfer, transferCandidate so `transfers` pairs the
 *     legs against the bank side.
 *   - Currency conversion legs are exchanges (the household report already excludes them).
 *   - Everything else is spend when negative, income when positive. Refunds are income.
 *   - merchant_raw = Name, falling back to the transaction type when PayPal gives no counterparty.
 *   - The Transaction ID rides in dedupExtra, so two identical same-day payments never collapse.
 *   - amountEur stays null: the pipeline converts through data/rates.csv (USD rows exist).
 */

import { parseCsv } from "../csv.ts";
import type { ParsedRow, TxType } from "../types.ts";

const SHARED_HEADERS = ["Date", "Currency", "Gross", "Fee", "Transaction ID", "Name"] as const;

/** Rows that park money for an open authorization and give it back. No counterparty ever gets it. */
const SKIP_TYPES = new Set([
  "Account Hold for Open Authorization",
  "Reversal of General Account Hold",
  "General Hold",
  "General Hold Release",
  "General Authorization",
]);

/** Moves between PayPal and the owner's own bank or card. */
const TRANSFER_TYPES = new Set([
  "General Card Deposit",
  "General Card Withdrawal",
  "Bank Deposit to PP Account",
  "User Initiated Withdrawal",
  "General Withdrawal",
]);

const EXCHANGE_TYPES = new Set(["General Currency Conversion"]);

const REFUND_TYPES = new Set(["Payment Refund", "General Refund"]);

function mapType(ppType: string, gross: number): TxType {
  if (TRANSFER_TYPES.has(ppType)) return "transfer";
  if (EXCHANGE_TYPES.has(ppType)) return "exchange";
  if (REFUND_TYPES.has(ppType)) return "income";
  return gross < 0 ? "spend" : "income";
}

/** "1.234,56" -> 1234.56, "-4,99" -> -4.99, "" -> 0. Throws on anything else. */
export function parseEuroNumber(raw: string, what: string): number {
  const s = raw.trim();
  if (s === "") return 0;
  const normalized = s.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) throw new Error(`parsePaypal: non-numeric ${what} "${raw}"`);
  return n;
}

/** DD.MM.YYYY or DD/MM/YYYY -> YYYY-MM-DD. */
/** "HH:MM" from a PayPal Time cell when the zone is Central European (or unstated), else "". */
function timeOfDay(raw: string, tz: string): string {
  const t = raw.trim();
  const z = tz.trim();
  if (!/^\d{2}:\d{2}/.test(t)) return "";
  if (z !== "" && !/^(Europe\/|CES?T$)/.test(z)) return "";
  return t.slice(0, 5);
}

/**
 * The business Activity report states US Pacific time (PST/PDT). The row is moved
 * to Berlin, where the money actually moved for the owner: a payment at 23:59 PDT
 * is the next morning in Berlin. Other zones pass through unchanged.
 */
function toBerlin(date: string, time: string, tz: string): { date: string; time: string } {
  const offset = tz.trim() === "PDT" ? 7 : tz.trim() === "PST" ? 8 : null;
  if (offset === null || !/^\d{2}:\d{2}/.test(time.trim())) return { date, time: timeOfDay(time, tz) };
  const [h, m, sec] = time.trim().split(":").map(Number);
  const utc = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h! + offset, m!, sec ?? 0);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(utc))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function isoDate(raw: string): string {
  const m = raw.trim().match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
  if (!m) throw new Error(`parsePaypal: unexpected date "${raw}" (want DD.MM.YYYY or DD/MM/YYYY)`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function parsePaypal(text: string): ParsedRow[] {
  // PayPal writes a UTF-8 BOM; the parser keeps it glued to the first header name.
  const { header, records } = parseCsv(text.replace(/^\uFEFF/, ""));
  for (const required of SHARED_HEADERS) {
    if (!header.includes(required)) {
      throw new Error(`parsePaypal: missing expected column "${required}". Header was: [${header.join(", ")}]`);
    }
  }
  const business = header.includes("Type") && header.includes("Status");
  if (!business && !header.includes("Description")) {
    throw new Error(`parsePaypal: neither the activity report (Type/Status) nor the statement (Description) shape. Header was: [${header.join(", ")}]`);
  }
  const hasImpact = header.includes("Balance Impact");
  const hasBalance = header.includes("Balance");
  // The personal statement is Europe/Berlin already; the business Activity report is
  // PST/PDT and is converted to Berlin (see toBerlin), its id keeping the stated date.
  const tzColumn = header.includes("Time Zone") ? "Time Zone" : header.includes("TimeZone") ? "TimeZone" : "";
  const hasTime = header.includes("Time");

  const rows: ParsedRow[] = [];
  for (const rec of records) {
    const ppType = (business ? rec.get("Type") : rec.get("Description")).trim();
    if (ppType === "") continue;
    if (business) {
      if (rec.get("Status").trim() !== "Completed") continue;
      if (hasImpact && rec.get("Balance Impact").trim() === "Memo") continue;
    }
    if (SKIP_TYPES.has(ppType)) continue;

    const statedDate = isoDate(rec.get("Date"));
    const moment = toBerlin(statedDate, hasTime ? rec.get("Time") : "", tzColumn ? rec.get(tzColumn) : "");
    const date = moment.date;
    const currency = rec.get("Currency").trim().toUpperCase();
    const gross = parseEuroNumber(rec.get("Gross"), `Gross on ${date}`);
    const fee = Math.abs(parseEuroNumber(rec.get("Fee"), `Fee on ${date}`));
    const name = rec.get("Name").trim();
    const merchant_raw = name !== "" ? name : ppType;

    const noteParts: string[] = [];
    for (const col of ["Item Title", "Subject", "Invoice Number", "Invoice ID"]) {
      if (!header.includes(col)) continue;
      const v = rec.get(col).trim();
      if (v !== "") noteParts.push(v);
    }
    if (name !== "") noteParts.push(ppType);

    let balance: number | null = null;
    if (hasBalance) {
      const b = rec.get("Balance").trim();
      if (b !== "") balance = parseEuroNumber(b, `Balance on ${date}`);
    }

    const type = mapType(ppType, gross);
    rows.push({
      date,
      merchant_raw,
      amount_native: gross,
      currency,
      type,
      fee,
      note: noteParts.join(" · "),
      transferCandidate: type === "transfer",
      amountEur: null,
      balance,
      time: moment.time,
      dedupExtra: rec.get("Transaction ID").trim(),
      idDate: statedDate,
    });
  }
  return rows;
}
