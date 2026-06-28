// imprnt · kleinanzeigen plugin — the deal-watcher.
//
// Saved searches live in market/searches.json; `watch run` re-runs each one's SEARCH PAGE (bulk, one
// wire crossing per search), writes a new timestamped snapshot, diffs it against the previous snapshot
// for that search, and ships a deal digest through the same deliver() channel as the inbox notify.
// Change detection (new / price-drop / gone) is pure local arithmetic over the search rows — no per-ad
// detail fetch in the bulk path.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MARKET, searchUrl, fetchSearchHttp, searchId, newestSnapshot, toSnapshotListing,
  writeSnapshot, upsertListings, listSnapFiles, type SnapshotListing,
} from "./search.ts";
import { deliver } from "./notify.ts";

export type SavedSearch = {
  id: string; query: string; location: string;
  minPrice: number | null; maxPrice: number | null; addedAt: string;
};
type WatchFile = { searches: SavedSearch[] };

type DroppedListing = SnapshotListing & { oldPrice: string; oldPriceNum: number | null };
export type SnapshotDiff = { added: SnapshotListing[]; dropped: DroppedListing[]; gone: SnapshotListing[] };

type RefreshOk = { ok: true; id: string; query: string; location: string; count: number; firstRun: boolean; diff: SnapshotDiff };
type RefreshFail = { ok: false; id: string; query: string; location: string; error: string };
type RefreshResult = RefreshOk | RefreshFail;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function watchPath(): string {
  return join(MARKET, "searches.json");
}

export function readWatches(): WatchFile {
  const p = watchPath();
  if (!existsSync(p)) return { searches: [] };
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { searches?: SavedSearch[] };
    return { searches: Array.isArray(j.searches) ? j.searches : [] };
  } catch {
    return { searches: [] };
  }
}

export function writeWatches(w: WatchFile): void {
  mkdirSync(MARKET, { recursive: true });
  writeFileSync(watchPath(), JSON.stringify(w, null, 2) + "\n");
}

// Diff two snapshots by adId: present-in-next-not-prev = added; cheaper-in-next = dropped (carries the
// old price for the digest); present-in-prev-not-next = gone.
export function diffSnapshots(prev: { listings?: SnapshotListing[] } | null, next: { listings?: SnapshotListing[] } | null): SnapshotDiff {
  const prevMap = new Map((prev?.listings ?? []).map((l) => [String(l.adId), l]));
  const nextMap = new Map((next?.listings ?? []).map((l) => [String(l.adId), l]));
  const added: SnapshotListing[] = [];
  const dropped: DroppedListing[] = [];
  const gone: SnapshotListing[] = [];
  for (const [adId, l] of nextMap) {
    const p = prevMap.get(adId);
    if (!p) { added.push(l); continue; }
    if (l.priceNum != null && p.priceNum != null && l.priceNum < p.priceNum) dropped.push({ ...l, oldPrice: p.price, oldPriceNum: p.priceNum });
  }
  for (const [adId, l] of prevMap) if (!nextMap.has(adId)) gone.push(l);
  return { added, dropped, gone };
}

// A null-priced listing is in-band only when there's no lower bound to fall under.
export function inBand(priceNum: number | null, minPrice: number | null, maxPrice: number | null): boolean {
  if (priceNum == null) return minPrice == null;
  if (minPrice != null && priceNum < minPrice) return false;
  if (maxPrice != null && priceNum > maxPrice) return false;
  return true;
}

export function filterDiffByBand(diff: SnapshotDiff, minPrice: number | null, maxPrice: number | null): SnapshotDiff {
  if (minPrice == null && maxPrice == null) return diff;
  const keep = (l: SnapshotListing) => inBand(l.priceNum, minPrice, maxPrice);
  return { added: diff.added.filter(keep), dropped: diff.dropped.filter(keep), gone: diff.gone.filter(keep) };
}

