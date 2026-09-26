/**
 * The one evaluator of a hunt: every listing of every tick is sorted here into
 * drop, notify or triage, in code, and nowhere else (SPEC section 5).
 *
 * A DROP CAN ONLY EVER CARRY A RULE THE SPEC STATED. The closed set is the
 * hard rules, the word `seen`, and, on the tripwire lane, the name of the
 * notify predicate the spec wrote a number for. `drop()` below refuses any
 * other word, so there is no string a caller can pass to make a listing
 * disappear for a reason that is not a number in a file. A rule that hides a
 * real find is worse than a model turn.
 *
 * The order, per listing:
 *   1. the hard rules, in enum order. The first failure drops with the rule's
 *      name and the number it lost by. A listing that does not carry the fact
 *      a rule needs PASSES the rule: an unknown price is not a price above the
 *      ceiling, and dropping on what is not known is judgment.
 *   2. the seen row. Announced at this price or lower is `seen`. A fall of five
 *      percent or more re-enters, and so does a fall of any size that crosses
 *      the spec's `price_at_or_under` line: told 270 with the line at 260, 259
 *      is the event the spec was written for, eleven euro or not. A listing
 *      declined before (never announced, or its verdict was ignore) at the
 *      same numbers is `seen` too; any other price is evaluated afresh.
 *   3. the notify predicate. True is notify. False on a tripwire drops with the
 *      predicate's own name. False or absent on a digest is triage: `price
 *      changed` when the listing re-entered by price, carrying old and new,
 *      and `no-target` on first sight.
 *
 * Pure. No I/O, no clock, no store: the seen row is what the caller read.
 */

/** One listing as a source parsed it, every string already closed by `field()`. */
export interface Listing {
  id: string;
  source: string;
  spec: string;
  kind: "ad" | "deal" | "product";
  price: number | null;
  /** The currency the price is in, as the source prints it. Absent means EUR. */
  currency?: string;
  title: string;
  seller_text: string;
  url: string;
  distance_km?: number;
  seller_kind?: "private" | "commercial";
  temperature?: number;
  record_low?: boolean;
  location?: string;
}

/** The typed hard rules a spec may state. Every value is checked by `spec.ts`. */
export interface HardRules {
  max_price?: number;
  min_price?: number;
  radius_km?: number;
  exclude?: string[];
  seller_kind?: "private" | "commercial";
  min_temperature?: number;
  wanted_ad?: boolean;
  rental_ad?: boolean;
}

/** The closed predicate set. `price_at_or_under: null` is "no ceiling, the match itself is the signal". */
export interface NotifyRules {
  price_at_or_under?: number | null;
  price_record_low?: true;
}

export type Lane = "tripwire" | "digest";

export interface WatchSpec {
  id: string;
  source: string;
  owner: string;
  lane: Lane;
  target: Record<string, unknown>;
  hard: HardRules;
  notify?: NotifyRules;
  /** Prose for the triage master. Code never reads it. */
  soft?: string[];
  note?: string;
  added?: string;
  updated?: string;
  paused?: boolean;
}

/** One row of the `watch:<entry>` sheet: what the hunt knows about a listing. */
export interface ListingState {
  spec: string;
  first_seen: string;
  last_seen: string;
  /** The price at the last sighting. */
  price: number | null;
  /** The price the person was told, or the master was asked about. Null once declined. */
  announced_price: number | null;
  announced_at: string | null;
  outcome: "drop" | "notify" | "triage";
  reason: string;
  verdict?: string;
  draft?: string;
}

export type Entry = "new" | "price-changed";

export type Verdict =
  | { bin: "drop"; rule: string; margin?: number; value?: string }
  | { bin: "notify"; entry: Entry; from?: number | null }
  | { bin: "triage"; reason: "no-target" | "price changed"; entry: Entry; from?: number | null; rule?: string; margin?: number };

