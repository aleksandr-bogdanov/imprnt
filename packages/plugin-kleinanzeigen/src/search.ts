// imprnt · kleinanzeigen plugin — marketplace ad search + the local market mirror.
//
// SYNC-THEN-READ, the same discipline as the conversation mirror: the wire is crossed at most ONCE per
// query and the parsed rows are persisted to a local mirror under market/, then ALL display/filter/sort
// happens locally off that mirror. The fetch is cache-gated — a fresh snapshot (< 30 min) is read
// straight from disk with no web call unless --refresh forces a re-fetch. market/snapshots/<id>/<ts>.json
// is the per-query snapshot history; market/listings.jsonl is the deduped store (firstSeen/lastSeen/
// lastPrice/priceHistory per adId) that --local greps with zero network.
//
// The FETCH path: PRIMARY is a plain HTTPS GET of the public, server-rendered results page (no auth, no
// login, no JS) — Kleinanzeigen renders the listings into the HTML, so a desktop User-Agent + de-DE
// Accept-Language gets the full set without the consent iframe. The headless session-host browser
// (playwright-core) is an OPT-IN fallback via --browser only — never auto-launched, because its bot
// fingerprint is what trips KA's IP-range fraud block. Search is public, so no Bearer token.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MARKET = join(here, "market");

export const SEARCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Known city shortcuts → KA's path + location code. Anything else falls back to a generic s-<loc> path.
const SEARCH_LOCATIONS: Record<string, { path: string; code: string }> = {
  berlin: { path: "s-berlin", code: "l3331" },
};

export type SearchRow = {
  id: string; title: string; price: string; location: string; date: string;
  url: string; shipping: boolean; gewerblich: boolean;
};

// The render/filter shape, common to live snapshot rows and the local-store rows.
export type DisplayListing = {
  adId: string; title: string; price: string; priceNum: number | null;
  location: string; date: string; url: string;
};

export type SnapshotListing = DisplayListing & { shipping: boolean; gewerblich: boolean };

export type Snapshot = { query: string; location: string; url: string; fetchedAt: string; listings: SnapshotListing[] };

export type IndexEntry = {
  adId: string; title: string; location: string; url: string;
  firstSeen: string; lastSeen: string; lastPrice: string; priceNum: number | null;
  priceHistory: { price: string; at: string }[];
};

// `resultsPage` = the fetched HTML is a GENUINE results page (even one with zero hits), as opposed to
// a consent interstitial / bot-wall page. It's what lets a caller treat "truly 0 listings" as a valid,
// snapshot-worthy answer (the rare-item watch case) instead of a refresh failure.
type SearchFetchResult = { ok: boolean; status?: number; listings: SearchRow[]; resultsPage?: boolean; error?: string };

// A real results page carries the search-results scaffold (the srchrslt container ids) or KA's
// zero-hits outcome message; a consent or bot-wall page carries neither.
export function isResultsPage(html: string): boolean {
  return /srchrslt/i.test(html) || /keine\s+(Anzeigen|Ergebnisse)/i.test(html);
}

export function slugifyKeyword(kw: string): string {
  return kw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function searchUrl(keyword: string, location: string): string | null {
  const slug = slugifyKeyword(keyword);
  if (!slug) return null;
  const loc = location ? location.toLowerCase() : "";
  if (!loc) return `https://www.kleinanzeigen.de/s-${slug}/k0`;
  const known = SEARCH_LOCATIONS[loc];
  if (known) return `https://www.kleinanzeigen.de/${known.path}/${slug}/k0${known.code}`;
  if (/^l\d+$/.test(loc)) return `https://www.kleinanzeigen.de/s-${slug}/k0${loc}`;
  return `https://www.kleinanzeigen.de/s-${loc}/${slug}/k0`;
}

// Decode HTML entities. &amp; is decoded LAST so an "&amp;#39;" never double-decodes into a stray quote.
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&#(\d+);?/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; } })
    .replace(/&euro;/g, "€").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/​/g, "").replace(/\s+/g, " ").trim();
}

