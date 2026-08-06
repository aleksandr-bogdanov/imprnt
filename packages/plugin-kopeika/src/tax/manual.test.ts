import { describe, expect, test } from "bun:test";
import { transactionId } from "../hash.ts";

/**
 * The `manual` verb's identity contract. The command itself lives in cli.ts
 * (it writes the ledger and pins.json), so what is pinned here is the property
 * everything else rests on: the id is derived from content, which is what
 * makes re-running the same entry a dedup no-op instead of a duplicate row.
 */
describe("manual entry identity", () => {
  const base = {
    data_source: "manual",
    account: "manual-erika",
    date: "2026-05-13",
    merchant_raw: "Private seller - office chair",
    amount_native: -300,
    currency: "EUR",
  };

  test("the same entry always derives the same id", () => {
    expect(transactionId(base)).toBe(transactionId({ ...base }));
  });

  test("a different amount, date or merchant is a different row", () => {
    expect(transactionId({ ...base, amount_native: -301 })).not.toBe(transactionId(base));
    expect(transactionId({ ...base, date: "2026-05-14" })).not.toBe(transactionId(base));
    expect(transactionId({ ...base, merchant_raw: "Someone else" })).not.toBe(transactionId(base));
  });

  test("a manual row never collides with an imported row of the same values", () => {
    expect(transactionId({ ...base, data_source: "norman-dump" })).not.toBe(transactionId(base));
  });
});