type Failure = { margin?: number; value: string } | null;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Matched at a WORD START, so "heco" drops a "HECO PSM 1000" without dropping
 * a title that merely holds those letters inside a longer word. Literal, not a
 * regex, case folded, blank terms ignored. A term written with a trailing space
 * ("pc ") asks for a whole word, which keeps "PC" from eating "PCIe", honoured
 * as a trailing boundary so "Gaming PC" still matches at the end of a title.
 */
export function matchedExclude(title: string, terms: string[] | undefined): string | null {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const hay = String(title ?? "").toLowerCase();
  for (const raw of terms) {
    const whole = String(raw ?? "").toLowerCase();
    const term = whole.trim();
    if (term === "") continue;
    const tail = /\s$/.test(whole) ? "(?=$|[^\\p{L}\\p{N}])" : "";
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${tail}`, "u");
    if (re.test(hay)) return term;
  }
  return null;
}

/**
 * Anchored at the start, every alternative carrying its trailing boundary:
 * `suche` without one matched "Sucher Canon EOS", which is a viewfinder.
 */
export const WANTED_AD_RE = /^\s*(suche|gesucht|such|tausche?n?|wtb)\b/i;
export function isWantedAd(title: string): boolean {
  return WANTED_AD_RE.test(String(title ?? ""));
}

/**
 * A rental listing is not an offer to sell. Ex-rental stock being SOLD ("aus
 * Vermietung", "ehemaliges Mietgeraet") is a real sale and survives.
 */
export const RENTAL_AD_RE = /(^|[^\p{L}])(vermiet\p{L}*|miete|mieten|mietger\p{L}*|verleih\p{L}*|leihger\p{L}*|zu\s+leihen)($|[^\p{L}])/iu;
export const EX_RENTAL_RE = /(aus|ex|ehemal\p{L}*)[-\s]*(vermietung|miete|mietger\p{L}*)/iu;
export function isRentalAd(title: string): boolean {
  const text = String(title ?? "");
  if (EX_RENTAL_RE.test(text)) return false;
  return RENTAL_AD_RE.test(text);
}

/**
 * Each hard rule: null when it passes, the margin and the value when it fails.
 * `wanted_ad: false` means "a wanted ad fails": a "Suche ..." ad is somebody
 * ASKING for the thing, and it matches the keyword perfectly.
 */
const HARD: { [rule in keyof HardRules]-?: (listing: Listing, value: NonNullable<HardRules[rule]>) => Failure } = {
  max_price: (l, v) => (l.price != null && l.price > v ? { margin: round(l.price - v), value: `max ${v}` } : null),
  min_price: (l, v) => (l.price != null && l.price < v ? { margin: round(l.price - v), value: `min ${v}` } : null),
  radius_km: (l, v) => (l.distance_km != null && l.distance_km > v ? { margin: round(l.distance_km - v), value: `radius ${v} km` } : null),
  exclude: (l, terms) => { const term = matchedExclude(l.title, terms); return term ? { value: term } : null; },
  seller_kind: (l, v) => (l.seller_kind !== undefined && l.seller_kind !== v ? { value: l.seller_kind } : null),
  min_temperature: (l, v) => (l.temperature != null && l.temperature < v ? { margin: round(l.temperature - v), value: `min ${v}` } : null),
  wanted_ad: (l, v) => (v === false && isWantedAd(l.title) ? { value: "wanted ad" } : null),
  rental_ad: (l, v) => (v === false && isRentalAd(l.title) ? { value: "rental ad" } : null),
};

/** The enum order the rules run in, which is the order a drop's name is decided by. */
export const HARD_RULES = ["max_price", "min_price", "radius_km", "exclude", "seller_kind", "min_temperature", "wanted_ad", "rental_ad"] as const;

/** What each hard rule's value must look like. `spec.ts` refuses anything else. */
export const HARD_SHAPES: Record<(typeof HARD_RULES)[number], string> = {
  max_price: "number", min_price: "number", radius_km: "number", min_temperature: "number",
  exclude: "string[]", seller_kind: "private|commercial", wanted_ad: "boolean", rental_ad: "boolean",
};

const NOTIFY: { [rule in keyof NotifyRules]-?: (listing: Listing, value: NotifyRules[rule]) => boolean } = {
  price_at_or_under: (l, v) => (v == null ? true : l.price != null && l.price <= v),
  price_record_low: (l, v) => v === true && l.record_low === true,
};

export const NOTIFY_RULES = ["price_at_or_under", "price_record_low"] as const;
export const NOTIFY_SHAPES: Record<(typeof NOTIFY_RULES)[number], string> = { price_at_or_under: "number|null", price_record_low: "true" };

export const LANES: readonly Lane[] = ["tripwire", "digest"];

/** Every rule a drop may carry. Nothing else, ever. */
export const DROP_RULES: ReadonlySet<string> = new Set([...HARD_RULES, "seen", ...NOTIFY_RULES]);

/** A fall of this fraction or more re-enters an announced listing. Smaller is a bump, not a concession. */
export const DROP_MIN_FRACTION = 0.05;

function drop(rule: string, extra: { margin?: number; value?: string } = {}): Verdict {
  if (!DROP_RULES.has(rule)) throw new Error(`evaluate: a drop may only carry a stated rule, got ${JSON.stringify(rule)}`);
  return { bin: "drop", rule, ...extra };
}

/**
 * Whether a fall from `from` to `to` re-enters an announced listing: five
 * percent or more, or any fall that crosses the spec's own line.
 */
export function fallReenters(from: number | null, to: number | null, target: number | null | undefined): boolean {
  if (to == null) return false;
  if (from == null) return true;
  if (to >= from) return false;
  const crossed = target != null && Number.isFinite(target) && from > target && to <= target;
  return crossed || from - to >= from * DROP_MIN_FRACTION;
}

export function evaluate(listing: Listing, spec: WatchSpec, seen: ListingState | null): Verdict {
  const price = listing.price;

  for (const rule of HARD_RULES) {
    const value = spec.hard?.[rule];
    if (value == null) continue;
    const failed = (HARD[rule] as (l: Listing, v: unknown) => Failure)(listing, value);
    if (failed) return drop(rule, failed);
  }

  let entry: Entry = "new";
  let from: number | null | undefined;
  if (seen) {
    if (seen.announced_at != null) {
      const ref = seen.announced_price;
      if (!fallReenters(ref, price, spec.notify?.price_at_or_under)) {
        const margin = price != null && ref != null ? round(price - ref) : undefined;
        return drop("seen", { ...(margin === undefined ? {} : { margin }), value: "announced before" });
      }
      entry = "price-changed";
      from = ref;
    } else if ((seen.price ?? null) === (price ?? null)) {
      return drop("seen", { value: "declined before, unchanged" });
    } else {
      entry = "price-changed";
      from = seen.price;
    }
  }

  const reason = entry === "price-changed" ? "price changed" : "no-target";
  const notify = spec.notify;
  if (notify && typeof notify === "object") {
    for (const key of NOTIFY_RULES) {
      if (!(key in notify)) continue;
      const value = notify[key];
      if ((NOTIFY[key] as (l: Listing, v: unknown) => boolean)(listing, value)) continue;
      const margin = key === "price_at_or_under" && price != null && value != null ? round(price - (value as number)) : undefined;
      const said = margin === undefined ? {} : { margin };
      if (spec.lane === "tripwire") return drop(key, { ...said, value: `${key} ${value}` });
      return { bin: "triage", reason, entry, from, rule: key, ...said };
    }
    return { bin: "notify", entry, from };
  }
  // No notify block at all. A tripwire spec without one is refused by
  // `spec.ts`, so a digest is the only lane that reaches here.
  return { bin: "triage", reason, entry, from };
}
