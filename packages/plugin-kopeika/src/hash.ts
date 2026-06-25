/**
 * Stable dedup id.
 *
 * id = sha256(data_source | account | date | merchant_raw | amount_native | currency)
 * truncated to the first 16 hex chars. The same logical transaction in the same
 * account must always produce the same id, so re-importing an overlapping export
 * is a no-op. amount_native is serialized with a fixed 2-decimal representation
 * so that 5 and 5.00 hash identically.
 *
 * `dedupExtra` is an optional finer-grained disambiguator (e.g. T-Bank's intraday
 * HH:MM:SS) appended only when a connector supplies one. A blank/absent value leaves
 * the payload byte-for-byte identical to the six-field form, so connectors that do
 * not set it keep their exact historical ids.
 */

import { createHash } from "node:crypto";

export function transactionId(input: {
  data_source: string;
  account: string;
  date: string;
  merchant_raw: string;
  amount_native: number;
  currency: string;
  dedupExtra?: string;
}): string {
  const amount = input.amount_native.toFixed(2);
  const fields = [
    input.data_source,
    input.account,
    input.date,
    input.merchant_raw,
    amount,
    input.currency,
  ];
  if (input.dedupExtra) fields.push(input.dedupExtra);
  return createHash("sha256").update(fields.join("|"), "utf8").digest("hex").slice(0, 16);
}
