// imprnt · kleinanzeigen plugin — on-demand ad-detail capture.
//
// ONE plain HTTPS GET of the public ad page (server-rendered, no auth — the same discipline as search).
// Captures the seller rating ("TOP Zufriedenheit", Antwortrate, Aktiv seit, ...) plus the ad metadata
// into market/ads/<adId>.json. Run before contacting a seller. NOT auto-run by `contact`, and never
// part of the bulk watch refresh.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SEARCH_UA, MARKET, decodeEntities, stripHtml, loadListingsIndex, extractAdId } from "./search.ts";

const ADS_DIR = join(MARKET, "ads");

export type AdDetail = {
  title: string;
  price: string;
  location: string;
  posted: string;
  description: string;
  seller_name: string;
  seller_id: string;
  seller_type: string;
  zufriedenheit: string;
  antwortrate: string;
  antwortzeit: string;
  aktiv_seit: string;
  attributes: Record<string, string>;
  images: string[];
};

type FetchHtmlResult = { ok: boolean; status?: number; html: string; error?: string };

async function fetchHtml(url: string): Promise<FetchHtmlResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": SEARCH_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, html: "" };
    return { ok: true, status: res.status, html: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, html: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

// Escape regex metacharacters in a label before we splice it into a `new RegExp` — a German label can
// carry a `.` or `(` that would otherwise change the pattern's meaning.
const reEsc = (s: string): string => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function metaContent(html: string, prop: string): string {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${reEsc(prop)}["'][^>]*>`, "i"));
  if (!tag) return "";
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() : "";
}

type JsonLd = { "@type"?: string; "@graph"?: JsonLd[]; offers?: unknown; name?: unknown; description?: unknown };

function jsonLdBlocks(html: string): JsonLd[] {
  const blocks: JsonLd[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { blocks.push(JSON.parse(m[1].trim()) as JsonLd); } catch { /* skip a non-JSON block */ }
  }
  return blocks;
}

function findProduct(blocks: JsonLd[]): JsonLd {
  for (const b of blocks) {
    if (!b) continue;
    if (b["@type"] === "Product") return b;
    if (Array.isArray(b["@graph"])) {
      const p = b["@graph"].find((g) => g && g["@type"] === "Product");
      if (p) return p;
    }
  }
  return {};
}

// The first text node anywhere that CONTAINS the word — used for the seller's "TOP Zufriedenheit" badge,
// which isn't a labelled key/value pair but a standalone span.
function textNodeContaining(html: string, word: string): string {
  const m = html.match(new RegExp(`>\\s*([^<>]*${reEsc(word)}[^<>]*)<`, "i"));
  return m ? stripHtml(m[1]) : "";
}

// The value that follows a label: try the same text node's inline tail first ("Antwortrate: 100 %"),
// then fall back to the next non-empty element. Scoped to a small window after the label match.
function valueAfter(html: string, label: string, span = 240): string {
  const hit = html.match(new RegExp(reEsc(label), "i"));
  if (!hit || hit.index === undefined) return "";
  const end = hit.index + hit[0].length;
  const region = html.slice(end, end + span);
  const inline = region.match(/^[\s:]*([^<>]+?)\s*</);
  if (inline) {
    const t = stripHtml(inline[1]);
    if (t) return t;
  }
  for (const m of region.matchAll(/>\s*([^<>]+?)\s*</g)) {
    const t = stripHtml(m[1]);
    if (t) return t;
  }
  return "";
}

export function parseAdDetail(html: string): AdDetail {
  const prod = findProduct(jsonLdBlocks(html));
  const offer = (Array.isArray(prod.offers) ? prod.offers[0] ?? {} : prod.offers ?? {}) as { price?: string | number };
  const attributes: Record<string, string> = {};
  const attrRe = /addetailslist--detail">\s*((?:(?!addetailslist--detail")[\s\S])*?)<span class="addetailslist--detail--value"[^>]*>([\s\S]*?)<\/span>/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(html))) {
    const k = stripHtml(am[1]);
    const v = stripHtml(am[2]);
    if (k) attributes[k] = v;
  }
  const images: string[] = [];
  const og = metaContent(html, "og:image");
  if (og) images.push(og);
  const sellerType = /Gewerbliche?r? (Nutzer|Anbieter|Händler|Haendler|Verkäufer)/i.test(html)
    ? "gewerblich"
    : /Privater (Nutzer|Anbieter|Verkäufer|Verkaeufer)/i.test(html)
      ? "privat"
      : "";
  return {
    title: stripHtml(html.match(/id=["']viewad-title["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? "") || metaContent(html, "og:title") || String(prod.name ?? ""),
    price: stripHtml(html.match(/id=["']viewad-price["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? "") || (offer.price ? `${offer.price} €` : ""),
    location: stripHtml(html.match(/id=["']viewad-locality["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? ""),
    // posted: the viewad calendar span first, then the JSON-LD-ish labelled fallbacks.
    posted: stripHtml(html.match(/id=["']viewad-extra-info["'][\s\S]*?icon-calendar[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") || valueAfter(html, "Erstellungsdatum") || valueAfter(html, "Online seit"),
    description: stripHtml(html.match(/id=["']viewad-description-text["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "") || String(prod.description ?? ""),
    // seller_name: match off the END of the userprofile-vip class, an <a> first then a bare-text fallback.
    seller_name: stripHtml(html.match(/userprofile-vip"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "") || stripHtml(html.match(/userprofile-vip"[^>]*>\s*([^<]+?)\s*</i)?.[1] ?? ""),
    seller_id: html.match(/s-bestandsliste\.html\?userId=(\d+)/)?.[1] ?? "",
    seller_type: sellerType,
    zufriedenheit: textNodeContaining(html, "Zufriedenheit"),
    antwortrate: valueAfter(html, "Antwortrate"),
    antwortzeit: valueAfter(html, "Antwortzeit"),
    aktiv_seit: valueAfter(html, "Aktiv seit"),
    attributes,
    images,
  };
}

export async function cmdDetail(args: string[]): Promise<number> {
  let asJson = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--json") { asJson = true; continue; }
    positional.push(a);
  }
  const target = positional[0];
  if (!target) {
    console.error("usage: detail <adId-or-url> [--json]");
    console.error("  Fetches ONE public ad page and captures the seller rating + metadata into market/ads/<adId>.json.");
    return 1;
  }
  let url = "";
  let adId = "";
  if (/^https?:\/\//i.test(target)) {
    url = target.split("#")[0];
    adId = extractAdId(target) ?? "";
  } else {
    adId = extractAdId(target) ?? "";
    if (!adId) {
      console.error(`detail: couldn't read an ad id from "${target}"`);
      return 1;
    }
    const known = loadListingsIndex().get(String(adId));
    if (known?.url) url = known.url;
  }
  if (!adId) {
    console.error(`detail: couldn't read an ad id from "${target}"`);
    return 1;
  }
  if (!url) {
    console.error(`detail: no URL known for ad ${adId}. The market store hasn't seen it — pass the full ad URL instead.`);
    return 1;
  }
  const r = await fetchHtml(url);
  if (!r.ok) {
    console.error(`detail: fetch failed (${r.status || "error"}${r.error ? " " + r.error : ""}).\n  URL: ${url}`);
    return 1;
  }
  const parsed = parseAdDetail(r.html);
  const fetchedAt = new Date().toISOString();
  mkdirSync(ADS_DIR, { recursive: true });
  const adPath = join(ADS_DIR, `${adId}.json`);
  type HistoryEntry = { at?: string; price?: string; description?: string };
  type PriorRecord = { fetchedAt?: string; price?: string; description?: string; history?: HistoryEntry[] };
  let prior: PriorRecord | null = null;
  if (existsSync(adPath)) {
    try { prior = JSON.parse(readFileSync(adPath, "utf8")) as PriorRecord; } catch { /* a corrupt prior is just no prior */ }
  }
  const history: HistoryEntry[] = Array.isArray(prior?.history) ? prior.history : [];
  if (prior && (prior.price !== parsed.price || prior.description !== parsed.description)) {
    history.push({ at: prior.fetchedAt, price: prior.price, description: prior.description });
  }
  const record = { adId, url, fetchedAt, ...parsed, history };
  writeFileSync(adPath, JSON.stringify(record, null, 2) + "\n");
  if (asJson) {
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  console.log(`detail: ad ${adId} captured -> market/ads/${adId}.json`);
  console.log(`  ${parsed.title || "(no title)"}`);
  if (parsed.price) console.log(`  price: ${parsed.price}`);
  if (parsed.location) console.log(`  location: ${parsed.location}`);
  console.log(`  seller: ${parsed.seller_name || "?"}${parsed.seller_type ? ` (${parsed.seller_type})` : ""}`);
  if (parsed.zufriedenheit) console.log(`  Zufriedenheit: ${parsed.zufriedenheit}`);
  if (parsed.antwortrate) console.log(`  Antwortrate: ${parsed.antwortrate}`);
  if (parsed.antwortzeit) console.log(`  Antwortzeit: ${parsed.antwortzeit}`);
  if (parsed.aktiv_seit) console.log(`  Aktiv seit: ${parsed.aktiv_seit}`);
  const attrN = Object.keys(parsed.attributes || {}).length;
  if (attrN) console.log(`  ${attrN} attribute(s): ${Object.entries(parsed.attributes).map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 200)}`);
  if (!parsed.seller_name && !parsed.zufriedenheit && !attrN) console.error("  (no seller box / attributes parsed — selectors may need pinning against this page; raw HTML fetched OK)");
  return 0;
}
