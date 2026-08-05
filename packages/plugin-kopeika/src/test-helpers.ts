/**
 * Test-only helpers. SYNTHETIC data only, never reads anything under data/.
 *
 * `tx()` builds a fully-formed Transaction from a small partial override so each
 * test only states the fields it cares about. `tmpCsv()` writes a hand-written
 * CSV string to a unique temp file (os.tmpdir, never data/) for the path-taking
 * loaders (fx, rules, tiers, ledger) and returns the path; the caller cleans up.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transaction, Owner, TxType } from "./types.ts";

let counter = 0;

/** Build a synthetic Transaction; pass only the fields under test. */
export function tx(overrides: Partial<Transaction> = {}): Transaction {
  counter += 1;
  const base: Transaction = {
    id: `id${counter}`,
    date: "2025-01-15",
    data_source: "n26",
    account: "n26-eur",
    owner: "alex" as Owner,
    merchant_raw: "Some Merchant",
    merchant_clean: "",
    amount_native: -10,
    currency: "EUR",
    amount_eur: -10,
    category: "",
    type: "spend" as TxType,
    is_transfer: false,
    transfer_group: "",
    fee: 0,
    note: "",
    source_file: "export.csv",
    balance: null,
    tax_person: "",
    tax_category: "",
    tax_source: "",
  };
  return { ...base, ...overrides };
}

/**
 * Write `content` to a unique temp file with the given basename and return its
 * absolute path. Lives under os.tmpdir(), never under the repo's data/.
 */
export function tmpCsv(basename: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kopeika-test-"));
  const path = join(dir, basename);
  writeFileSync(path, content, "utf8");
  return path;
}

/** Remove a temp file's parent dir created by tmpCsv. */
export function cleanupTmp(path: string): void {
  try {
    rmSync(join(path, ".."), { recursive: true, force: true });
  } catch {
    // best-effort cleanup in a test; ignore
  }
}