function firstPriceToken(s: string): string {
  const m = s.match(/\d[\d.]*\s?€(?:\s?VB)?|Zu verschenken|VB/i);
  return m ? m[0] : "";
}

export function priceToNumber(price: string | null | undefined): number | null {
  if (!price) return null;
  const m = String(price).match(/\d[\d.]*(?:,\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Parse the server-rendered results page into rows. The article-class match is broadened to
// `aditem[^"]*` so KA's modifier classes (aditem--gallery, …) still match. `shipping` is true only when
// "Versand möglich" is present AND no "Nur Abholung / kein Versand" override; `gewerblich` reads the pro
// badge hint.
export function parseSearchHtml(html: string): SearchRow[] {
  const out: SearchRow[] = [];
  const re = /<article class="aditem[^"]*"([^>]*)data-adid="(\d+)"([^>]*)>([\s\S]*?)<\/article>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const openTag = m[1] + m[3];
    const id = m[2];
    const block = m[4];
    let href = "";
    const hrefM = openTag.match(/data-href="([^"]*)"/) || block.match(/href="(\/s-anzeige\/[^"]*)"/);
    if (hrefM) href = hrefM[1];
    let title = "";
    const lj = block.match(/"title":"((?:[^"\\]|\\.)*)"/);
    if (lj) {
      try { title = JSON.parse('"' + lj[1] + '"') as string; } catch { title = lj[1]; }
    }
    if (!title) {
      const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      if (h2) title = stripHtml(h2[1]);
    }
    let price = "";
    const pe = block.match(/class="aditem-main--middle--price-shipping--price"[^>]*>([\s\S]*?)<\/p>/);
    if (pe) price = firstPriceToken(stripHtml(pe[1]));
    if (!price) {
      const pm = block.match(/\d[\d.]*\s?€(?:\s?VB)?/);
      if (pm) price = pm[0];
    }
    let location = "";
    const le = block.match(/aditem-main--top--left"[^>]*>([\s\S]*?)<\/div>/);
    if (le) location = stripHtml(le[1]);
    let date = "";
    const de = block.match(/aditem-main--top--right"[^>]*>([\s\S]*?)<\/div>/);
    if (de) date = stripHtml(de[1]);
    const shipping = /Versand möglich|Versand moeglich/i.test(block) && !/Nur Abholung|kein\w* Versand/i.test(block);
    const gewerblich = /badge-hint-pro/i.test(openTag + block);
    out.push({ id, title: decodeEntities(title).trim(), price, location, date, url: href ? "https://www.kleinanzeigen.de" + href : "", shipping, gewerblich });
  }
  return out;
}

export async function fetchSearchHttp(url: string): Promise<SearchFetchResult> {
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
    if (!res.ok) return { ok: false, status: res.status, listings: [] };
    const html = await res.text();
    const listings = parseSearchHtml(html);
    return { ok: true, status: res.status, listings, resultsPage: listings.length > 0 || isResultsPage(html) };
  } catch (e) {
    return { ok: false, status: 0, listings: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

// ── opt-in headless fallback (--browser only; the bot fingerprint trips KA's fraud block) ────────────
// playwright is the session-host plugin's dependency, reached over the filesystem (no hard import on a
// sibling plugin's code). A minimal structural type — playwright-core isn't a dependency here.
type PwLocator = { count(): Promise<number>; first(): { click(opts?: { timeout?: number }): Promise<void> } };
type PwFrame = { locator(sel: string): PwLocator };
type PwPage = {
  mainFrame(): PwFrame; frames(): PwFrame[]; waitForTimeout(ms: number): Promise<void>;
  goto(url: string, opts?: object): Promise<unknown>; waitForSelector(sel: string, opts?: object): Promise<unknown>;
  content(): Promise<string>;
};

async function dismissConsent(page: PwPage): Promise<boolean> {
  const labels = ["Alle akzeptieren", "Akzeptieren", "Zustimmen", "Einverstanden", "Accept all", "Accept"];
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    for (const label of labels) {
      try {
        const btn = frame.locator(`button:has-text("${label}")`);
        if (await btn.count()) {
          await btn.first().click({ timeout: 2000 });
          await page.waitForTimeout(800);
          return true;
        }
      } catch { /* try the next label / frame */ }
    }
  }
  return false;
}

async function fetchSearchBrowser(url: string): Promise<SearchFetchResult> {
  let chromium: {
    launchPersistentContext(dir: string, opts: object): Promise<{
      pages(): PwPage[]; newPage(): Promise<PwPage>; close(): Promise<void>;
    }>;
  };
  try {
    ({ chromium } = await import(join(here, "..", "session-host", "node_modules", "playwright-core", "index.mjs")));
  } catch {
    return { ok: false, listings: [], error: "browser fallback unavailable (session-host playwright-core not found)" };
  }
  const tmp = mkdtempSync(join(tmpdir(), "ka-search-"));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(tmp, { headless: true, channel: "chrome", chromiumSandbox: true });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissConsent(page);
    try { await page.waitForSelector("[data-adid]", { timeout: 8000 }); } catch { /* render may already be done */ }
    const html = await page.content();
    const listings = parseSearchHtml(html);
    return { ok: true, listings, resultsPage: listings.length > 0 || isResultsPage(html) };
  } catch (e) {
    return { ok: false, listings: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { if (context) await context.close(); } catch { /* ignore */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── the per-query snapshot history ───────────────────────────────────────────────────────────────────
function locSlug(location: string): string {
  const s = (location || "DE").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "de";
}

export function searchId(location: string, keyword: string): string {
  return `${locSlug(location)}__${slugifyKeyword(keyword) || "q"}`;
}

function snapDir(id: string): string {
  return join(MARKET, "snapshots", id);
}

export function listSnapFiles(id: string): string[] {
  const d = snapDir(id);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).sort();
}

function readSnapFile(id: string, file: string): Snapshot | null {
  try { return JSON.parse(readFileSync(join(snapDir(id), file), "utf8")) as Snapshot; } catch { return null; }
}

// Newest readable snapshot — iterate newest → oldest, skipping a corrupt file so one bad write never
// blinds the cache.
export function newestSnapshot(id: string): Snapshot | null {
  const files = listSnapFiles(id);
  for (let k = files.length - 1; k >= 0; k--) {
    const snap = readSnapFile(id, files[k]);
    if (snap) return snap;
  }
  return null;
}

function pruneSnapshots(id: string, keep: number): void {
  const files = listSnapFiles(id);
  if (files.length <= keep) return;
  for (const f of files.slice(0, files.length - keep)) {
    try { rmSync(join(snapDir(id), f)); } catch { /* ignore */ }
  }
}

export function writeSnapshot(id: string, data: Snapshot): void {
  const dir = snapDir(id);
  mkdirSync(dir, { recursive: true });
  const safe = String(data.fetchedAt).replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${safe}.json`), JSON.stringify(data, null, 2) + "\n");
  pruneSnapshots(id, 30);
}

export function toSnapshotListing(row: SearchRow): SnapshotListing {
  return {
    adId: row.id,
    title: row.title,
    price: row.price,
    priceNum: priceToNumber(row.price),
    location: row.location,
    date: row.date,
    url: row.url,
    shipping: !!row.shipping,
    gewerblich: !!row.gewerblich,
  };
}

// ── the deduped market store (market/listings.jsonl) ─────────────────────────────────────────────────
export function loadListingsIndex(): Map<string, IndexEntry> {
  const p = join(MARKET, "listings.jsonl");
  const map = new Map<string, IndexEntry>();
  if (!existsSync(p)) return map;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as IndexEntry;
      if (o && o.adId) map.set(String(o.adId), o);
    } catch { /* skip a corrupt line */ }
  }
  return map;
}

function writeListingsIndex(map: Map<string, IndexEntry>): void {
  mkdirSync(MARKET, { recursive: true });
  const lines = [...map.values()].map((o) => JSON.stringify(o));
  writeFileSync(join(MARKET, "listings.jsonl"), lines.length ? lines.join("\n") + "\n" : "");
}

export function upsertListings(listings: SnapshotListing[], at: string): Map<string, IndexEntry> {
  const map = loadListingsIndex();
  for (const l of listings) {
    const adId = String(l.adId);
    const prev = map.get(adId);
    if (!prev) {
      map.set(adId, {
        adId,
        title: l.title,
        location: l.location,
        url: l.url,
        firstSeen: at,
        lastSeen: at,
        lastPrice: l.price || "",
        priceNum: l.priceNum ?? null,
        priceHistory: l.price ? [{ price: l.price, at }] : [],
      });
      continue;
    }
    prev.lastSeen = at;
    if (l.title) prev.title = l.title;
    if (l.location) prev.location = l.location;
    if (l.url) prev.url = l.url;
    if (l.price && l.price !== prev.lastPrice) {
      prev.priceHistory = prev.priceHistory || [];
      prev.priceHistory.push({ price: l.price, at });
      prev.lastPrice = l.price;
      prev.priceNum = l.priceNum ?? prev.priceNum;
    } else if (l.priceNum != null && prev.priceNum == null) {
      prev.priceNum = l.priceNum;
    }
  }
  writeListingsIndex(map);
  return map;
}

// ── local filters (no network) ───────────────────────────────────────────────────────────────────────
function applyPriceFilters<T extends { priceNum: number | null }>(rows: T[], minPrice: number | null, maxPrice: number | null): T[] {
  if (minPrice == null && maxPrice == null) return rows;
  return rows.filter((r) => {
    const n = r.priceNum;
    if (n == null) return false;
    if (minPrice != null && n < minPrice) return false;
    if (maxPrice != null && n > maxPrice) return false;
    return true;
  });
}

function sortByPrice<T extends { priceNum: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const pa = a.priceNum;
    const pb = b.priceNum;
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  });
}

function titleMatches(title: string, terms: string): boolean {
  const hay = (title || "").toLowerCase();
  return terms.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

// Read a numeric ad id out of a bare id or a full ad URL (the last path segment usually leads with it).
export function extractAdId(input: string | undefined): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const last = s.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
  const lead = last.match(/^(\d{5,})/);
  if (lead) return lead[1];
  const any = s.match(/(\d{5,})/);
  return any ? any[1] : null;
}

export async function cmdSearch(args: string[]): Promise<number> {
  let location = "";
  let limit = 25;
  let asJson = false;
  let forceBrowser = false;
  let sort = "";
  let refresh = false;
  let localOnly = false;
  let minPrice: number | null = null;
  let maxPrice: number | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--location" || a === "-l") { location = args[++i] ?? ""; continue; }
    if (a.startsWith("--location=")) { location = a.slice("--location=".length); continue; }
    if (a === "--limit") { limit = Number(args[++i]) || limit; continue; }
    if (a.startsWith("--limit=")) { limit = Number(a.slice("--limit=".length)) || limit; continue; }
    if (a === "--sort") { sort = (args[++i] ?? "").toLowerCase(); continue; }
    if (a.startsWith("--sort=")) { sort = a.slice("--sort=".length).toLowerCase(); continue; }
    if (a === "--max-price") { maxPrice = Number(args[++i]); continue; }
    if (a.startsWith("--max-price=")) { maxPrice = Number(a.slice("--max-price=".length)); continue; }
    if (a === "--min-price") { minPrice = Number(args[++i]); continue; }
    if (a.startsWith("--min-price=")) { minPrice = Number(a.slice("--min-price=".length)); continue; }
    if (a === "--json") { asJson = true; continue; }
    if (a === "--browser") { forceBrowser = true; continue; }
    if (a === "--refresh") { refresh = true; continue; }
    if (a === "--local") { localOnly = true; continue; }
    positional.push(a);
  }
  if (minPrice != null && !Number.isFinite(minPrice)) minPrice = null;
  if (maxPrice != null && !Number.isFinite(maxPrice)) maxPrice = null;
  const keyword = positional.join(" ").trim();
  if (!keyword) {
    console.error('usage: node kleinanzeigen.js search "<keyword>" [--location berlin] [--limit N] [--sort price] [--min-price N] [--max-price N] [--refresh] [--json] [--browser]');
    console.error('       node kleinanzeigen.js search --local "<terms>" [--sort price] [--min-price N] [--max-price N] [--limit N] [--json]   (no web call; greps the local market store)');
    return 1;
  }
  const render = (rows: DisplayListing[], source: string): void => {
    let out = applyPriceFilters(rows, minPrice, maxPrice);
    if (sort === "price") out = sortByPrice(out);
    const shown = out.slice(0, limit);
    if (asJson) {
      console.log(JSON.stringify({ keyword, location: location || "DE", source, count: out.length, listings: shown }, null, 2));
      return;
    }
    const more = shown.length < out.length ? `, showing ${shown.length}` : "";
    console.log(`search "${keyword}" [${location || "DE"}] — ${source} — ${out.length} listing(s)${more}`);
    for (const it of shown) {
      const price = (it.price || (it.priceNum != null ? `${it.priceNum} €` : "—")).padEnd(12);
      const loc = (it.location || "—").padEnd(24);
      const date = (it.date || "—").padEnd(14);
      console.log(`  ${price} ${loc} ${date} ${it.title}  #${it.adId}`);
    }
  };
  if (localOnly) {
    const map = loadListingsIndex();
    const rows: DisplayListing[] = [...map.values()].filter((r) => titleMatches(r.title, keyword)).map((r) => ({
      adId: r.adId,
      title: r.title,
      price: r.lastPrice,
      priceNum: r.priceNum ?? null,
      location: r.location,
      date: r.lastSeen ? r.lastSeen.slice(0, 10) : "",
      url: r.url,
    }));
    if (rows.length === 0 && !asJson) console.log(`search --local "${keyword}" — local store, 0 match(es). The store fills as you run live searches (market/listings.jsonl).`);
    else render(rows, "local store");
    return 0;
  }
  const url = searchUrl(keyword, location);
  if (!url) {
    console.error("search: keyword is empty after slugify");
    return 1;
  }
  const id = searchId(location, keyword);
  const cached = newestSnapshot(id);
  const FRESH_MS = 30 * 60 * 1000;
  const ageMs = cached && cached.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : null;
  const fresh = cached && ageMs != null && ageMs >= 0 && ageMs < FRESH_MS;
  if (cached && fresh && !refresh && !forceBrowser) {
    render(cached.listings, `cache (age ${Math.round(ageMs / 6e4)}m)`);
    return 0;
  }
  let result: SearchFetchResult;
  let via = "http";
  if (forceBrowser) {
    console.error("search: --browser drives a headless automation profile, which carries a bot fingerprint (navigator.webdriver) that Kleinanzeigen's fraud system flags and can IP-block. Use only knowingly and sparingly.");
    result = await fetchSearchBrowser(url);
    via = "browser";
  } else {
    result = await fetchSearchHttp(url);
    // ok + 0 listings + a real results page = a genuinely empty result set, not a wall — no warning.
    if (!result.ok || (result.listings.length === 0 && !result.resultsPage)) {
      const why = result.ok ? "0 listings (possible consent/bot wall, or a temporary IP-range block)" : `http ${result.status || "error"}${result.error ? " " + result.error : ""}`;
      console.error(`search: direct fetch returned ${why}.`);
      console.error("  NOT auto-launching the headless browser — that automation fingerprint is what trips the IP-range fraud block. Wait the block out (or switch network), and browse in your real browser. Force the bot path only knowingly: --browser");
    }
  }
  if (!result.ok && result.listings.length === 0) {
    if (cached) {
      const staleMin = ageMs != null ? Math.round(ageMs / 6e4) : "?";
      console.error(`search: live fetch failed — falling back to the cached snapshot (age ${staleMin}m), no further web call.`);
      render(cached.listings, `stale cache (age ${staleMin}m)`);
      return 0;
    }
    console.error(`search: failed${result.error ? " — " + result.error : ""}.\n  URL: ${url}`);
    return 1;
  }
  const fetchedAt = new Date().toISOString();
  const listings = result.listings.map(toSnapshotListing);
  writeSnapshot(id, { query: keyword, location: location || "DE", url, fetchedAt, listings });
  upsertListings(listings, fetchedAt);
  render(listings, via === "browser" ? "live fetch (browser)" : "live fetch");
  return 0;
}
