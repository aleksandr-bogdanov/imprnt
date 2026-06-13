import { test, expect } from "bun:test";
import { parseFacts } from "./facts.ts";

test("parses scalars, a block list, numbers, and empty fields", () => {
  const f = parseFacts(`
listing: 3432924231
model: FRITZ!Box 6660 Cable
artikelnummer:
includes:
  - Netzteil
  - Anleitung
price: 90
floor: 75
pickup_area: Berlin
`);
  expect(f.listing).toBe("3432924231");
  expect(f.model).toBe("FRITZ!Box 6660 Cable");
  expect(f.artikelnummer).toBe(""); // empty stays empty (becomes needs_fact downstream)
  expect(f.includes).toEqual(["Netzteil", "Anleitung"]);
  expect(f.price).toBe(90);
  expect(f.floor).toBe(75);
  expect(f.pickup_area).toBe("Berlin");
});

test("inline list form [a, b] parses too", () => {
  const f = parseFacts(`includes: [Netzteil, DSL-Kabel, Anleitung]`);
  expect(f.includes).toEqual(["Netzteil", "DSL-Kabel", "Anleitung"]);
});

test("trailing comments are stripped, a bad number stays null (never NaN)", () => {
  const f = parseFacts(`price: 90   # VB\nfloor: notanumber`);
  expect(f.price).toBe(90);
  expect(f.floor).toBeNull();
});

test("unknown keys are ignored (forward-compatible)", () => {
  const f = parseFacts(`model: X\nfuture_field: whatever`);
  expect(f.model).toBe("X");
});
