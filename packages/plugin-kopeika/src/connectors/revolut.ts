/**
 * Revolut account-statement connector.
 *
 * Verified header (RFC 4180; only comma-bearing descriptions are quoted):
 *   Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
 *
 * Rules (from the real export, observed in account-statement_*_en-gb_*.csv):
 *   - SKIP any row whose State != COMPLETED (REVERTED / PENDING / DECLINED ...).
 *   - date = Completed Date (date part); fall back to Started Date when blank
 *     (REVERTED rows have empty Completed Date, but those are skipped anyway).
 *   - merchant_raw = Description, amount_native = Amount (already signed),
 *     currency = Currency, fee = Fee.
 *   - type mapping below; observed Types include ATM, Card Payment, Card Refund,
 *     CARD_CREDIT, Exchange, Fee, Rev Payment, Topup, Transfer.
 *   - Internal-transfer hint: a "Transfer (from|to) ..." description naming one of
 *     your own names. The names come from data/profile.json (see ../identity.ts),
 *     never hardcoded.
 *
 * The file carries no account identity; account/owner come from CLI flags and are
 * applied by the import pipeline, not here.
 */

import { parseCsv } from "../csv.ts";
import { matchesOwnName } from "../identity.ts";
import type { ParsedRow, TxType } from "../types.ts";

/** A "Transfer from/to ..." line, the prefix that an own-name internal move uses. */
const TRANSFER_PREFIX = /Transfer\s+(from|to)\s/i;

const REQUIRED_HEADERS = [
  "Type",
  "Started Date",
  "Completed Date",
  "Description",
  "Amount",
  "Fee",
  "Currency",
  "State",
] as const;

function mapType(revolutType: string): TxType {
  switch (revolutType) {
    case "Card Payment":
    case "ATM":
      return "spend";
    case "Topup":
    case "Card Refund":
    case "CARD_CREDIT":
    case "Rev Payment":
      return "income";
    case "Transfer":
      return "transfer";
    case "Fee":
      return "fee";
    case "Exchange":
      return "exchange";
    default:
      return "unknown";
  }
}

/** Extract the date part (YYYY-MM-DD) from a "YYYY-MM-DD HH:MM:SS" timestamp. */
function datePart(timestamp: string): string {
  return timestamp.trim().split(" ")[0] ?? "";
}

export function parseRevolut(text: string): ParsedRow[] {
  const { header, records } = parseCsv(text);
  for (const required of REQUIRED_HEADERS) {
    if (!header.includes(required)) {
      throw new Error(
        `parseRevolut: missing expected column "${required}". Header was: [${header.join(", ")}]`,
      );
    }
  }

  const rows: ParsedRow[] = [];
  for (const rec of records) {
    const state = rec.get("State").trim();
    if (state !== "COMPLETED") continue; // skip REVERTED / PENDING / DECLINED

    const completed = datePart(rec.get("Completed Date"));
    const started = datePart(rec.get("Started Date"));
    const date = completed !== "" ? completed : started;
    if (date === "") continue; // no usable date — cannot dedup or FX; skip defensively

    const description = rec.get("Description").trim();
    const amountRaw = rec.get("Amount").trim();
    const feeRaw = rec.get("Fee").trim();
    const currency = rec.get("Currency").trim().toUpperCase();

    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) {
      throw new Error(`parseRevolut: non-numeric Amount "${amountRaw}" for "${description}" on ${date}`);
    }
    const fee = feeRaw === "" ? 0 : Number(feeRaw);
    if (!Number.isFinite(fee)) {
      throw new Error(`parseRevolut: non-numeric Fee "${feeRaw}" for "${description}" on ${date}`);
    }

    const type = mapType(rec.get("Type").trim());
    const transferCandidate = TRANSFER_PREFIX.test(description) && matchesOwnName(description);

    // Running balance after the row, in `currency`. Present in the verified header
    // but read defensively: a blank or absent Balance yields null, never a guess.
    const balanceRaw = header.includes("Balance") ? rec.get("Balance").trim() : "";
    let balance: number | null = null;
    if (balanceRaw !== "") {
      const parsed = Number(balanceRaw);
      if (!Number.isFinite(parsed)) {
        throw new Error(`parseRevolut: non-numeric Balance "${balanceRaw}" for "${description}" on ${date}`);
      }
      balance = parsed;
    }

    rows.push({
      date,
      merchant_raw: description,
      amount_native: amount,
      currency,
      type,
      fee,
      note: "",
      transferCandidate,
      // Revolut amounts are in `currency`; FX is resolved by the pipeline. When
      // the row is already EUR the pipeline's toEur() passes it through at 1.
      amountEur: null,
      balance,
    });
  }

  return rows;
}
