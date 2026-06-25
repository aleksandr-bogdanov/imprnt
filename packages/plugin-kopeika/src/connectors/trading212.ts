/**
 * Trading212 connector.
 *
 * Verified header:
 *   Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,
 *   Currency (Price / share),Exchange rate,Result,Currency (Result),Total,
 *   Currency (Total),Withholding tax,Currency (Withholding tax),
 *   Currency conversion fee,Currency (Currency conversion fee)
 *
 * This is an investment account, not a spending account, so the mapping reflects
 * cashflow from the household's point of view:
 *   - Deposit / Withdrawal        -> transfer (cash moving between bank and broker;
 *                                     excluded from spend/income analytics)
 *   - Interest on cash / Dividend -> income
 *   - Market/Limit buy/sell       -> exchange (cash <-> shares inside the account;
 *                                     excluded — no money enters or leaves the household)
 *
 * amount = Total in `Currency (Total)`; merchant_raw = the security Name when a
 * trade, else the Action label (e.g. "Deposit"). date = the date part of Time.
 */

import { parseCsv } from "../csv.ts";
import type { ParsedRow, TxType } from "../types.ts";

const REQUIRED_HEADERS = ["Action", "Time", "Total", "Currency (Total)"] as const;

function mapAction(action: string): TxType {
  const a = action.toLowerCase();
  if (a === "deposit" || a === "withdrawal") return "transfer";
  if (a.includes("interest") || a.includes("dividend")) return "income";
  if (a.includes("buy") || a.includes("sell")) return "exchange";
  return "unknown";
}

export function parseTrading212(text: string): ParsedRow[] {
  const { header, records } = parseCsv(text);
  for (const required of REQUIRED_HEADERS) {
    if (!header.includes(required)) {
      throw new Error(
        `parseTrading212: missing expected column "${required}". Header was: [${header.join(", ")}]`,
      );
    }
  }

  const rows: ParsedRow[] = [];

  for (const rec of records) {
    const time = rec.get("Time").trim();
    if (time === "") continue; // no timestamp -> cannot date/dedup; skip defensively
    const date = time.slice(0, 10);

    const action = rec.get("Action").trim();
    const totalRaw = rec.get("Total").trim();
    if (totalRaw === "") continue; // non-monetary action (e.g. a pure share movement) -> skip

    const total = Number(totalRaw);
    if (!Number.isFinite(total)) {
      throw new Error(
        `parseTrading212: non-numeric Total "${totalRaw}" for action "${action}" on ${date}`,
      );
    }

    const currency = (rec.get("Currency (Total)").trim() || "EUR").toUpperCase();
    const name = rec.get("Name").trim();
    const notes = rec.get("Notes").trim();
    const type = mapAction(action);
    // Trading212 stamps every row with a unique transaction ID. Fold it into the
    // dedup key so several identical same-day rows never collapse into one — e.g.
    // three €50 withdrawals on the same day to three different destinations, which
    // share date/merchant/amount/currency and would otherwise hash to one id.
    const txnId = header.includes("ID") ? rec.get("ID").trim() : "";

    rows.push({
      date,
      merchant_raw: name !== "" ? name : action,
      amount_native: total,
      currency,
      type,
      fee: 0,
      note: notes !== "" ? notes : action,
      transferCandidate: type === "transfer",
      amountEur: currency === "EUR" ? total : null,
      // Trading212's transactions export has no portfolio-value / balance column;
      // the savings stock for this account is cost basis (cumulative deposits).
      balance: null,
      // Vendor ID disambiguates identical same-day rows in the dedup id.
      dedupExtra: txnId,
    });
  }

  return rows;
}
