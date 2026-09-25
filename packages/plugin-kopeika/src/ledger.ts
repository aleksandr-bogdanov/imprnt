/**
 * Ledger persistence: load, serialize, append-with-dedup, and raw-file archival.
 *
 * The clean normalized ledger is data/ledger.csv (fixed column order from
 * LEDGER_COLUMNS). Immutable original exports are archived under
 * data/raw/<source>/ so the raw layer is preserved alongside the clean layer.
 * Dedup is by transaction id: an id already in the ledger is never re-appended.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { parseCsv, writeCsv } from "./csv.ts";
import {
  isOwner,
  isTaxSource,
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
    tx.tax_person,
    tx.tax_category,
    tx.tax_source,
    tx.time,
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
  // tax_* are v3 columns (the two-axis ledger). Same tolerance: an older ledger
  // reads them as "" — no person, no category, no source.
  const taxSourceRaw = get("tax_source").trim();
  if (!isTaxSource(taxSourceRaw)) {
    throw new Error(`ledger load: row ${rowNum}: invalid tax_source "${taxSourceRaw}"`);
  }

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
    tax_person: get("tax_person").trim(),
    tax_category: get("tax_category").trim(),
    tax_source: taxSourceRaw,
    // time is a v4 column; an older ledger reads it as "".
    time: get("time").trim(),
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
  /** Existing rows that had no time of day and gained one from the re-imported export. */
  healedTime: number;
  /** Candidates skipped because the bank renamed the merchant on a row already in the ledger. */
  renamed: { candidate: Transaction; existing: Transaction }[];
  merged: Transaction[];
}

/** Account, booking date, time of day, amount and currency: what a merchant rename leaves unchanged. */
function renameKey(t: Transaction): string {
  return `${t.account}|${t.date}|${t.time}|${t.amount_native.toFixed(2)}|${t.currency}`;
}

/**
 * Append candidate transactions, skipping any id already present (idempotent).
 * Existing rows are never re-valued: re-importing an overlapping file is a no-op,
 * except that a row imported before the ledger carried a time of day gains it
 * (the one field a re-import may fill, and only when it was empty).
 *
 * The id hashes the merchant text, and Revolut rewrites it between exports ("Steam"
 * becomes "Valve Corporation" on the same charge). A candidate with a new id is
 * therefore also checked against existing rows of the same account with the same
 * date, time of day, amount and currency but a different merchant. Such a row is
 * the same transaction renamed and is skipped and reported, never appended. An
 * existing row that an exact-id candidate of this batch already matched cannot be
 * claimed this way, and rows without a time of day are never compared.
 */
export function appendDeduped(
  existing: readonly Transaction[],
  candidates: readonly Transaction[],
): AppendResult {
  const seen = new Map(existing.map((t, i) => [t.id, i]));
  const merged = [...existing];
  let appended = 0;
  let skippedDuplicate = 0;
  let healedTime = 0;
  const renamed: AppendResult["renamed"] = [];

  const claimed = new Set(candidates.map((c) => c.id).filter((id) => seen.has(id)));
  const byRenameKey = new Map<string, Transaction[]>();
  for (const t of existing) {
    if (t.time === "" || claimed.has(t.id)) continue;
    const key = renameKey(t);
    byRenameKey.set(key, [...(byRenameKey.get(key) ?? []), t]);
  }

  for (const cand of candidates) {
    const at = seen.get(cand.id);
    if (at !== undefined) {
      skippedDuplicate += 1;
      if (merged[at]!.time === "" && cand.time !== "") {
        merged[at] = { ...merged[at]!, time: cand.time };
        healedTime += 1;
      }
      continue;
    }
    if (cand.time !== "") {
      const pool = byRenameKey.get(renameKey(cand)) ?? [];
      const hit = pool.findIndex((t) => t.merchant_raw !== cand.merchant_raw);
      if (hit !== -1) {
        renamed.push({ candidate: cand, existing: pool[hit]! });
        pool.splice(hit, 1);
        continue;
      }
    }
    seen.set(cand.id, merged.length);
    merged.push(cand);
    appended += 1;
  }

  return { appended, skippedDuplicate, healedTime, renamed, merged };
}

/**
 * Archive the original export under data/raw/<source>/, preserving the file
 * basename. Returns the stored basename for the ledger's source_file column.
 * raw/ is immutable: an existing archive is NEVER overwritten. Re-archiving
 * identical bytes is a harmless no-op; a same-named file with DIFFERENT bytes
 * (banks reuse fixed export filenames month after month) is filed under a
 * content-address-disambiguated name (<stem>-<hash8><ext>, the core snapshot
 * scheme), leaving the prior archive untouched.
 */
export function archiveRaw(dataDir: string, source: string, sourceFilePath: string): string {
  const destDir = join(dataDir, "raw", source);
  mkdirSync(destDir, { recursive: true });

  const srcBytes = readFileSync(sourceFilePath);
  let name = basename(sourceFilePath);
  if (existsSync(join(destDir, name)) && !srcBytes.equals(readFileSync(join(destDir, name)))) {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const hash8 = createHash("sha256").update(srcBytes).digest("hex").slice(0, 8);
    // hash8 is content-addressed, so re-archiving the same changed bytes lands on
    // the same name. If that name too holds different bytes (a hash8 collision),
    // step a numeric suffix until a free or identical slot is found.
    name = `${stem}-${hash8}${ext}`;
    let n = 2;
    while (existsSync(join(destDir, name)) && !srcBytes.equals(readFileSync(join(destDir, name)))) {
      name = `${stem}-${hash8}-${n}${ext}`;
      n += 1;
    }
  }

  const dest = join(destDir, name);
  if (!existsSync(dest)) writeFileSync(dest, srcBytes);
  return name;
}
