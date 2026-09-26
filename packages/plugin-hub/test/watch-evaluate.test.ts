// The one evaluator: every listing into drop, notify or triage, and a drop can
// only ever carry a rule the spec stated. (SPEC section 5)
//
// Each hard rule in enum order with its margin, the seen row's two cases and
// the three re-entries, the predicate on both lanes, and the invariant that
// the function refuses to return any other drop word.

import { expect, test } from "bun:test";
import {
  DROP_RULES, evaluate, fallReenters, isRentalAd, isWantedAd, matchedExclude,
  type Listing, type ListingState, type WatchSpec,
} from "../src/watch/evaluate.ts";

const ad = (over: Partial<Listing> = {}): Listing => ({
  id: "900001", source: "kleinanzeigen", spec: "de__ddr5", kind: "ad", price: 200,
  title: "Kingston Fury Beast DDR5 6000 32GB", seller_text: "", url: "https://www.kleinanzeigen.de/s-anzeige/x/900001",
  ...over,
});

const digest = (over: Partial<WatchSpec> = {}): WatchSpec => ({
  id: "de__ddr5", source: "kleinanzeigen", owner: "p1-lair", lane: "digest",
  target: { query: "ddr5" }, hard: {}, notify: { price_at_or_under: 260 }, ...over,
});
const tripwire = (over: Partial<WatchSpec> = {}): WatchSpec => digest({ lane: "tripwire", ...over });

const seen = (over: Partial<ListingState> = {}): ListingState => ({
  spec: "de__ddr5", first_seen: "2026-09-26T07:00:00.000Z", last_seen: "2026-09-26T07:00:00.000Z",
  price: 200, announced_price: 200, announced_at: "2026-09-26T07:00:00.000Z", outcome: "notify", reason: "price_at_or_under", ...over,
});

test("each hard rule drops with its name and the number it lost by, in enum order, and a missing fact passes the rule", () => {
  expect(evaluate(ad({ price: 319 }), digest({ hard: { max_price: 260 } }), null)).toEqual({ bin: "drop", rule: "max_price", margin: 59, value: "max 260" });
  expect(evaluate(ad({ price: 10 }), digest({ hard: { min_price: 50 } }), null)).toEqual({ bin: "drop", rule: "min_price", margin: -40, value: "min 50" });
  expect(evaluate(ad({ distance_km: 500 }), digest({ hard: { radius_km: 50 } }), null)).toEqual({ bin: "drop", rule: "radius_km", margin: 450, value: "radius 50 km" });
  expect(evaluate(ad({ title: "Gaming Laptop 32GB DDR5" }), digest({ hard: { exclude: ["laptop"] } }), null)).toEqual({ bin: "drop", rule: "exclude", value: "laptop" });
  expect(evaluate(ad({ seller_kind: "commercial" }), digest({ hard: { seller_kind: "private" } }), null)).toEqual({ bin: "drop", rule: "seller_kind", value: "commercial" });
  expect(evaluate(ad({ temperature: 30 }), digest({ hard: { min_temperature: 100 } }), null)).toEqual({ bin: "drop", rule: "min_temperature", margin: -70, value: "min 100" });
  expect(evaluate(ad({ title: "Suche DDR5 6000 Kit" }), digest({ hard: { wanted_ad: false } }), null)).toEqual({ bin: "drop", rule: "wanted_ad", value: "wanted ad" });
  expect(evaluate(ad({ title: "DDR5 Kit zu vermieten" }), digest({ hard: { rental_ad: false } }), null)).toEqual({ bin: "drop", rule: "rental_ad", value: "rental ad" });
  // Enum order: the price ceiling is named before the exclude term.
  expect(evaluate(ad({ price: 999, title: "Laptop" }), digest({ hard: { exclude: ["laptop"], max_price: 260 } }), null)).toMatchObject({ rule: "max_price" });
  // A listing that lacks the fact passes the RULE: no price is not a price
  // over the ceiling. The numbered predicate then fails it, because unknown is
  // not at or under 260, and on a digest that is a look.
  expect(evaluate(ad({ price: null }), digest({ hard: { max_price: 260 } }), null)).toEqual({ bin: "triage", reason: "no-target", entry: "new", from: undefined, rule: "price_at_or_under" });
  expect(evaluate(ad({ price: null }), digest({ hard: { max_price: 260, radius_km: 5, seller_kind: "private", min_temperature: 100 }, notify: { price_at_or_under: null } }), null)).toMatchObject({ bin: "notify" });
  // `true` on the two ad flags means the rule is off.
  expect(evaluate(ad({ title: "Suche DDR5" }), digest({ hard: { wanted_ad: true, rental_ad: true } }), null)).toMatchObject({ bin: "notify" });
  // A null value is an absent rule.
  expect(evaluate(ad({ price: 999 }), digest({ hard: { max_price: null as unknown as number } }), null)).toMatchObject({ bin: "triage", reason: "no-target" });
});

