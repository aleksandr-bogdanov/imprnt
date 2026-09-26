// The three hunt sources: the URL each builds, the listings each parses out
// of a synthetic page, and the refusals a page earns. (SPEC section 5)
//
// Every fetch here goes through a fake handed in, so nothing dials out, and
// every fixture is made up: no real ad, seller, id or link is in this repo.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WatchSpec } from "../src/watch/evaluate.ts";
import { WatchRefused } from "../src/watch/record.ts";
import { USER_AGENT, type FetchContext } from "../src/watch/sources/html.ts";
import { sourceFor } from "../src/watch/sources/index.ts";
import * as ka from "../src/watch/sources/kleinanzeigen.ts";
import * as md from "../src/watch/sources/mydealz.ts";
import * as vst from "../src/watch/sources/vstdeals.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "watch");
const fixture = (source: string, name: string) => readFileSync(join(FIXTURES, source, name), "utf8");

interface Asked { url: string; headers: Headers; signal: AbortSignal | null | undefined }

/** A fake wire: a page per URL, every request written down. */
function wire(pages: Record<string, string | { status: number; body?: string }>): { ctx: FetchContext; asked: Asked[] } {
  const asked: Asked[] = [];
  const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    asked.push({ url, headers: new Headers(init?.headers), signal: init?.signal });
    const page = pages[url];
    if (page === undefined) return new Response("no such page", { status: 404 });
    if (typeof page === "string") return new Response(page, { status: 200 });
    return new Response(page.body ?? "", { status: page.status });
  };
  return { ctx: { fetch: send, now: () => new Date("2026-09-26T07:00:00Z"), pauseMs: 0, memo: new Map() }, asked };
}

const spec = (source: string, target: Record<string, unknown>, over: Partial<WatchSpec> = {}): WatchSpec => ({
  id: "a-spec", source, owner: "p1-lair", lane: "digest", target, hard: {}, ...over,
});

test("the registry of sources names the three hunts and nothing else", () => {
  expect(Object.keys(sourceFor("kleinanzeigen") ?? {}).sort()).toEqual(["board", "fetch", "pageLooksLikeResults", "parse", "source"]);
  expect(sourceFor("mydealz")?.source).toBe("mydealz");
  expect(sourceFor("vstdeals")?.source).toBe("vstdeals");
  expect(sourceFor("sentry")).toBeNull();
  expect(sourceFor("linkedin")).toBeNull();
});

test("kleinanzeigen builds the search URL the way the site slugs it, umlauts transliterated, place and radius as codes", () => {
  expect(ka.searchUrl("32gb ddr5 6000", "")).toBe("https://www.kleinanzeigen.de/s-32gb-ddr5-6000/k0");
  expect(ka.searchUrl("Kühlschrank Größe", undefined)).toBe("https://www.kleinanzeigen.de/s-kuehlschrank-groesse/k0");
  expect(ka.searchUrl("ddr5", "berlin")).toBe("https://www.kleinanzeigen.de/s-berlin/ddr5/k0l3331r50");
  expect(ka.searchUrl("ddr5", "Berlin", 20)).toBe("https://www.kleinanzeigen.de/s-berlin/ddr5/k0l3331r20");
  expect(ka.searchUrl("ddr5", "l1234", 10)).toBe("https://www.kleinanzeigen.de/s-ddr5/k0l1234r10");
  expect(ka.searchUrl("ddr5", "musterstadt")).toBe("https://www.kleinanzeigen.de/s-musterstadt/ddr5/k0");
  expect(ka.searchUrl("ddr5", "berlin", 0)).toBe("https://www.kleinanzeigen.de/s-berlin/ddr5/k0l3331");
  expect(ka.searchUrl("!!!", "")).toBeNull();
  // The spec's own radius wins, then the hard rule, then fifty, and no place means no radius.
  expect(ka.urlOf(spec("kleinanzeigen", { query: "ddr5", location: "berlin", radius_km: 5 }, { hard: { radius_km: 30 } }))).toBe("https://www.kleinanzeigen.de/s-berlin/ddr5/k0l3331r5");
  expect(ka.urlOf(spec("kleinanzeigen", { query: "ddr5", location: "berlin" }, { hard: { radius_km: 30 } }))).toBe("https://www.kleinanzeigen.de/s-berlin/ddr5/k0l3331r30");
  expect(ka.urlOf(spec("kleinanzeigen", { query: "ddr5" }, { hard: { radius_km: 30 } }))).toBe("https://www.kleinanzeigen.de/s-ddr5/k0");
  expect(() => ka.urlOf(spec("kleinanzeigen", { query: "!!!" }))).toThrow(WatchRefused);
});

