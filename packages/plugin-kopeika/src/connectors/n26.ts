/**
 * N26 transactions connector.
 *
 * Verified header (mixed quoting — some fields quoted, some bare, on the same row):
 *   "Booking Date","Value Date","Partner Name","Partner Iban",Type,
 *   "Payment Reference","Account Name","Amount (EUR)","Original Amount",
 *   "Original Currency","Exchange Rate"
 *
 * Rules (from the real export):
 *   - date = Booking Date. merchant_raw = Partner Name. note = Payment Reference
 *     (only when present and not "-").
 *   - Amount (EUR) is always EUR and signed -> this is amount_eur directly, so an
 *     N26 row never needs the FX rate table.
 *   - If Original Amount + Original Currency are present, amount_native takes the
 *     sign of Amount (EUR) and currency = Original Currency (e.g. TRY). Otherwise
 *     amount_native = Amount (EUR) and currency = EUR.
 *   - type mapping below; observed Types include Presentment, Direct Debit,
 *     Credit Transfer, Debit Transfer, MoneyBeam, Presentment Refund.
 *   - Internal-transfer hint: Type == "MoneyBeam", OR Partner Iban is one of your
 *     own IBANs, OR Partner Name matches one of your own names. The own names and
 *     IBANs come from data/profile.json (see ../identity.ts), never hardcoded.
 *
 * Partner Name may be non-Latin (e.g. Cyrillic "Отложение") and Value Date may be
 * blank — both are handled without special-casing because we key off Booking Date.
 */

import { parseCsv } from "../csv.ts";
import { isOwnIban, matchesOwnName } from "../identity.ts";
import type { ParsedRow, TxType } from "../types.ts";

const REQUIRED_HEADERS = [
  "Booking Date",
  "Partner Name",
  "Partner Iban",
  "Type",
  "Payment Reference",
  "Amount (EUR)",
  "Original Amount",
  "Original Currency",
] as const;

function mapType(n26Type: string): TxType {
  switch (n26Type) {
    case "Presentment":
    case "Direct Debit":
      return "spend";
    case "Presentment Refund":
      return "income";
    case "MoneyBeam":
      return "transfer";
    case "Credit Transfer":
    case "Debit Transfer":
      // Direction is decided downstream by sign + transfer pairing; "transfer"
      // is the neutral, correct classification for an account-to-account move.
      return "transfer";
    default:
      return "unknown";
  }
}

export function parseN26(text: string): ParsedRow[] {
  const { header, records } = parseCsv(text);
  for (const required of REQUIRED_HEADERS) {
    if (!header.includes(required)) {
      throw new Error(
        `parseN26: missing expected column "${required}". Header was: [${header.join(", ")}]`,
      );
    }
  }

  const rows: ParsedRow[] = [];

  for (const rec of records) {
    const date = rec.get("Booking Date").trim();
    if (date === "") continue; // no date -> cannot dedup; skip defensively

    const partnerName = rec.get("Partner Name").trim();
    const partnerIban = rec.get("Partner Iban").trim();
    const n26Type = rec.get("Type").trim();
    const reference = rec.get("Payment Reference").trim();
    const amountEurRaw = rec.get("Amount (EUR)").trim();
    const origAmountRaw = rec.get("Original Amount").trim();
    const origCurrencyRaw = rec.get("Original Currency").trim().toUpperCase();

    const amountEur = Number(amountEurRaw);
    if (!Number.isFinite(amountEur)) {
      throw new Error(
        `parseN26: non-numeric Amount (EUR) "${amountEurRaw}" for "${partnerName}" on ${date}`,
      );
    }

    let amount_native: number;
    let currency: string;
    if (origAmountRaw !== "" && origCurrencyRaw !== "") {
      const origMagnitude = Number(origAmountRaw);
      if (!Number.isFinite(origMagnitude)) {
        throw new Error(
          `parseN26: non-numeric Original Amount "${origAmountRaw}" for "${partnerName}" on ${date}`,
        );
      }
      // Original Amount is unsigned in the export; carry the sign from the EUR amount.
      const sign = amountEur < 0 ? -1 : 1;
      amount_native = sign * Math.abs(origMagnitude);
      currency = origCurrencyRaw;
    } else {
      amount_native = amountEur;
      currency = "EUR";
    }

    const note = reference !== "" && reference !== "-" ? reference : "";
    const type = mapType(n26Type);
    const transferCandidate =
      n26Type === "MoneyBeam" || isOwnIban(partnerIban) || matchesOwnName(partnerName);

    rows.push({
      date,
      merchant_raw: partnerName,
      amount_native,
      currency,
      type,
      fee: 0, // N26 export has no per-transaction fee column
      note,
      transferCandidate,
      // Amount (EUR) is authoritative EUR — pipeline uses it verbatim, no FX lookup.
      amountEur,
      // N26's export carries no running-balance column.
      balance: null,
    });
  }

  return rows;
}
