import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLedger,
  writeLedger,
  appendDeduped,
  archiveRaw,
} from "./ledger.ts";
import { tx } from "./test-helpers.ts";
import type { Transaction } from "./types.ts";

/** A scratch dir under os.tmpdir(), never the repo's data/. Caller cleans up. */
function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kopeika-ledger-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadLedger", () => {
  test("missing file -> empty array", () => {
    expect(loadLedger("/no/such/ledger.csv")).toEqual([]);
  });

  test("empty file -> empty array", () => {
    const { dir, cleanup } = scratch();
    try {
      const path = join(dir, "ledger.csv");
      writeFileSync(path, "", "utf8");
      expect(loadLedger(path)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("empty owner throws (owner is free-form but must be non-empty)", () => {
    const { dir, cleanup } = scratch();
    try {
      const path = join(dir, "ledger.csv");
      writeLedger(path, [tx()]);
      const text = readFileSync(path, "utf8").replace(",alex,", ",,");
      writeFileSync(path, text, "utf8");
      expect(() => loadLedger(path)).toThrow(/invalid owner/);
    } finally {
      cleanup();
    }
  });
});

describe("writeLedger + loadLedger round-trip", () => {
  test("a transaction survives save/load unchanged", () => {
    const { dir, cleanup } = scratch();
    try {
      const path = join(dir, "sub", "ledger.csv"); // parent dir auto-created
      const original: Transaction = tx({
        id: "abc123",
        date: "2025-01-15",
        merchant_raw: "OKTAN Brzeski, Grzenkowicz", // embedded comma forces quoting
        amount_native: -12.34,
        amount_eur: -12.34,
        category: "Groceries",
        note: 'has a "quote"',
      });
      writeLedger(path, [original]);
      expect(existsSync(path)).toBe(true);
      const [loaded] = loadLedger(path);
      expect(loaded).toEqual(original);
    } finally {
      cleanup();
    }
  });

  test("null amount_eur serializes to empty and round-trips back to null", () => {
    const { dir, cleanup } = scratch();
    try {
      const path = join(dir, "ledger.csv");
      const t = tx({ amount_eur: null, currency: "CZK", amount_native: -100 });
      writeLedger(path, [t]);
      const [loaded] = loadLedger(path);
      expect(loaded!.amount_eur).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("amounts are written with fixed 2 decimals", () => {
    const { dir, cleanup } = scratch();
    try {
      const path = join(dir, "ledger.csv");
      writeLedger(path, [tx({ amount_native: -5, amount_eur: -5, fee: 0 })]);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("-5.00");
      expect(text).toContain("0.00");
    } finally {
      cleanup();
    }
  });

  test("balance round-trips, and null balance serializes to empty -> null", () => {
    const { dir, cleanup } = scratch();
    try {
      const path = join(dir, "ledger.csv");
      writeLedger(path, [tx({ balance: 87.66 }), tx({ balance: null })]);
      const loaded = loadLedger(path);
      expect(loaded[0]!.balance).toBe(87.66);
      expect(loaded[1]!.balance).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("a pre-balance ledger (no balance column) still loads, balance -> null", () => {
    const { dir, cleanup } = scratch();
    try {
      const path = join(dir, "ledger.csv");
      // A legacy 16-column ledger written before the `balance` column existed.
      const legacy =
        "id,date,data_source,account,owner,merchant_raw,merchant_clean,amount_native,currency,amount_eur,category,type,is_transfer,transfer_group,fee,note,source_file\n" +
        "x1,2025-01-15,n26,n26-house,alex,REWE,REWE,-10.00,EUR,-10.00,Groceries,spend,false,,0.00,,export.csv\n";
      writeFileSync(path, legacy, "utf8");
      const loaded = loadLedger(path);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.balance).toBeNull();
      expect(loaded[0]!.merchant_raw).toBe("REWE");
    } finally {
      cleanup();
    }
  });

  test("is_transfer serializes as true/false and round-trips", () => {
    const { dir, cleanup } = scratch();
    try {
      const path = join(dir, "ledger.csv");
      writeLedger(path, [tx({ is_transfer: true, transfer_group: "tg_x" })]);
      const [loaded] = loadLedger(path);
      expect(loaded!.is_transfer).toBe(true);
      expect(loaded!.transfer_group).toBe("tg_x");
    } finally {
      cleanup();
    }
  });
});

describe("appendDeduped", () => {
  test("appends new ids, skips ids already present", () => {
    const existing: Transaction[] = [tx({ id: "a" }), tx({ id: "b" })];
    const candidates: Transaction[] = [tx({ id: "b" }), tx({ id: "c" })];
    const res = appendDeduped(existing, candidates);
    expect(res.appended).toBe(1);
    expect(res.skippedDuplicate).toBe(1);
    expect(res.merged.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  test("a duplicate WITHIN the candidate batch is also deduped", () => {
    const res = appendDeduped([], [tx({ id: "x" }), tx({ id: "x" })]);
    expect(res.appended).toBe(1);
    expect(res.skippedDuplicate).toBe(1);
  });

  test("existing rows are never mutated (re-import is a no-op)", () => {
    const existing: Transaction[] = [tx({ id: "a", category: "Original" })];
    const candidates: Transaction[] = [tx({ id: "a", category: "Changed" })];
    const res = appendDeduped(existing, candidates);
    expect(res.appended).toBe(0);
    expect(res.merged[0]!.category).toBe("Original"); // kept, not overwritten
  });

  test("idempotent: appending the same merged set again adds nothing", () => {
    const existing: Transaction[] = [tx({ id: "a" })];
    const candidates: Transaction[] = [tx({ id: "b" })];
    const once = appendDeduped(existing, candidates);
    const twice = appendDeduped(once.merged, candidates);
    expect(twice.appended).toBe(0);
    expect(twice.merged).toHaveLength(2);
  });
});

describe("archiveRaw", () => {
  test("copies a source file under data/raw/<source>/ and returns its basename", () => {
    const { dir, cleanup } = scratch();
    try {
      const srcPath = join(dir, "export.csv");
      writeFileSync(srcPath, "header\n1\n", "utf8");
      const dataDir = join(dir, "data");
      const name = archiveRaw(dataDir, "revolut", srcPath);
      expect(name).toBe("export.csv");
      const dest = join(dataDir, "raw", "revolut", "export.csv");
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe("header\n1\n");
    } finally {
      cleanup();
    }
  });

  test("re-archiving the same file is harmless (overwrites identically)", () => {
    const { dir, cleanup } = scratch();
    try {
      const srcPath = join(dir, "export.csv");
      writeFileSync(srcPath, "data\n", "utf8");
      const dataDir = join(dir, "data");
      archiveRaw(dataDir, "n26", srcPath);
      const name = archiveRaw(dataDir, "n26", srcPath);
      expect(name).toBe("export.csv");
      expect(readFileSync(join(dataDir, "raw", "n26", "export.csv"), "utf8")).toBe("data\n");
    } finally {
      cleanup();
    }
  });
});
