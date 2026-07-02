import { test, expect, describe } from "bun:test";
import { diffSnapshots, filterDiffByBand, inBand, type SnapshotDiff } from "./watch.ts";
import { isResultsPage, parseSearchHtml, type SnapshotListing } from "./search.ts";

function L(adId: string, priceNum: number | null): SnapshotListing {
  return {
    adId, title: `listing ${adId}`,
    price: priceNum != null ? `${priceNum} €` : "",
    priceNum, location: "Berlin", date: "Heute", url: `https://x/${adId}`,
    shipping: false, gewerblich: false,
  };
}

describe("diffSnapshots — added / price-drop / gone, by adId", () => {
  const prev = { listings: [L("a", 100), L("b", 200), L("c", null)] };
  const next = { listings: [L("a", 80), L("b", 200), L("d", 50)] };
  const diff = diffSnapshots(prev, next);

  test("a present-in-next-only ad is `added`", () => {
    expect(diff.added.map((l) => l.adId)).toEqual(["d"]);
  });
  test("a cheaper ad is a `dropped` carrying the old price", () => {
    expect(diff.dropped).toHaveLength(1);
    expect(diff.dropped[0].adId).toBe("a");
    expect(diff.dropped[0].oldPriceNum).toBe(100);
    expect(diff.dropped[0].priceNum).toBe(80);
  });
  test("an equal price is not a drop, and a present-in-prev-only ad is `gone`", () => {
    expect(diff.dropped.map((l) => l.adId)).not.toContain("b");
    expect(diff.gone.map((l) => l.adId)).toEqual(["c"]);
  });
  test("a null price on either side never counts as a drop (no false signal)", () => {
    const d = diffSnapshots({ listings: [L("x", null)] }, { listings: [L("x", null)] });
    expect(d.dropped).toHaveLength(0);
  });
  test("an empty/absent prev makes everything added (first-run shape)", () => {
    const d = diffSnapshots(null, next);
    expect(d.added).toHaveLength(3);
    expect(d.gone).toHaveLength(0);
  });

  test("an EMPTY prev snapshot is a baseline, not a first run: the first appearance is `added`", () => {
    // The rare-item watch: the query starts at 0 listings (a valid snapshot), then the item shows up.
    const d = diffSnapshots({ listings: [] }, { listings: [L("deal", 80)] });
    expect(d.added.map((l) => l.adId)).toEqual(["deal"]);
  });
});

describe("isResultsPage — a genuine zero-hit results page vs a consent/bot wall", () => {
  test("the results scaffold (srchrslt container) reads as a results page even with 0 aditem rows", () => {
    const html = `<html><body><div id="srchrslt-content"><ul id="srchrslt-adtable"></ul></div></body></html>`;
    expect(parseSearchHtml(html)).toHaveLength(0);
    expect(isResultsPage(html)).toBe(true);
  });

  test("KA's zero-hits outcome message reads as a results page", () => {
    expect(isResultsPage("<p>Es wurden leider keine Anzeigen gefunden.</p>")).toBe(true);
  });

  test("a consent/bot-wall interstitial reads as NOT a results page (watch keeps the old snapshot)", () => {
    const wall = `<html><body><div id="gdpr-banner">Alle akzeptieren</div>Bitte bestätigen Sie, dass Sie kein Roboter sind.</body></html>`;
    expect(parseSearchHtml(wall)).toHaveLength(0);
    expect(isResultsPage(wall)).toBe(false);
  });
});

describe("inBand / filterDiffByBand — the price band is a digest filter, applied to the diff", () => {
  test("inBand: a null price is in-band only when there's no lower bound", () => {
    expect(inBand(null, null, null)).toBe(true);
    expect(inBand(null, 50, null)).toBe(false);
    expect(inBand(100, 50, 150)).toBe(true);
    expect(inBand(40, 50, null)).toBe(false);
    expect(inBand(200, null, 150)).toBe(false);
  });

  test("filterDiffByBand keeps only in-band entries across added/dropped/gone", () => {
    const diff: SnapshotDiff = {
      added: [L("d", 50)],
      dropped: [{ ...L("a", 80), oldPrice: "100 €", oldPriceNum: 100 }],
      gone: [L("c", null)],
    };
    const filtered = filterDiffByBand(diff, 60, 150);
    expect(filtered.added).toHaveLength(0); // 50 < 60
    expect(filtered.dropped.map((l) => l.adId)).toEqual(["a"]); // 80 in band
    expect(filtered.gone).toHaveLength(0); // null price + a lower bound -> out
  });

  test("with no band set the diff passes through untouched", () => {
    const diff: SnapshotDiff = { added: [L("d", 50)], dropped: [], gone: [] };
    expect(filterDiffByBand(diff, null, null)).toBe(diff);
  });
});