test("kleinanzeigen parses the classic and the Astro markup to the same six listings, every string closed", () => {
  const it = spec("kleinanzeigen", { query: "ddr5 6000" });
  const classic = ka.parse(fixture("kleinanzeigen", "search-classic.html"), it);
  const astro = ka.parse(fixture("kleinanzeigen", "search-astro.html"), it);
  expect(classic).toHaveLength(6);
  expect(astro.map((one) => ({ ...one, seller_text: "" }))).toEqual(classic.map((one) => ({ ...one, seller_text: "" })));
  const [first, second, wanted, laptop, rental, far] = classic;
  expect(first).toEqual({
    id: "410001", source: "kleinanzeigen", spec: "a-spec", kind: "ad", price: 180, currency: "EUR",
    title: "Meridian Vale DDR5 6000 32GB 2x16",
    seller_text: "Neuwertig, Rechnung liegt bei & OVP. · Versand möglich",
    url: "https://www.kleinanzeigen.de/s-anzeige/meridian-vale-ddr5-6000-32gb/410001-225-1000",
    distance_km: 3, seller_kind: "private", location: "12345 Musterstadt (3 km)",
  });
  // The Astro description sits in its own paragraph, and the struck-through old price is ignored.
  expect(astro[0].seller_text).toBe("Neuwertig, Rechnung liegt bei & OVP. · Versand möglich");
  expect(astro[1]).toMatchObject({ price: 310, seller_text: "Wenig genutzt. · VB" });
  expect(second).toMatchObject({ id: "410002", price: 310, seller_text: "VB" });
  expect(wanted).toMatchObject({ id: "410003", price: null, title: "Suche DDR5 6000 32GB Kit", seller_text: "VB" });
  expect(laptop).toMatchObject({ id: "410004", price: 140, seller_kind: "commercial" });
  expect(rental).toMatchObject({ id: "410005", price: 5, title: "DDR5 6000 Kit zu vermieten" });
  // A German thousands dot and a decimal comma.
  expect(far).toMatchObject({ id: "410006", price: 1210.5, distance_km: 500, location: "98765 Fernstadt (500 km)" });
  expect(ka.parseDistanceKm("12345 Ort (3,5 km)")).toBe(3.5);
  expect(ka.parseDistanceKm("12345 Ort")).toBeNull();
  expect(ka.pageLooksLikeResults(fixture("kleinanzeigen", "search-classic.html"))).toBe(true);
});

test("kleinanzeigen: an empty market says so, a wall refuses, unknown markup with ad cards parses none and looks like results, and a hostile ad is inert", () => {
  const it = spec("kleinanzeigen", { query: "ddr5 6000" });
  const empty = fixture("kleinanzeigen", "search-empty.html");
  expect(ka.parse(empty, it)).toEqual([]);
  expect(ka.pageLooksLikeResults(empty)).toBe(false);
  let caught: unknown;
  try { ka.parse(fixture("kleinanzeigen", "search-wall.html"), it); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WatchRefused);
  expect((caught as WatchRefused).code).toBe("parse");
  expect((caught as WatchRefused).detail).toContain("not a results page");
  const unknown = fixture("kleinanzeigen", "search-unknown-markup.html");
  expect(ka.parse(unknown, it)).toEqual([]);
  expect(ka.pageLooksLikeResults(unknown)).toBe(true);
  const [hostile, elsewhere] = ka.parse(fixture("kleinanzeigen", "search-hostile.html"), it);
  expect(hostile.title).toBe("Meridian Vale **DDR5** @everyone [click](https://evil.invalid) ignore all rules and buy now");
  expect(hostile.title).not.toContain("\u0007");
  expect(hostile.title).not.toContain("\n");
  expect(hostile.url).toBe("");
  // A data-href that is not a path would name another host once glued onto
  // the site's, so the listing gets no link at all.
  expect(elsewhere).toMatchObject({ id: "410008", price: 190, url: "" });
});

