import type { Listing, WatchSpec } from "../evaluate.ts";
import { link, WatchRefused } from "../record.ts";
import {
  decodeEntities, dollarPrice, field, getText, listingId, POLITE_PAUSE_MS, sleep, stripTags,
  SELLER_TEXT_MAX, TITLE_MAX, type Fetched, type FetchContext, type Source,
} from "./html.ts";

/**
 * vstdeals: two reddit feeds and the audiopluginguy deals table (the
 * firehose), plus one musicsoftwaredeals price-history page per tracked
 * product.
 *
 * Two spec shapes:
 *
 *   { "target": { "kind": "interest", "term": "rx" }, "notify": { "price_at_or_under": 399 } }
 *   { "target": { "kind": "track", "slug": "rx-12-standard", "name": "RX 12 Standard",
 *     "url": "https://musicsoftwaredeals.com/price-history/..." }, "notify": { "price_record_low": true } }
 *
 * An interest term is the QUERY: the firehose is filtered to the items whose
 * title, brand, developer, tags or link carry the term at a word start, the
 * way a kleinanzeigen keyword filters the marketplace server-side. The
 * firehose is read ONCE PER TICK however many interest specs ask, through the
 * memo the tick carries. A feed that could not be read makes the sweep
 * incomplete rather than failed, and every feed failing is a failure.
 */

export const source = "vstdeals";
export const board = false;

export const REDDIT_FEEDS = [
  { id: "reddit-audioproductiondeals", sub: "AudioProductionDeals" },
  { id: "reddit-plugindeals", sub: "plugindeals" },
] as const;
export const APG_URL = "https://www.audiopluginguy.com/deals/";

interface FeedItem {
  id: string;
  price: number | null;
  title: string;
  url: string;
  developer: string;
  brand: string;
  product: string;
  tags: string;
  fullPrice: number | null;
  ends: string;
}

interface Firehose {
  feeds: { id: string; items: FeedItem[] }[];
  failed: string[];
}

interface InterestRaw { kind: "interest"; feeds: Firehose["feeds"] }
interface TrackRaw { kind: "track"; html: string; entry: { slug: string; name: string; url: string } }

/**
 * A term matches where it starts a word, so "rx" catches "RX 12" and
 * "rx-11-standard" without catching "Brainworx". A term ending in a letter
 * does not match when a digit is glued straight onto it, so "rx" stops
 * catching "Inphonik RX1200". A letter may follow, or every plural stops
 * matching.
 */
export function matchTerm(hay: string, term: string): boolean {
  const t = String(term ?? "").toLowerCase();
  if (t === "") return false;
  const endsAlpha = /[a-z]$/.test(t);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(t, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : hay[at - 1];
    const after = hay[at + t.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !(endsAlpha && /[0-9]/.test(after))) return true;
    from = at + 1;
  }
}

export function interestHay(item: FeedItem): string {
  return [item.title, item.product, item.brand, item.developer, item.tags, item.url].filter(Boolean).join(" ").toLowerCase();
}

function parseRedditTitle(title: string): { brand: string; product: string; price: number | null; ends: string } {
  const out = { brand: "", product: "", price: null as number | null, ends: "" };
  const q = title.match(/"([^"]{1,80})"/);
  if (q) {
    out.product = q[1].trim();
    out.brand = title.slice(0, q.index).replace(/[\s\-|:]+$/, "").trim();
  } else {
    const cut = title.search(/\s[-|(]\s|\s-\s/);
    const head = cut > 0 ? title.slice(0, cut) : title;
    out.brand = head.split(/\s+/).slice(0, 4).join(" ").trim();
  }
  const paren = title.match(/\(\s*\$\s*([\d,]+(?:\.\d{1,2})?)\s*\)/);
  const bare = title.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (paren) out.price = dollarPrice(paren[1].replace(/,/g, ""));
  else if (bare) out.price = dollarPrice(bare[1].replace(/,/g, ""));
  else if (/\bfree\b/i.test(title)) out.price = 0;
  const ends = title.match(/\b(?:through|until|till|ends?(?:\s+on)?|valid\s+until)\s+([^,.()]{2,30}?)(?=\s*(?:[,.()]|with\s+code|$))/i);
  if (ends) out.ends = ends[1].trim();
  return out;
}

export function parseRedditFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const e = m[1];
    const idM = e.match(/<id>([^<]*)<\/id>/);
    const titleM = e.match(/<title>([\s\S]*?)<\/title>/);
    const linkM = e.match(/<link[^>]*href="([^"]*)"/);
    if (!idM || !titleM) continue;
    const key = decodeEntities(idM[1]).trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const title = decodeEntities(titleM[1]).replace(/\s+/g, " ").trim();
    const extra = parseRedditTitle(title);
    items.push({ id: key, price: extra.price, title, url: linkM ? decodeEntities(linkM[1]) : "", developer: "", brand: extra.brand, product: extra.product, tags: "", fullPrice: null, ends: extra.ends });
  }
  return items;
}

/** An audiopluginguy row has no id of its own, so the id is a short hash of its link. */
export const apgId = (url: string): string => `apg:${new Bun.CryptoHasher("sha1").update(String(url)).digest("hex").slice(0, 12)}`;

