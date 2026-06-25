/**
 * Core domain types for kopeika.
 *
 * A Transaction is the single normalized unit. Connectors produce partial rows
 * (without id / amount_eur / category / transfer grouping); the import pipeline
 * fills the derived fields. The on-disk ledger.csv column order is fixed by
 * LEDGER_COLUMNS below — connectors never write CSV directly.
 */

export const TX_TYPES = [
  "spend",
  "income",
  "transfer",
  "fee",
  "exchange",
  "unknown",
] as const;

export type TxType = (typeof TX_TYPES)[number];

export function isTxType(value: string): value is TxType {
  return (TX_TYPES as readonly string[]).includes(value);
}

/**
 * Owner is a free-form label for whose money a row is ("alex", "anna", "joint",
 * whatever you use). The valid set is your choice, declared in data/profile.json,
 * so no person's name is baked into the code. The type stays a plain string.
 */
export type Owner = string;

/** A loaded ledger row's owner just has to be non-empty. The CLI checks the
 *  import-time owner against your configured set; see the import command. */
export function isOwner(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * One normalized ledger row.
 *
 * - amount_native: signed in the transaction's own currency (negative = outflow).
 * - amount_eur: signed EUR value. Empty string (serialized) when no FX rate was
 *   available — kopeika never guesses a rate.
 * - is_transfer / transfer_group: a candidate hint may be set by a connector,
 *   but the authoritative pairing is done by the `transfers` command.
 */
export interface Transaction {
  id: string;
  date: string; // ISO YYYY-MM-DD
  data_source: string; // "revolut" | "n26" | future connectors
  account: string; // CLI-supplied account label, e.g. "revolut-eur"
  owner: Owner;
  merchant_raw: string;
  merchant_clean: string;
  amount_native: number;
  currency: string; // ISO 4217, e.g. "EUR", "CZK"
  amount_eur: number | null; // null when no rate available
  category: string; // "" when uncategorized
  type: TxType;
  is_transfer: boolean;
  transfer_group: string; // "" when not part of a matched transfer pair
  fee: number;
  note: string;
  source_file: string; // basename of the archived raw export
  /**
   * Running account balance after this row, in the row's own currency, when the
   * export carries it (Revolut does; N26 and Trading212 do not). null when the
   * source has no balance column. This is the stock layer: a balance is a
   * point-in-time level, distinct from the signed flow in amount_native.
   */
  balance: number | null;
}

/**
 * What a connector returns: everything it can know from the raw row, minus the
 * fields the pipeline derives (id, amount_eur, category, transfer grouping).
 * `currencyIsEur` lets a connector signal "amount_native is already EUR, skip FX".
 */
export interface ParsedRow {
  date: string;
  merchant_raw: string;
  amount_native: number;
  currency: string;
  type: TxType;
  fee: number;
  note: string;
  /** Connector-level hint that this row looks like an internal transfer. */
  transferCandidate: boolean;
  /** When true, amount_eur = amount_native directly (source already in EUR). */
  amountEur: number | null;
  /** Running balance after this row in the row's currency, or null if the export omits it. */
  balance: number | null;
  /**
   * Optional finer-grained dedup disambiguator folded into the row's id. The id is
   * otherwise (data_source|account|date|merchant_raw|amount_native|currency), which
   * collapses two genuinely distinct same-day rows that share a merchant and amount
   * (common in dense exports: two identical taxi fares, two equal P2P transfers).
   * A connector with a finer signal — T-Bank's intraday HH:MM:SS — passes it here to
   * keep both rows. Omitted by connectors without one, leaving their ids unchanged.
   */
  dedupExtra?: string;
}

/**
 * Fixed ledger.csv column order. The CSV reader/writer and every consumer key
 * off this single source of truth.
 */
export const LEDGER_COLUMNS = [
  "id",
  "date",
  "data_source",
  "account",
  "owner",
  "merchant_raw",
  "merchant_clean",
  "amount_native",
  "currency",
  "amount_eur",
  "category",
  "type",
  "is_transfer",
  "transfer_group",
  "fee",
  "note",
  "source_file",
  "balance",
] as const;

export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];