async function refreshSearch(s: SavedSearch): Promise<RefreshResult> {
  const url = searchUrl(s.query, s.location);
  if (!url) return { ok: false, id: s.id, query: s.query, location: s.location, error: "empty keyword" };
  const result = await fetchSearchHttp(url);
  if (!result.ok || result.listings.length === 0) {
    return {
      ok: false, id: s.id, query: s.query, location: s.location,
      error: result.ok ? "0 listings (consent/bot wall or IP-range block)" : `http ${result.status || "error"}${result.error ? " " + result.error : ""}`,
    };
  }
  const id = searchId(s.location, s.query);
  const prev = newestSnapshot(id);
  const fetchedAt = new Date().toISOString();
  // Store the FULL, unfiltered result set so this stream stays apples-to-apples with interactive
  // `search` (which also writes unfiltered) — the price band is a digest filter, not a snapshot filter.
  const listings = result.listings.map(toSnapshotListing);
  writeSnapshot(id, { query: s.query, location: s.location || "DE", url, fetchedAt, listings });
  upsertListings(listings, fetchedAt);
  const diff = filterDiffByBand(diffSnapshots(prev, { listings }), s.minPrice ?? null, s.maxPrice ?? null);
  return { ok: true, id, query: s.query, location: s.location, count: listings.length, firstRun: !prev, diff };
}

function dealLine(l: SnapshotListing): string {
  const price = l.price || (l.priceNum != null ? `${l.priceNum} €` : "—");
  return `${price} · ${l.title} #${l.adId}${l.url ? ` ${l.url}` : ""}`;
}

export function composeDealDigest(results: RefreshResult[]): string {
  const ok = results.filter((r): r is RefreshOk => r.ok);
  if (!ok.length) return `Kleinanzeigen deals: no searches could be refreshed (${results.map((r) => (r.ok ? "" : r.error)).filter(Boolean).join("; ") || "no saved searches"}).`;
  const totalNew = ok.reduce((n, r) => n + r.diff.added.length, 0);
  const totalDrop = ok.reduce((n, r) => n + r.diff.dropped.length, 0);
  const totalGone = ok.reduce((n, r) => n + r.diff.gone.length, 0);
  const lines = [`Kleinanzeigen deals — ${totalNew} new, ${totalDrop} price drop(s), ${totalGone} gone`];
  for (const r of ok) {
    const loc = r.location || "DE";
    if (r.firstRun) {
      lines.push("", `${r.query} [${loc}]: first snapshot, ${r.count} listing(s) (baseline, no diff yet)`);
      continue;
    }
    const d = r.diff;
    if (!d.added.length && !d.dropped.length && !d.gone.length) {
      lines.push("", `${r.query} [${loc}]: no change (${r.count} listing(s))`);
      continue;
    }
    lines.push("", `${r.query} [${loc}]: ${d.added.length} new, ${d.dropped.length} price drop, ${d.gone.length} gone`);
    for (const l of d.added) lines.push(`  NEW   ${dealLine(l)}`);
    for (const l of d.dropped) lines.push(`  DROP  ${l.oldPrice || l.oldPriceNum + " €"} -> ${dealLine(l)}`);
    for (const l of d.gone) lines.push(`  GONE  ${dealLine(l)}`);
  }
  return lines.join("\n");
}

export function parseSearchFlags(args: string[]): { location: string; minPrice: number | null; maxPrice: number | null; keyword: string } {
  let location = "";
  let minPrice: number | null = null;
  let maxPrice: number | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--location" || a === "-l") { location = args[++i] ?? ""; continue; }
    if (a.startsWith("--location=")) { location = a.slice("--location=".length); continue; }
    if (a === "--min-price") { minPrice = Number(args[++i]); continue; }
    if (a.startsWith("--min-price=")) { minPrice = Number(a.slice("--min-price=".length)); continue; }
    if (a === "--max-price") { maxPrice = Number(args[++i]); continue; }
    if (a.startsWith("--max-price=")) { maxPrice = Number(a.slice("--max-price=".length)); continue; }
    positional.push(a);
  }
  if (minPrice != null && !Number.isFinite(minPrice)) minPrice = null;
  if (maxPrice != null && !Number.isFinite(maxPrice)) maxPrice = null;
  return { location, minPrice, maxPrice, keyword: positional.join(" ").trim() };
}

