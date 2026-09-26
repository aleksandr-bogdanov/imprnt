import type { Listing, WatchSpec } from "../evaluate.ts";
import { field, WatchRefused } from "../record.ts";

/**
 * What the three hunt sources share on the wire: one user agent, one deadline
 * per request, one polite pause, and the small text helpers a page needs.
 *
 * A source is a program with no hands: `fetch` takes its `fetch` from the
 * caller so a check hands in a fake and nothing ever dials out, and `parse` is
 * pure over the bytes it was handed. Every string a page said passes `field()`
 * on its way into a listing, and nothing else from the page survives.
 */

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** One browser string for every request of every source. */
export const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** How long one request may take. This runtime's `fetch` has no deadline of its own. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** The pause between two requests of one source, so a tick reads like a person and not a crawler. Zero in a check. */
export const POLITE_PAUSE_MS = 1_200;

export interface FetchContext {
  fetch: Fetch;
  now: () => Date;
  /** The pause between requests of one source. Absent means `POLITE_PAUSE_MS`. */
  pauseMs?: number;
  /** One tick's memory, so a firehose asked for by several specs is read once. */
  memo?: Map<string, Promise<unknown>>;
}

export interface Fetched {
  raw: unknown;
  url: string;
  /** False when part of what the source reads could not be read, so a sweep removes nothing. */
  complete: boolean;
}

export interface Source {
  source: string;
  /**
   * Whether a spec's fetch is page one of a query, a BOARD: zero listings
   * where the sheet still holds this spec's rows is then a failed fetch and
   * never an empty market. An interest term over a firehose is not a board,
   * because a term that matches nothing today is an ordinary day.
   */
  board: boolean;
  fetch(spec: WatchSpec, ctx: FetchContext): Promise<Fetched>;
  parse(raw: unknown, spec: WatchSpec): Listing[];
  /** Whether the raw page carries listing markers, so zero parsed is a markup change and never an empty market. */
  pageLooksLikeResults(raw: unknown): boolean;
}

/** The caps SPEC section 5 asks of a watcher record, one per field. */
export const TITLE_MAX = 160;
export const SELLER_TEXT_MAX = 400;
export const LOCATION_MAX = 80;
export const ID_MAX = 64;

export const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

export function decodeEntities(s: string): string {
  return String(s ?? "")
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&#(\d+);?/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; } })
    .replace(/&euro;/g, "€").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export const stripTags = (s: string): string =>
  decodeEntities(String(s ?? "").replace(/<[^>]*>/g, " ")).replace(/​/g, "").replace(/\s+/g, " ").trim();

/**
 * A German price string ("1.234,56 €", "52,47€", "200 €") to a number, or
 * null. The thousands dot goes, the decimal comma becomes a point.
 */
export function germanPrice(text: unknown): number | null {
  if (text == null || text === "") return null;
  if (typeof text === "number") return Number.isFinite(text) ? text : null;
  const found = String(text).match(/\d[\d.]*(?:,\d+)?/);
  if (!found) return null;
  const n = Number(found[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** A dollar price string ("$1,299.00", "349") to a number, or null. */
export function dollarPrice(text: unknown): number | null {
  if (text == null || text === "") return null;
  if (typeof text === "number") return Number.isFinite(text) ? text : null;
  const digits = String(text).replace(/[^\d.]/g, "");
  if (digits === "") return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * One GET, bounded, with the one user agent. A non-2xx answer and a network
 * failure are both refusals: nothing is posted and the state is as the last
 * tick left it, because an empty answer from a walled page is not an empty
 * market. The detail carries the status or the failure's class, never a byte
 * of the page.
 */
export async function getText(ctx: FetchContext, url: string, accept: string, language = "de-DE,de;q=0.9,en;q=0.8"): Promise<string> {
  let answer: Response;
  try {
    answer = await ctx.fetch(url, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept, "accept-language": language },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new WatchRefused("fetch", "operation failed", `${new URL(url).host} could not be asked: ${field((error as Error).message, 120)}`);
  }
  if (!answer.ok) throw new WatchRefused("fetch", "operation failed", `${new URL(url).host} answered ${answer.status}`);
  return await answer.text();
}

/** A listing id as a key: closed, capped, and never empty. */
export function listingId(value: unknown): string {
  return field(value, ID_MAX);
}

export { field };