test("the ported word rules: exclude at a word start with the trailing-space whole-word form, wanted ads anchored, rentals with the ex-rental exception", () => {
  expect(matchedExclude("HECO PSM 1000", ["heco"])).toBe("heco");
  expect(matchedExclude("Echeco speaker", ["heco"])).toBeNull();
  expect(matchedExclude("PCIe riser", ["pc "])).toBeNull();
  expect(matchedExclude("Gaming PC", ["pc "])).toBe("pc");
  expect(matchedExclude("PC-Gehaeuse", ["pc"])).toBe("pc");
  expect(matchedExclude("a (b) c", ["(b)"])).toBe("(b)");
  expect(matchedExclude("anything", ["", "  "])).toBeNull();
  expect(matchedExclude("anything", undefined)).toBeNull();
  expect(isWantedAd("Suche DDR5")).toBe(true);
  expect(isWantedAd("  gesucht: Kit")).toBe(true);
  expect(isWantedAd("WTB ram")).toBe(true);
  expect(isWantedAd("Sucher Canon EOS")).toBe(false);
  expect(isWantedAd("Verkaufe, suche nichts")).toBe(false);
  expect(isRentalAd("Beamer zu vermieten")).toBe(true);
  expect(isRentalAd("Verleih Partyzelt")).toBe(true);
  expect(isRentalAd("Leihgeraet Bohrhammer")).toBe(true);
  expect(isRentalAd("Bohrhammer aus Vermietung")).toBe(false);
  expect(isRentalAd("ehemaliges Mietgeraet, verkaufe")).toBe(false);
  expect(isRentalAd("Miete-Kaufvertrag Muster")).toBe(true);
});

test("the seen row: announced at this price or lower is seen, a fall of five percent or a fall across the line re-enters, declined at the same numbers is seen", () => {
  expect(fallReenters(200, 200, 260)).toBe(false);
  expect(fallReenters(200, 195, 260)).toBe(false);
  expect(fallReenters(200, 190, 260)).toBe(true);
  expect(fallReenters(270, 259, 260)).toBe(true);
  expect(fallReenters(270, 261, 260)).toBe(false);
  expect(fallReenters(200, 210, 260)).toBe(false);
  expect(fallReenters(null, 100, 260)).toBe(true);
  expect(fallReenters(200, null, 260)).toBe(false);

  expect(evaluate(ad({ price: 200 }), digest(), seen())).toEqual({ bin: "drop", rule: "seen", margin: 0, value: "announced before" });
  expect(evaluate(ad({ price: 195 }), digest(), seen())).toEqual({ bin: "drop", rule: "seen", margin: -5, value: "announced before" });
  expect(evaluate(ad({ price: 220 }), digest(), seen())).toEqual({ bin: "drop", rule: "seen", margin: 20, value: "announced before" });
  expect(evaluate(ad({ price: null }), digest(), seen())).toEqual({ bin: "drop", rule: "seen", value: "announced before" });
  // A fall of five percent, under the line: a notify carrying the old price.
  expect(evaluate(ad({ price: 190 }), digest(), seen())).toEqual({ bin: "notify", entry: "price-changed", from: 200 });
  // Told 270 on a digest, the line is 260, 259 is the event however small the step.
  expect(evaluate(ad({ price: 259 }), digest(), seen({ announced_price: 270, price: 270 }))).toEqual({ bin: "notify", entry: "price-changed", from: 270 });
  // A fall of five percent that stays over the line is a triage `price changed` on a digest, carrying old and new.
  expect(evaluate(ad({ price: 280 }), digest(), seen({ announced_price: 300, price: 300 }))).toEqual({
    bin: "triage", reason: "price changed", entry: "price-changed", from: 300, rule: "price_at_or_under", margin: 20,
  });
  // And on a tripwire the predicate decides afresh: a drop with the predicate's own name.
  expect(evaluate(ad({ price: 280 }), tripwire(), seen({ announced_price: 300, price: 300 }))).toEqual({
    bin: "drop", rule: "price_at_or_under", margin: 20, value: "price_at_or_under 260",
  });
  // Declined before (never announced): the same numbers again is seen, any other price is evaluated afresh.
  const declined = seen({ announced_at: null, announced_price: null, price: 300, outcome: "triage", reason: "no-target", verdict: "ignore" });
  expect(evaluate(ad({ price: 300 }), digest(), declined)).toEqual({ bin: "drop", rule: "seen", value: "declined before, unchanged" });
  expect(evaluate(ad({ price: 310 }), digest(), declined)).toEqual({
    bin: "triage", reason: "price changed", entry: "price-changed", from: 300, rule: "price_at_or_under", margin: 50,
  });
  expect(evaluate(ad({ price: 250 }), digest(), declined)).toEqual({ bin: "notify", entry: "price-changed", from: 300 });
  expect(evaluate(ad({ price: null }), digest(), seen({ announced_at: null, announced_price: null, price: null }))).toEqual({ bin: "drop", rule: "seen", value: "declined before, unchanged" });
  // The hard rules come first, seen or not.
  expect(evaluate(ad({ price: 500 }), digest({ hard: { max_price: 260 } }), seen())).toMatchObject({ rule: "max_price" });
});