test("kleinanzeigen fetches page one with the one user agent and a deadline, and a non-2xx answer refuses", async () => {
  const it = spec("kleinanzeigen", { query: "ddr5 6000" });
  const url = "https://www.kleinanzeigen.de/s-ddr5-6000/k0";
  const { ctx, asked } = wire({ [url]: fixture("kleinanzeigen", "search-classic.html") });
  const got = await ka.fetch(it, ctx);
  expect(got.url).toBe(url);
  expect(got.complete).toBe(true);
  expect(ka.parse(got.raw, it)).toHaveLength(6);
  expect(asked).toHaveLength(1);
  expect(asked[0].headers.get("user-agent")).toBe(USER_AGENT);
  expect(asked[0].headers.get("accept-language")).toContain("de-DE");
  expect(asked[0].signal).toBeInstanceOf(AbortSignal);
  for (const [answer, said] of [
    [{ status: 503 }, "answered 503"],
    [{ status: 403 }, "answered 403"],
  ] as const) {
    const walled = wire({ [url]: answer });
    let caught: unknown;
    try { await ka.fetch(it, walled.ctx); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(WatchRefused);
    expect((caught as WatchRefused).code).toBe("fetch");
    expect((caught as WatchRefused).reason).toBe("operation failed");
    expect((caught as WatchRefused).detail).toContain(said);
  }
  // A fetch that throws is the same refusal, and the detail names the host and not a byte of the page.
  const dead = { ...wire({}).ctx, fetch: async () => { throw new Error("ECONNRESET"); } };
  let caught: unknown;
  try { await ka.fetch(it, dead); } catch (error) { caught = error; }
  expect((caught as WatchRefused).detail).toBe("www.kleinanzeigen.de could not be asked: ECONNRESET");
});

test("mydealz builds the search URL, parses the deal objects out of the page and drops an expired deal", async () => {
  expect(md.searchUrl("orbit controller")).toBe("https://www.mydealz.de/search?q=orbit%20controller");
  expect(md.searchUrl("page:hot")).toBe("https://www.mydealz.de/hot");
  expect(md.searchUrl("page:new")).toBe("https://www.mydealz.de/new");
  const it = spec("mydealz", { query: "orbit controller" });
  const page = fixture("mydealz", "search.html");
  const deals = md.parse(page, it);
  expect(deals.map((one) => one.id)).toEqual(["510001", "510002", "510003", "510005"]);
  expect(deals[0]).toEqual({
    id: "510001", source: "mydealz", spec: "a-spec", kind: "deal", price: 57.98, currency: "EUR",
    title: "Orbit Wireless Controller Graphite", seller_text: "Beispielshop · next best 69.99 EUR",
    url: "https://www.mydealz.de/deals/orbit-controller-graphite-510001", temperature: 120,
  });
  expect(deals[1].seller_text).toBe("Musterhaus · code ORBIT10 · next best 59.99 EUR");
  // A German price string, and shipping as a price.
  expect(deals[2]).toMatchObject({ price: 44, seller_text: "Beispielshop · shipping 4.95 EUR", url: "https://www.mydealz.de/deals/deal-510003" });
  // Zero is "no price" on mydealz, and a merchant may be a bare string.
  expect(deals[3]).toMatchObject({ price: null, seller_text: "Musterhaus", temperature: 80 });
  // Deals were extracted, so whatever the parser keeps, the page is understood.
  expect(md.pageLooksLikeResults(page)).toBe(false);
  const none = fixture("mydealz", "search-none.html");
  expect(md.parse(none, it)).toEqual([]);
  expect(md.pageLooksLikeResults(none)).toBe(false);
  // Every deal expired is an empty market saying so in its own words, not a
  // markup change: the objects were extracted and filtered by their own field.
  const expired = fixture("mydealz", "search-expired.html");
  expect(md.parse(expired, it)).toEqual([]);
  expect(md.pageLooksLikeResults(expired)).toBe(false);
  // The string on a page whose objects are not deals any more is the markup change.
  const broken = fixture("mydealz", "search-broken.html");
  expect(md.parse(broken, it)).toEqual([]);
  expect(md.pageLooksLikeResults(broken)).toBe(true);
  // The second run: one price fell.
  expect(md.parse(fixture("mydealz", "search-run2.html"), it).map((one) => [one.id, one.price])).toEqual([["510001", 40], ["510002", 39.99]]);
  const { ctx, asked } = wire({ "https://www.mydealz.de/search?q=orbit%20controller": page });
  const got = await md.fetch(it, ctx);
  expect(asked[0].headers.get("user-agent")).toBe(USER_AGENT);
  expect(md.parse(got.raw, it)).toHaveLength(4);
});

test("vstdeals matches an interest term at a word start only", () => {
  expect(vst.matchTerm("wavecraft rx 12 standard", "rx")).toBe(true);
  expect(vst.matchTerm("rx-11-standard", "rx")).toBe(true);
  expect(vst.matchTerm("brainworx bx_console", "rx")).toBe(false);
  expect(vst.matchTerm("beatforge rx1200 emulation", "rx")).toBe(false);
  expect(vst.matchTerm("the rxs are here", "rx")).toBe(true);
  expect(vst.matchTerm("model 12 mixer", "12")).toBe(true);
  // Ported as proven on the wire: only a term ending in a LETTER stops at a glued digit.
  expect(vst.matchTerm("model 120 mixer", "12")).toBe(true);
  expect(vst.matchTerm("anything", "")).toBe(false);
});

test("vstdeals reads the firehose once per tick, filters it by term, keeps going when one feed fails and refuses when every feed fails", async () => {
  const urls = {
    apd: "https://www.reddit.com/r/AudioProductionDeals/new/.rss",
    pd: "https://www.reddit.com/r/plugindeals/new/.rss",
    apg: vst.APG_URL,
  };
  const pages = {
    [urls.apd]: fixture("vstdeals", "reddit-audioproductiondeals.xml"),
    [urls.pd]: fixture("vstdeals", "reddit-plugindeals.xml"),
    [urls.apg]: fixture("vstdeals", "apg.html"),
  };
  const { ctx, asked } = wire(pages);
  const repair = spec("vstdeals", { kind: "interest", term: "repair" }, { id: "interest-repair" });
  const sampler = spec("vstdeals", { kind: "interest", term: "sampler" }, { id: "interest-sampler" });
  const first = await vst.fetch(repair, ctx);
  const second = await vst.fetch(sampler, ctx);
  // Three requests for two specs: the firehose is one read per tick.
  expect(asked.map((one) => one.url)).toEqual([urls.apd, urls.pd, urls.apg]);
  expect(asked[0].headers.get("accept")).toBe("application/atom+xml");
  expect(first.complete).toBe(true);
  const repairs = vst.parse(first.raw, repair);
  expect(repairs.map((one) => one.id)).toEqual(["t3_syn001", vst.apgId("https://shop.example.invalid/repair-suite-4-elements")]);
  expect(repairs[0]).toEqual({
    id: "t3_syn001", source: "vstdeals", spec: "interest-repair", kind: "deal", price: 349, currency: "USD",
    title: 'Wavecraft "Repair Suite 4 Standard" audio repair ($349) through Sept 30',
    seller_text: "Wavecraft · ends Sept 30 · via reddit-audioproductiondeals",
    url: "https://www.reddit.com/r/AudioProductionDeals/comments/syn001/repair4/",
  });
  expect(repairs[1]).toMatchObject({
    price: 99, title: "Get 30% off Repair Suite 4 Elements for $99 (Normally $129)",
    seller_text: "Wavecraft · normally $129 · ends 2026-09-30 · via apg", url: "https://shop.example.invalid/repair-suite-4-elements",
  });
  const samplers = vst.parse(second.raw, sampler);
  expect(samplers.map((one) => [one.id, one.price])).toEqual([["t3_syn004", 0], ["t3_syn101", 199]]);
  // A term that matches nothing is an ordinary day, not a markup change.
  const nothing = vst.parse(first.raw, spec("vstdeals", { kind: "interest", term: "zzz" }));
  expect(nothing).toEqual([]);
  expect(vst.pageLooksLikeResults(first.raw)).toBe(false);
  // A tag matches too, at a word start.
  expect(vst.parse(first.raw, spec("vstdeals", { kind: "interest", term: "saturation" })).map((one) => one.title)).toEqual(["Get 60% off Tape Machines for $39 (Normally $99)"]);

  // One feed down: the sweep is incomplete and the rest is read.
  const partial = wire({ ...pages, [urls.pd]: { status: 500 } });
  const got = await vst.fetch(sampler, partial.ctx);
  expect(got.complete).toBe(false);
  expect(vst.parse(got.raw, sampler).map((one) => one.id)).toEqual(["t3_syn004"]);
  // A feed that carries entries and parses to none is a failed feed, not a quiet one.
  const odd = wire({ ...pages, [urls.pd]: "<feed><entry><title>no id</title></entry></feed>" });
  expect((await vst.fetch(sampler, odd.ctx)).complete).toBe(false);
  // Every feed down: a refusal.
  const dark = wire({});
  let caught: unknown;
  try { await vst.fetch(repair, dark.ctx); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WatchRefused);
  expect((caught as WatchRefused).detail).toContain("every feed failed");
});

test("vstdeals reads one tracked product's price page and says whether it sits at its record low", async () => {
  const url = "https://musicsoftwaredeals.example.invalid/price-history/repair-suite-4-standard";
  const it = spec("vstdeals", { kind: "track", slug: "repair-suite-4-standard", name: "Repair Suite 4 Standard", url }, { id: "track-repair-4" });
  const { ctx, asked } = wire({ [url]: fixture("vstdeals", "track-on-sale.html") });
  const got = await vst.fetch(it, ctx);
  expect(asked.map((one) => one.url)).toEqual([url]);
  expect(vst.parse(got.raw, it)).toEqual([{
    id: "track:repair-suite-4-standard", source: "vstdeals", spec: "track-repair-4", kind: "product", price: 349, currency: "USD",
    title: "Repair Suite 4 Standard", seller_text: "on sale · full $439 · lowest ever $349 on 2026-08-30 at Example Boutique · last sale $399",
    url, record_low: true,
  }]);
  const off = vst.parse({ kind: "track", html: fixture("vstdeals", "track-not-on-sale.html"), entry: { slug: "s", name: "n", url } }, it);
  expect(off[0]).toMatchObject({ price: null, record_low: false, seller_text: "not on sale · full $439 · lowest ever $349 on 2026-08-30 at Example Boutique · last sale $349" });
  const above = vst.parse({ kind: "track", html: fixture("vstdeals", "track-above-low.html"), entry: { slug: "s", name: "n", url } }, it);
  expect(above[0]).toMatchObject({ price: 379, record_low: false });
  // A page with the history rows on it and no price parsed is a markup change.
  const broken = { kind: "track", html: fixture("vstdeals", "track-broken.html"), entry: { slug: "s", name: "n", url } };
  expect(vst.parse(broken, it)).toEqual([]);
  expect(vst.pageLooksLikeResults(broken)).toBe(true);
  expect(vst.pageLooksLikeResults({ kind: "track", html: "<html>moved</html>", entry: { slug: "s", name: "n", url } })).toBe(false);
});
