import type { Listing, WatchSpec } from "../evaluate.ts";
import { link, WatchRefused } from "../record.ts";
import {
  decodeEntities, field, germanPrice, getText, listingId, stripTags,
  LOCATION_MAX, SELLER_TEXT_MAX, TITLE_MAX, type Fetched, type FetchContext, type Source,
} from "./html.ts";

/**
 * Kleinanzeigen: page one of a saved search on the public HTML. Search pages
 * need no login, and the message box is not read by this version.
 *
 * A spec's target is `{ query, location?, radius_km? }`. The URL is built the
 * way the site builds its own slugs: German queries carry umlauts and the
 * site transliterates them (kuehlschrank, not k-hlschrank), so stripping them
 * built a dead URL that read exactly like an empty market.
 *
 * TWO MARKUPS. The classic one (`<article class="aditem">`, `aditem-main--*`
 * blocks, an `<h2>` title, a `badge-hint-pro` marker) and the Astro one the
 * site serves now (`<article ... data-adid data-href>`, an
 * ld+json block per ad, location and date as the two spans of the top row,
 * `<h3><a>title</a></h3>`, the current price as the `font-strong` paragraph
 * with the old price struck through beside it, a `PRO` badge or a `/pro/`
 * shop link for a commercial seller). One article regex keyed on `data-adid`,
 * and every field tries the classic selector, then the Astro one.
 */

export const source = "kleinanzeigen";
export const board = true;

const HOST = "https://www.kleinanzeigen.de";
const LOCATIONS: Record<string, { path: string; code: string }> = { berlin: { path: "s-berlin", code: "l3331" } };
export const DEFAULT_RADIUS_KM = 50;