test("the notify predicate: true is notify, false on a tripwire drops with its own name, false or absent on a digest is triage no-target", () => {
  expect(evaluate(ad({ price: 260 }), tripwire(), null)).toEqual({ bin: "notify", entry: "new", from: undefined });
  expect(evaluate(ad({ price: 282.98 }), tripwire(), null)).toEqual({ bin: "drop", rule: "price_at_or_under", margin: 22.98, value: "price_at_or_under 260" });
  expect(evaluate(ad({ price: 282.98 }), digest(), null)).toEqual({ bin: "triage", reason: "no-target", entry: "new", from: undefined, rule: "price_at_or_under", margin: 22.98 });
  // No ceiling: the match itself is the signal.
  expect(evaluate(ad({ price: 9999 }), tripwire({ notify: { price_at_or_under: null } }), null)).toMatchObject({ bin: "notify" });
  expect(evaluate(ad({ price: null }), tripwire({ notify: { price_at_or_under: null } }), null)).toMatchObject({ bin: "notify" });
  // A price the page did not give fails a numbered predicate: unknown is not at or under.
  expect(evaluate(ad({ price: null }), tripwire({ hard: {} }), null)).toEqual({ bin: "drop", rule: "price_at_or_under", value: "price_at_or_under 260" });
  // The record low.
  const product = ad({ kind: "product", record_low: true, price: 349 });
  expect(evaluate(product, tripwire({ hard: {}, notify: { price_record_low: true } }), null)).toMatchObject({ bin: "notify" });
  expect(evaluate({ ...product, record_low: false }, tripwire({ hard: {}, notify: { price_record_low: true } }), null)).toEqual({ bin: "drop", rule: "price_record_low", value: "price_record_low true" });
  expect(evaluate({ ...product, record_low: false }, digest({ hard: {}, notify: { price_record_low: true } }), null)).toEqual({ bin: "triage", reason: "no-target", entry: "new", from: undefined, rule: "price_record_low" });
  // Both predicates: the first that fails names the drop.
  expect(evaluate({ ...product, price: 500, record_low: true }, tripwire({ hard: {}, notify: { price_at_or_under: 400, price_record_low: true } }), null)).toMatchObject({ rule: "price_at_or_under" });
  // No notify block on a digest is a look, never a drop.
  expect(evaluate(ad(), digest({ notify: undefined }), null)).toEqual({ bin: "triage", reason: "no-target", entry: "new", from: undefined });
});

test("a drop can only ever carry a hard rule, seen, or a notify predicate", () => {
  expect([...DROP_RULES].sort()).toEqual([
    "exclude", "max_price", "min_price", "min_temperature", "price_at_or_under", "price_record_low", "radius_km", "rental_ad", "seen", "seller_kind", "wanted_ad",
  ]);
  for (const word of ["scam", "no-target", "odd", "quarantine.raw", "min_events", "price changed", ""]) expect(DROP_RULES.has(word)).toBe(false);
});
