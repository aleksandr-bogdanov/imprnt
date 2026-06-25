import { describe, expect, test } from "bun:test";
import { transactionId } from "./hash.ts";

const base = {
  data_source: "n26",
  account: "n26-eur",
  date: "2025-01-15",
  merchant_raw: "REWE Berlin",
  amount_native: -12.34,
  currency: "EUR",
};

describe("transactionId", () => {
  test("is deterministic: same input -> same id", () => {
    expect(transactionId(base)).toBe(transactionId({ ...base }));
  });

  test("returns 16 lowercase hex chars", () => {
    const id = transactionId(base);
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("5 and 5.00 hash identically (fixed 2-decimal serialization)", () => {
    const a = transactionId({ ...base, amount_native: 5 });
    const b = transactionId({ ...base, amount_native: 5.0 });
    expect(a).toBe(b);
  });

  test("changing data_source changes the id", () => {
    expect(transactionId({ ...base, data_source: "revolut" })).not.toBe(transactionId(base));
  });

  test("changing account changes the id", () => {
    expect(transactionId({ ...base, account: "n26-joint" })).not.toBe(transactionId(base));
  });

  test("changing date changes the id", () => {
    expect(transactionId({ ...base, date: "2025-01-16" })).not.toBe(transactionId(base));
  });

  test("changing merchant_raw changes the id", () => {
    expect(transactionId({ ...base, merchant_raw: "ALDI" })).not.toBe(transactionId(base));
  });

  test("changing amount_native changes the id", () => {
    expect(transactionId({ ...base, amount_native: -12.35 })).not.toBe(transactionId(base));
  });

  test("changing currency changes the id", () => {
    expect(transactionId({ ...base, currency: "USD" })).not.toBe(transactionId(base));
  });

  test("sign of the amount is part of the id", () => {
    expect(transactionId({ ...base, amount_native: 12.34 })).not.toBe(
      transactionId({ ...base, amount_native: -12.34 }),
    );
  });

  test("dedupExtra absent or empty leaves the id unchanged (back-compat)", () => {
    expect(transactionId({ ...base, dedupExtra: undefined })).toBe(transactionId(base));
    expect(transactionId({ ...base, dedupExtra: "" })).toBe(transactionId(base));
  });

  test("a dedupExtra value changes the id, and distinct values differ", () => {
    const withExtra = transactionId({ ...base, dedupExtra: "16:12:04" });
    expect(withExtra).not.toBe(transactionId(base));
    expect(withExtra).not.toBe(transactionId({ ...base, dedupExtra: "16:01:22" }));
  });

  test("known exact value (regression lock on payload format)", () => {
    // sha256("n26|n26-eur|2025-01-15|REWE Berlin|-12.34|EUR")[:16].
    // Locks the documented payload join order + 2-decimal amount serialization,
    // so any silent change to how the id is built fails here.
    expect(transactionId(base)).toBe("b14a5e8c77064072");
  });
});