function deumlaut(s: string): string {
  return s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export const slugifyKeyword = (keyword: string): string =>
  deumlaut(String(keyword).toLowerCase().trim()).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function searchUrl(keyword: string, location: string | undefined, radiusKm: number = DEFAULT_RADIUS_KM): string | null {
  const slug = slugifyKeyword(keyword);
  if (slug === "") return null;
  const loc = location ? String(location).toLowerCase().trim() : "";
  if (loc === "") return `${HOST}/s-${slug}/k0`;
  const r = Number.isFinite(radiusKm) && radiusKm > 0 ? `r${Math.round(radiusKm)}` : "";
  const known = LOCATIONS[loc];
  if (known) return `${HOST}/${known.path}/${slug}/k0${known.code}${r}`;
  if (/^l\d+$/.test(loc)) return `${HOST}/s-${slug}/k0${loc}${r}`;
  return `${HOST}/s-${loc.replace(/[^a-z0-9]+/g, "-")}/${slug}/k0`;
}

// The decimal comma is part of the token: without it "1.210,50 €" matches at
// its last two digits and reads as fifty euro.
const PRICE_TOKEN = /\d[\d.]*(?:,\d+)?\s?€(?:\s?VB)?/;
const firstPriceToken = (s: string): string => {
  const m = s.match(new RegExp(`${PRICE_TOKEN.source}|Zu verschenken|VB`, "i"));
  return m ? m[0] : "";
};

export function parseDistanceKm(location: string): number | null {
  const m = String(location ?? "").match(/\((\d+(?:[.,]\d+)?)\s*km\)/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const isResultsPage = (html: string) => /srchrslt/i.test(html) || /keine\s+(Anzeigen|Ergebnisse)/i.test(html);

/** Ads are on the page whatever the markup around them: every ad card carries `data-adid` in both shapes. */
const carriesAds = (html: string) => /data-adid="\d+"/.test(html);

export interface SearchRow {
  id: string;
  title: string;
  price: string;
  description: string;
  location: string;
  date: string;
  url: string;
  shipping: boolean;
  commercial: boolean;
}

export function parseSearchHtml(html: string): SearchRow[] {
  const out: SearchRow[] = [];
  const re = /<article\b([^>]*)data-adid="(\d+)"([^>]*)>([\s\S]*?)<\/article>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const openTag = m[1] + m[3];
    const id = m[2];
    const block = m[4];
    const hrefM = openTag.match(/data-href="([^"]*)"/) || block.match(/href="(\/s-anzeige\/[^"]*)"/);
    const href = hrefM ? hrefM[1] : "";
    let title = "";
    const lj = block.match(/"title":"((?:[^"\\]|\\.)*)"/);
    if (lj) { try { title = JSON.parse(`"${lj[1]}"`); } catch { title = lj[1]; } }
    if (title === "") { const h = block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/); if (h) title = stripTags(h[1]); }
    let price = "";
    const pe = block.match(/class="aditem-main--middle--price-shipping--price"[^>]*>([\s\S]*?)<\/p>/)
      || block.match(/<p class="[^"]*\bfont-strong\b[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (pe) price = firstPriceToken(stripTags(pe[1]));
    if (price === "") { const pm = block.match(PRICE_TOKEN); if (pm) price = pm[0]; }
    let description = "";
    const de = block.match(/class="aditem-main--middle--description"[^>]*>([\s\S]*?)<\/p>/)
      || block.match(/<p class="[^"]*\btext-onSurfaceSubdued\b[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (de) description = stripTags(de[1]);
    let location = "";
    let date = "";
    const le = block.match(/aditem-main--top--left"[^>]*>([\s\S]*?)<\/div>/);
    const re2 = block.match(/aditem-main--top--right"[^>]*>([\s\S]*?)<\/div>/);
    if (le) location = stripTags(le[1]);
    if (re2) date = stripTags(re2[1]);
    if (!le && !re2) {
      // Astro: the top row is two `text-onSurfaceNonessential` cells, an icon
      // and a span each, location first, date second.
      const cells = [...block.matchAll(/class="[^"]*\btext-onSurfaceNonessential\b[^"]*"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/g)].map((c) => stripTags(c[1]));
      if (cells.length > 0) location = cells[0];
      if (cells.length > 1) date = cells[1];
    }
    const shipping = /Versand möglich|Versand moeglich/i.test(block) && !/Nur Abholung|kein\w* Versand/i.test(block);
    const commercial = /badge-hint-pro/i.test(openTag + block) || /href="\/pro\//.test(block) || />PRO<\/div>/.test(block);
    // Only a path joins the host: anything else glued onto it could name
    // another host, and a listing with no link is better than one elsewhere.
    out.push({ id, title: decodeEntities(title).trim(), price, description, location, date, url: href.startsWith("/") ? HOST + href : "", shipping, commercial });
  }
  return out;
}

function radiusOf(spec: WatchSpec): number {
  const target = spec.target as { location?: string; radius_km?: number };
  if (!target.location) return 0;
  const r = target.radius_km ?? spec.hard?.radius_km;
  if (r == null) return DEFAULT_RADIUS_KM;
  return Number.isFinite(r) && r > 0 ? r : 0;
}

export function urlOf(spec: WatchSpec): string {
  const target = spec.target as { query: string; location?: string };
  const url = searchUrl(target.query, target.location, radiusOf(spec));
  if (url === null) throw new WatchRefused("fetch", "invalid configuration", `${spec.id}: target.query is empty once slugged`);
  return url;
}

export async function fetch(spec: WatchSpec, ctx: FetchContext): Promise<Fetched> {
  const url = urlOf(spec);
  const raw = await getText(ctx, url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  return { raw, url, complete: true };
}

export function pageLooksLikeResults(raw: unknown): boolean {
  return typeof raw === "string" && carriesAds(raw);
}

/**
 * The rows as listings. A page with no ad cards that is not a results page
 * either is a wall (consent, bot, a moved page) and refuses here, whatever the
 * sheet holds: an empty market says so in its own words.
 */
export function parse(raw: unknown, spec: WatchSpec): Listing[] {
  const html = typeof raw === "string" ? raw : "";
  const rows = parseSearchHtml(html);
  if (rows.length === 0 && !carriesAds(html) && !isResultsPage(html)) {
    throw new WatchRefused("parse", "operation failed", `${spec.id}: not a results page (a consent wall, a bot wall or a markup change)`);
  }
  const out: Listing[] = [];
  for (const row of rows) {
    const id = listingId(row.id);
    if (id === "") continue;
    const distance = parseDistanceKm(row.location);
    const marks = [
      /\bVB\b/i.test(row.price) ? "VB" : "",
      /verschenken/i.test(row.price) ? "zu verschenken" : "",
      row.shipping ? "Versand möglich" : "",
    ].filter((one) => one !== "");
    const seller = [row.description, marks.join(", ")].filter((one) => one !== "").join(" · ");
    out.push({
      id, source, spec: spec.id, kind: "ad",
      price: germanPrice(row.price), currency: "EUR",
      title: field(row.title, TITLE_MAX),
      seller_text: field(seller, SELLER_TEXT_MAX),
      url: link(row.url),
      ...(distance === null ? {} : { distance_km: distance }),
      seller_kind: row.commercial ? "commercial" : "private",
      location: field(row.location, LOCATION_MAX),
    });
  }
  return out;
}

export const kleinanzeigen: Source = { source, board, fetch, parse, pageLooksLikeResults };
