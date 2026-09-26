import type { Listing, WatchSpec } from "../evaluate.ts";
import { link } from "../record.ts";
import { field, germanPrice, getText, listingId, SELLER_TEXT_MAX, TITLE_MAX, type Fetched, type FetchContext, type Source } from "./html.ts";

/**
 * mydealz: a search page, the deal objects parsed out of its embedded JSON,
 * handed back as listings. Nothing else.
 *
 * A spec's target is `{ query }`. `page:hot` and `page:new` are the two front
 * pages, the same extractor over a different URL. An expired deal is not a
 * listing: it is filtered at parse the way a comment object is, because an
 * offer that has ended is not an offer.
 */

export const source = "mydealz";
export const board = true;

const BASE = "https://www.mydealz.de";

/** 0 means "no price" on mydealz (cashback plays, voucher threads). */
const realPrice = (v: unknown): number | null => {
  const n = germanPrice(v);
  return n != null && n > 0 ? n : null;
};

export function searchUrl(query: string): string {
  const q = String(query);
  return q.startsWith("page:") ? `${BASE}/${q.slice(5).replace(/[^a-z-]/g, "")}` : `${BASE}/search?q=${encodeURIComponent(q)}`;
}

export async function fetch(spec: WatchSpec, ctx: FetchContext): Promise<Fetched> {
  const url = searchUrl(String((spec.target as { query: string }).query));
  const raw = await getText(ctx, url, "text/html,application/xhtml+xml");
  return { raw, url, complete: true };
}

/**
 * Balance-match every JSON object that contains "threadId", keep the ones
 * carrying a temperature field, dedupe by threadId. Proven against live
 * searches on the wire.
 */
export function extractDeals(html: string): Record<string, unknown>[] {
  const out = new Map<string, Record<string, unknown>>();
  let from = 0;
  for (;;) {
    const hit = html.indexOf('"threadId"', from);
    if (hit === -1) break;
    from = hit + 10;
    let start = hit;
    let depth = 0;
    while (start >= 0) {
      const c = html[start];
      if (c === "}") depth++;
      else if (c === "{") { if (depth === 0) break; depth--; }
      start--;
    }
    if (start < 0) continue;
    let end = start;
    let d = 0;
    let inStr = false;
    let esc = false;
    for (; end < html.length; end++) {
      const c = html[end];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") d++;
      else if (c === "}") { d--; if (d === 0) { end++; break; } }
    }
    let obj: unknown;
    try { obj = JSON.parse(html.slice(start, end)); } catch { continue; }
    if (obj === null || typeof obj !== "object") continue;
    const deal = obj as Record<string, unknown>;
    if (deal.threadId == null || deal.temperature === undefined) continue;
    out.set(String(deal.threadId), deal);
  }
  return [...out.values()];
}

const merchantName = (m: unknown): string =>
  !m ? "" : typeof m === "string" ? m : String((m as { merchantName?: string; name?: string }).merchantName ?? (m as { name?: string }).name ?? "");

const dealUrl = (d: Record<string, unknown>): string =>
  d.titleSlug ? `${BASE}/deals/${String(d.titleSlug)}-${String(d.threadId)}` : `${BASE}/deals/${String(d.threadId)}`;

/**
 * Deal objects on the page and none extracted is a markup change. A page whose
 * every extracted deal is expired parses to nothing and is an empty market
 * saying so in its own words, so it is not this.
 */
export function pageLooksLikeResults(raw: unknown): boolean {
  return typeof raw === "string" && raw.includes('"threadId"') && extractDeals(raw).length === 0;
}

export function parse(raw: unknown, spec: WatchSpec): Listing[] {
  const out: Listing[] = [];
  for (const d of extractDeals(typeof raw === "string" ? raw : "")) {
    if (d.isExpired === true) continue;
    const id = listingId(d.threadId);
    if (id === "") continue;
    const temperature = typeof d.temperature === "number" ? d.temperature : germanPrice(d.temperature);
    const nextBest = realPrice(d.nextBestPrice);
    const seller = [
      merchantName(d.merchant),
      d.voucherCode ? `code ${String(d.voucherCode)}` : "",
      nextBest === null ? "" : `next best ${nextBest} EUR`,
      d.shipping && typeof d.shipping === "object" && germanPrice((d.shipping as { price?: unknown }).price) != null
        ? `shipping ${germanPrice((d.shipping as { price?: unknown }).price)} EUR` : "",
    ].filter((one) => one !== "").join(" · ");
    out.push({
      id, source, spec: spec.id, kind: "deal",
      price: realPrice(d.price), currency: "EUR",
      title: field(d.title, TITLE_MAX),
      seller_text: field(seller, SELLER_TEXT_MAX),
      url: link(dealUrl(d)),
      ...(temperature === null ? {} : { temperature }),
    });
  }
  return out;
}

export const mydealz: Source = { source, board, fetch, parse, pageLooksLikeResults };
