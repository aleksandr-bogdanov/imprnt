import { test, expect } from "bun:test";
import { parseFacts } from "./facts.ts";

test("parses scalars, a block list, numbers, and empty fields", () => {
  const f = parseFacts(`
listing: 9000000001
model: Acme BT-200 Bluetooth-Lautsprecher
artikelnummer:
includes:
  - Netzteil
  - Anleitung
price: 95
floor: 80
pickup_area: Musterstadt
`);
  expect(f.listing).toBe("9000000001");
  expect(f.model).toBe("Acme BT-200 Bluetooth-Lautsprecher");
  expect(f.artikelnummer).toBe(""); // empty stays empty (becomes needs_fact downstream)
  expect(f.includes).toEqual(["Netzteil", "Anleitung"]);
  expect(f.price).toBe(95);
  expect(f.floor).toBe(80);
  expect(f.pickup_area).toBe("Musterstadt");
});

test("inline list form [a, b] parses too", () => {
  const f = parseFacts(`includes: [Netzteil, Ladekabel, Anleitung]`);
  expect(f.includes).toEqual(["Netzteil", "Ladekabel", "Anleitung"]);
});

test("trailing comments are stripped, a bad number stays null (never NaN)", () => {
  const f = parseFacts(`price: 95   # VB\nfloor: notanumber`);
  expect(f.price).toBe(95);
  expect(f.floor).toBeNull();
});

test("unknown keys are ignored (forward-compatible)", () => {
  const f = parseFacts(`model: X\nfuture_field: whatever`);
  expect(f.model).toBe("X");
});