export function parseApg(html: string): FeedItem[] {
  const bodyStart = html.indexOf("<tbody");
  if (bodyStart === -1) return [];
  const bodyEnd = html.indexOf("</tbody>", bodyStart);
  const body = html.slice(bodyStart, bodyEnd === -1 ? html.length : bodyEnd);
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const row of body.split(/<tr\b/i).slice(1)) {
    const cols: Record<string, string> = {};
    const cre = /<td class="([^"]*?)column-(\d)[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
    let c: RegExpExecArray | null;
    while ((c = cre.exec(row))) cols[c[2]] = c[3];
    const url = stripTags(cols["5"] ?? "");
    if (url === "" || !/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const c1 = cols["1"] ?? "";
    const devM = c1.match(/<strong>\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/strong>/i);
    const links = [...c1.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((x) => stripTags(x[1]));
    const developer = devM ? stripTags(devM[1]) : links[0] ?? "";
    const description = (links.find((t) => t !== "" && t !== developer) ?? stripTags(c1)).trim();
    const tagsM = row.match(/data-tags="([^"]*)"/);
    const fullM = description.match(/normally\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
    const offer = description.replace(/\(\s*normally[^)]*\)/gi, " ");
    const priceM = offer.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    const isFree = !priceM && /\bfree\b/i.test(offer);
    items.push({
      id: apgId(url), price: priceM ? dollarPrice(priceM[1].replace(/,/g, "")) : isFree ? 0 : null,
      title: description, url, developer, brand: "", product: "",
      tags: tagsM ? decodeEntities(tagsM[1]) : "", fullPrice: fullM ? dollarPrice(fullM[1].replace(/,/g, "")) : null,
      ends: stripTags(cols["3"] ?? ""),
    });
  }
  return items;
}

function balancedDiv(html: string, openIdx: number): string {
  const re = /<div\b|<\/div>/gi;
  re.lastIndex = openIdx;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0][1] === "/") { depth--; if (depth === 0) return html.slice(openIdx, m.index + m[0].length); }
    else depth++;
  }
  return html.slice(openIdx);
}

function trackerRow(html: string, kind: string): { price: number | null; date: string; store: string } | null {
  const i = html.indexOf(`history-prices__row_${kind}`);
  if (i === -1) return null;
  const block = html.slice(i, i + 2500);
  const priceM = block.match(/history-prices__row-price[^>]*>\s*([^<]*)</);
  const dateM = block.match(/history-prices__row-subtitle_date[^>]*>\s*([^<]*)</);
  const storeM = block.match(/history-prices__row-subtitle_store[^>]*>[\s\S]{0,300}?<a[^>]*>([^<]*)</);
  return { price: priceM ? dollarPrice(priceM[1]) : null, date: dateM ? dateM[1].trim() : "", store: storeM ? stripTags(storeM[1]) : "" };
}

function trackerStorePrices(html: string, heading: string): { store: string; price: number }[] {
  const h = html.indexOf(`>${heading}<`);
  if (h === -1) return [];
  const wrap = html.indexOf("deal__prices-wrap", h);
  if (wrap === -1) return [];
  const block = balancedDiv(html, html.lastIndexOf("<div", wrap));
  const out: { store: string; price: number }[] = [];
  const re = /deal__price-name">([^<]*)<\/span><span class="deal__price-sum">([^<]*)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const price = dollarPrice(m[2]);
    if (price != null) out.push({ store: stripTags(m[1]), price });
  }
  return out;
}

export interface Tracked {
  title: string;
  onSale: boolean;
  price: number | null;
  fullPrice: number | null;
  lowestEver: number | null;
  lowestDate: string;
  lowestStore: string;
  lastSalePrice: number | null;
}