export async function cmdWatch(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "add") {
    const { location, minPrice, maxPrice, keyword } = parseSearchFlags(rest);
    if (!keyword) {
      console.error('usage: watch add "<query>" [--location berlin] [--min-price N] [--max-price N]');
      return 1;
    }
    const id = searchId(location, keyword);
    const w = readWatches();
    const existing = w.searches.find((s) => s.id === id);
    if (existing) {
      if ((existing.minPrice ?? null) === minPrice && (existing.maxPrice ?? null) === maxPrice) {
        console.log(`watch: already watching "${keyword}" [${location || "DE"}] (${id}).`);
        return 0;
      }
      existing.minPrice = minPrice;
      existing.maxPrice = maxPrice;
      writeWatches(w);
      console.log(`watch: updated price band for "${keyword}" [${location || "DE"}] (${id}) — min ${minPrice ?? "—"}, max ${maxPrice ?? "—"}.`);
      return 0;
    }
    w.searches.push({ id, query: keyword, location: location || "", minPrice, maxPrice, addedAt: new Date().toISOString() });
    writeWatches(w);
    console.log(`watch: added "${keyword}" [${location || "DE"}] (${id}). ${w.searches.length} saved search(es).`);
    return 0;
  }
  if (sub === "list") {
    const w = readWatches();
    if (!w.searches.length) {
      console.log('watch: no saved searches. Add one: watch add "<query>" [--location berlin]');
      return 0;
    }
    console.log(`watch — ${w.searches.length} saved search(es):`);
    for (const s of w.searches) {
      const files = listSnapFiles(s.id);
      const newest = files.length ? newestSnapshot(s.id) : null;
      const age = newest && newest.fetchedAt ? `${Math.round((Date.now() - Date.parse(newest.fetchedAt)) / 6e4)}m ago` : "never";
      const price = [s.minPrice != null ? `min ${s.minPrice}` : "", s.maxPrice != null ? `max ${s.maxPrice}` : ""].filter(Boolean).join(", ");
      console.log(`  ${s.id}  "${s.query}" [${s.location || "DE"}]${price ? ` {${price}}` : ""} — ${files.length} snapshot(s), last ${age}`);
    }
    return 0;
  }
  if (sub === "rm") {
    const target = rest[0];
    if (!target) {
      console.error("usage: watch rm <id>");
      return 1;
    }
    const w = readWatches();
    const before = w.searches.length;
    w.searches = w.searches.filter((s) => s.id !== target && s.query !== target);
    if (w.searches.length === before) {
      console.error(`watch: no saved search matching "${target}" (use the id from watch list).`);
      return 1;
    }
    writeWatches(w);
    console.log(`watch: removed "${target}". ${w.searches.length} saved search(es) left.`);
    return 0;
  }
  if (sub === "run") {
    let onlyId = "";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--id") { onlyId = rest[++i] ?? ""; continue; }
      if (rest[i].startsWith("--id=")) { onlyId = rest[i].slice("--id=".length); continue; }
    }
    const w = readWatches();
    const targets = onlyId ? w.searches.filter((s) => s.id === onlyId || s.query === onlyId) : w.searches;
    if (!targets.length) {
      console.log(onlyId ? `watch: no saved search matching "${onlyId}".` : 'watch: no saved searches. Add one: watch add "<query>".');
      return 0;
    }
    const results: RefreshResult[] = [];
    for (let i = 0; i < targets.length; i++) {
      if (i > 0) await sleep(1500); // be a polite citizen between page fetches
      console.error(`watch run: refreshing "${targets[i].query}" [${targets[i].location || "DE"}] ...`);
      results.push(await refreshSearch(targets[i]));
    }
    const digest = composeDealDigest(results);
    const res = deliver(digest);
    if (res.channel === "cmd") console.error(`watch run: ${res.detail}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) console.error(`watch run: ${failed.length} search(es) could not refresh (${failed.map((f) => (f.ok ? "" : f.error)).join("; ")}).`);
    return res.ok ? 0 : 1;
  }
  console.error("usage: watch <add|list|rm|run>");
  console.error('  watch add "<query>" [--location berlin] [--min-price N] [--max-price N]');
  console.error("  watch list");
  console.error("  watch rm <id>");
  console.error("  watch run [--id <id>]");
  return 1;
}
