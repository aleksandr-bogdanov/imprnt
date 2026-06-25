/**
 * Ledger persistence: load, serialize, append-with-dedup, and raw-file archival.
 *
 * The clean normalized ledger is data/ledger.csv (fixed column order from
 * LEDGER_COLUMNS). Immutable original exports are archived under
 * data/raw/<source>/ so the raw layer is preserved alongside the clean layer.
 * Dedup is by transaction id: an id already in the ledger is never re-appended.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseCsv, writeCsv } from "./csv.ts";
import {
  isOwner,
  isTxType,
  LEDGER_COLUMNS,
  type Transaction,
} from "./types.ts";

/** Serialize one transaction to a string array aligned to LEDGER_COLUMNS. */
function txToRow(tx: Transaction): string[] {
  return [
    tx.id,
    tx.date,
    tx.data_source,
    tx.account,
    tx.owner,
    tx.merchant_raw,
    tx.merchant_clean,
    formatAmount(tx.amount_native),
    tx.currency,
    tx.amount_eur === null ? "" : formatAmount(tx.amount_eur),
    tx.category,
    tx.type,
    tx.is_transfer ? "true" : "false",
    tx.transfer_group,
    formatAmount(tx.fee),
    tx.note,
    tx.source_file,
    tx.balance === null ? "" : formatAmount(tx.balance),
  ];
}

/** Fixed 2-decimal money formatting so amounts round-trip stably (5 -> "5.00"). */
function formatAmount(n: number): string {
  return n.toFixed(2);
}

function parseAmount(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`ledger load: non-numeric ${label} "${raw}"`);
  }
  return n;
}

/** Deserialize one ledger CSV record back into a Transaction. */
function rowToTx(get: (col: string) => string, rowNum: number): Transaction {
  const owner = get("owner").trim();
  if (!isOwner(owner)) {
    throw new Error(`ledger load: row ${rowNum}: invalid owner "${owner}"`);
  }
  const type = get("type").trim();
  if (!isTxType(type)) {
    throw new Error(`ledger load: row ${rowNum}: invalid type "${type}"`);
  }
  const eurRaw = get("amount_eur").trim();
  const isTransferRaw = get("is_transfer").trim();
  // balance is a v2 column. A ledger written before it existed has no such field;
  // the header-tolerant getter returns "" there, which reads back as null.
  const balanceRaw = get("balance").trim();

  return {
    id: get("id").trim(),
    date: get("date").trim(),
    data_source: get("data_source").trim(),
    account: get("account").trim(),
    owner,
    merchant_raw: get("merchant_raw"),
    merchant_clean: get("merchant_clean"),
    amount_native: parseAmount(get("amount_native"), "amount_native"),
    currency: get("currency").trim(),
    amount_eur: eurRaw === "" ? null : parseAmount(eurRaw, "amount_eur"),
    category: get("category"),
    type,
    is_transfer: isTransferRaw === "true",
    transfer_group: get("transfer_group").trim(),
    fee: parseAmount(get("fee"), "fee"),
    note: get("note"),
    source_file: get("source_file"),
    balance: balanceRaw === "" ? null : parseAmount(balanceRaw, "balance"),
  };
}

/** Load the full ledger. A missing file yields an empty array. */
export function loadLedger(path: string): Transaction[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return [];
  const { header, records } = parseCsv(text);
  // Tolerate columns the on-disk file predates (e.g. `balance`, added in v2): an
  // absent column reads as "" rather than throwing, so an older ledger still loads
  // and gains the new field as null until the next writeLedger rewrites the file.
  const present = new Set(header);
  return records.map((rec, i) =>
    rowToTx((c) => (present.has(c) ? rec.get(c) : ""), i + 2),
  );
}

/** Write the full ledger to disk, creating the parent directory if needed. */
export function writeLedger(path: string, txs: readonly Transaction[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const rows = txs.map(txToRow);
  writeFileSync(path, writeCsv(LEDGER_COLUMNS, rows), "utf8");
}

export interface AppendResult {
  appended: number;
  skippedDuplicate: number;
  merged: Transaction[];
}

/**
 * Append candidate transactions, skipping any id already present (idempotent).
 * Existing rows are never mutated — re-importing an overlapping file is a no-op.
 */
export function appendDeduped(
  existing: readonly Transaction[],
  candidates: readonly Transaction[],
): AppendResult {
  const seen = new Set(existing.map((t) => t.id));
  const merged = [...existing];
  let appended = 0;
  let skippedDuplicate = 0;

  for (const cand of candidates) {
    if (seen.has(cand.id)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(cand.id);
    merged.push(cand);
    appended += 1;
  }

  return { appended, skippedDuplicate, merged };
}

/**
 * Archive the original export under data/raw/<source>/, preserving the file
 * basename. Returns the stored basename for the ledger's source_file column.
 * Idempotent at the byte level: copying the same file again overwrites with an
 * identical copy, so re-archiving is harmless.
 */
export function archiveRaw(dataDir: string, source: string, sourceFilePath: string): string {
  const name = basename(sourceFilePath);
  const destDir = join(dataDir, "raw", source);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(sourceFilePath, join(destDir, name));
  return name;
}