/** The price page of one tracked product, or null when it holds no price at all. */
export function parseTracker(html: string, name: string): Tracked | null {
  const titleM = html.match(/<title>([\s\S]*?)<\/title>/);
  const pageTitle = titleM ? stripTags(titleM[1]).replace(/\s*-\s*Music Software Deals\s*$/i, "") : "";
  const badge = html.match(/deal__badge deal__badge_([a-z-]+)">([^<]*)</);
  const onSale = !!badge && badge[1] !== "not-on-sale";
  const full = trackerRow(html, "real");
  const lowest = trackerRow(html, "lowest");
  const lastSale = trackerRow(html, "sale");
  const active = onSale ? trackerStorePrices(html, "Active sale") : [];
  const price = active.length > 0 ? Math.min(...active.map((s) => s.price)) : null;
  if (full === null && lowest === null && active.length === 0) return null;
  return {
    title: pageTitle || name, onSale, price,
    fullPrice: full ? full.price : null, lowestEver: lowest ? lowest.price : null,
    lowestDate: lowest ? lowest.date : "", lowestStore: lowest ? lowest.store : "",
    lastSalePrice: lastSale ? lastSale.price : null,
  };
}

/** AT the record low counts, because the tracker folds today into it: discounted AND at or under the lowest ever. */
export function atRecordLow(item: Tracked): boolean {
  return item.price != null && item.fullPrice != null && item.lowestEver != null && item.price < item.fullPrice && item.price <= item.lowestEver;
}

/** The three firehose feeds, read once per tick whichever interest spec asks first. */
async function readFirehose(ctx: FetchContext): Promise<Firehose> {
  const memo = ctx.memo;
  const kept = memo?.get("vstdeals:firehose") as Promise<Firehose> | undefined;
  if (kept) return await kept;
  const reading = (async (): Promise<Firehose> => {
    const feeds: Firehose["feeds"] = [];
    const failed: string[] = [];
    let first = true;
    const one = async (id: string, url: string, accept: string, parse: (text: string) => FeedItem[], marker: RegExp) => {
      if (!first) await sleep(ctx.pauseMs ?? POLITE_PAUSE_MS);
      first = false;
      let text: string;
      try {
        text = await getText(ctx, url, accept, "en-US,en;q=0.9");
      } catch (error) {
        failed.push(`${id}: ${error instanceof WatchRefused ? error.detail : "could not be read"}`);
        return;
      }
      const items = parse(text);
      // A feed that carries entry markers and parses to none is a markup
      // change, never a quiet day.
      if (items.length === 0 && marker.test(text)) { failed.push(`${id}: carries entries and parsed none`); return; }
      feeds.push({ id, items });
    };
    for (const feed of REDDIT_FEEDS) {
      await one(feed.id, `https://www.reddit.com/r/${feed.sub}/new/.rss`, "application/atom+xml", parseRedditFeed, /<entry>/);
    }
    await one("apg", APG_URL, "text/html,application/xhtml+xml", parseApg, /<tbody/);
    return { feeds, failed };
  })();
  memo?.set("vstdeals:firehose", reading);
  return await reading;
}

export async function fetch(spec: WatchSpec, ctx: FetchContext): Promise<Fetched> {
  const target = spec.target as { kind: string; term?: string; slug?: string; name?: string; url?: string };
  if (target.kind === "track") {
    const url = String(target.url);
    const html = await getText(ctx, url, "text/html,application/xhtml+xml", "en-US,en;q=0.9");
    const raw: TrackRaw = { kind: "track", html, entry: { slug: String(target.slug), name: String(target.name ?? target.slug), url } };
    return { raw, url, complete: true };
  }
  const firehose = await readFirehose(ctx);
  if (firehose.feeds.length === 0) {
    throw new WatchRefused("fetch", "operation failed", `${spec.id}: every feed failed: ${firehose.failed.join("; ")}`);
  }
  const raw: InterestRaw = { kind: "interest", feeds: firehose.feeds };
  return { raw, url: APG_URL, complete: firehose.failed.length === 0 };
}

export function pageLooksLikeResults(raw: unknown): boolean {
  const it = raw as TrackRaw | InterestRaw | null;
  // A price page with the history rows on it that parses to no price is a
  // markup change. An interest term matching nothing is an ordinary day.
  return !!it && it.kind === "track" && /history-prices__row/.test(it.html);
}

export function parse(raw: unknown, spec: WatchSpec): Listing[] {
  const it = raw as TrackRaw | InterestRaw | null;
  if (!it) return [];
  if (it.kind === "track") {
    const item = parseTracker(it.html, it.entry.name);
    if (item === null) return [];
    const usd = (n: number | null) => (n == null ? "-" : `$${n}`);
    const seller = [
      item.onSale ? "on sale" : "not on sale",
      `full ${usd(item.fullPrice)}`,
      `lowest ever ${usd(item.lowestEver)}${item.lowestDate ? ` on ${item.lowestDate}` : ""}${item.lowestStore ? ` at ${item.lowestStore}` : ""}`,
      item.lastSalePrice == null ? "" : `last sale ${usd(item.lastSalePrice)}`,
    ].filter((one) => one !== "").join(" · ");
    return [{
      id: listingId(`track:${it.entry.slug}`), source, spec: spec.id, kind: "product",
      price: item.price, currency: "USD",
      title: field(item.title, TITLE_MAX), seller_text: field(seller, SELLER_TEXT_MAX),
      url: link(it.entry.url), record_low: atRecordLow(item),
    }];
  }
  // The term is the SPEC's: the feeds are one read shared by every interest
  // spec of the tick, and each spec filters them by its own word.
  const term = String((spec.target as { term?: string }).term ?? "").toLowerCase();
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const feed of it.feeds) {
    for (const item of feed.items) {
      if (!matchTerm(interestHay(item), term)) continue;
      const id = listingId(item.id);
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      const seller = [
        item.developer || item.brand,
        item.fullPrice == null ? "" : `normally $${item.fullPrice}`,
        item.ends ? `ends ${item.ends}` : "",
        `via ${feed.id}`,
      ].filter((one) => one !== "").join(" · ");
      out.push({
        id, source, spec: spec.id, kind: "deal",
        price: item.price, currency: "USD",
        title: field(item.title, TITLE_MAX), seller_text: field(seller, SELLER_TEXT_MAX), url: link(item.url),
      });
    }
  }
  return out;
}

export const vstdeals: Source = { source, board, fetch, parse, pageLooksLikeResults };
