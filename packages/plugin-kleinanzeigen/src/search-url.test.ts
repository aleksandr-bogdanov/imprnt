// The query slug is the whole request. A slug that mangles a German word builds a
// URL that answers 200 with zero listings, which is indistinguishable from a dry
// market and is why this went unnoticed on an entirely German board.
import { test, expect, describe } from "bun:test";
import { deumlaut, slugifyKeyword, searchUrl, DEFAULT_RADIUS_KM } from "./search.ts";

describe("deumlaut", () => {
  test("transliterates the German set the way KA's own slugs do", () => {
    expect(deumlaut("kühlschrank")).toBe("kuehlschrank");
    expect(deumlaut("empfänger")).toBe("empfaenger");
    expect(deumlaut("größe")).toBe("groesse");
    expect(deumlaut("öl")).toBe("oel");
  });

  test("strips other diacritics rather than hyphenating them", () => {
    expect(deumlaut("café")).toBe("cafe");
  });

  test("leaves plain ASCII untouched", () => {
    expect(deumlaut("sennheiser ew 300 iem g3")).toBe("sennheiser ew 300 iem g3");
  });
});

describe("slugifyKeyword", () => {
  test("an umlaut survives as its transliteration, never as a hyphen", () => {
    // The bug: "k-hlschrank", a live URL matching nothing.
    expect(slugifyKeyword("kühlschrank")).toBe("kuehlschrank");
    expect(slugifyKeyword("iem empfänger")).toBe("iem-empfaenger");
  });

  test("ß becomes ss", () => {
    expect(slugifyKeyword("straße")).toBe("strasse");
  });

  test("case, spaces and punctuation behave as before", () => {
    expect(slugifyKeyword("  RX 9070 XT  ")).toBe("rx-9070-xt");
    expect(slugifyKeyword("psm-1000!!")).toBe("psm-1000");
  });

  test("a keyword with nothing usable in it slugs to empty", () => {
    expect(slugifyKeyword("   ")).toBe("");
    expect(slugifyKeyword("!!!")).toBe("");
  });
});

describe("searchUrl", () => {
  test("carries the transliterated slug nationwide", () => {
    expect(searchUrl("iem empfänger", "")).toBe(
      "https://www.kleinanzeigen.de/s-iem-empfaenger/k0",
    );
  });

  test("carries it into a known location with its radius", () => {
    expect(searchUrl("kühlschrank", "berlin", 50)).toBe(
      "https://www.kleinanzeigen.de/s-berlin/kuehlschrank/k0l3331r50",
    );
  });

  test("an unusable keyword yields no URL at all", () => {
    expect(searchUrl("   ", "berlin")).toBeNull();
  });

  test("the default radius is applied, so a location scopes rather than sorts", () => {
    expect(searchUrl("psm 900", "berlin")).toContain(`r${DEFAULT_RADIUS_KM}`);
  });
});
