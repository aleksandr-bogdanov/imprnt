/**
 * Norman (norman.finance) transaction-dump connector.
 *
 * Input is ONE JSON file: an array of raw transaction objects exactly as
 * `GET /companies/<id>/accounting/transactions/` returns them (the dump is
 * fetched day by day because the API ignores `limit` and caps at 20 rows).
 * The connector never talks to Norman — it reads the archived dump, so the
 * import is reproducible and Norman stays strictly read-only.
 *
 * Semantics (derived from the norman plugin's API notes + decided.json):
 *   - `publicId` is Norman's transaction uuid — the dedup disambiguator, so a
 *     re-dump of the same books dedups against the first import.
 *   - `amount` is signed Norman-style: expense negative, inflow positive —
 *     already kopeika's convention, no sign flip.
 *   - zero-amount rows are card authorisation holds with no financial effect;
 *     they are skipped (and counted).
 *   - the category arrives as an object (`{name, ...}`), a bare name, or a
 *     bare uuid. Names map via the fixed Norman category set; uuids resolve
 *     via an optional uuid -> key map (the norman plugin's rules.json
 *     "categories" table, passed with --category-map). An unknown category
 *     leaves the row undisposed and it queues — never guessed.
 *   - a row carrying `categoryMetadata.amortization` is an ACTIVATED ASSET
 *     (Norman's AfA path, e.g. a workstation with usefulLifetime set).
 *     Importing it as an expense would double-count against the AfA claim
 *     from profiles/<who>/assets.json, so it maps to the neutral
 *     `asset_purchase` category and the asset itself belongs in assets.json.
 *
 * These are BOOK rows duplicating bank rows the household ledger already has:
 * they import with household category "Exclude" so the family analytics never
 * see them; the tax face reads them through the tax axis.
 */

/** Norman's category display names -> the norman plugin's short keys. */
const NORMAN_NAME_TO_KEY: ReadonlyMap<string, string> = new Map([
  ["Software", "software"],
  ["Equipment", "equipment"],
  ["Office supplies", "office"],
  ["Meals", "meals"],
  ["Transportation", "transport"],
  ["Education", "education"],
  ["Personal", "personal"],
  ["Services", "services"],
  ["Capital contribution", "capital"],
]);

/**
 * Norman short keys -> pack tax categories. `meals` stays GROSS — the EÜR
 * builder does the 70/30 Bewirtung split at report time. `services` is the
 * revenue side (payouts). `capital`/`personal` are neutral: on the books for
 * completeness, in no total.
 */
const NORMAN_KEY_TO_PACK: ReadonlyMap<string, string> = new Map([
  ["software", "software"],
  ["equipment", "equipment_gwg"],
  ["office", "office"],
  ["meals", "meals"],
  ["transport", "transport"],
  ["education", "education"],
  ["services", "revenue"],
  ["capital", "capital_contribution"],
  ["personal", "personal"],
]);

export interface NormanRow {
  /** Norman transaction uuid (publicId) — the dedup disambiguator. */
  normanId: string;
  date: string; // ISO YYYY-MM-DD from valueDate
  /** The transaction description (Norman has no separate merchant field). */
  merchant: string;
  /** Signed per Norman = per kopeika: expense negative, inflow positive. */
  amount: number;
  currency: string;
  /** Pack tax category key, "" when the Norman category resolved to nothing. */
  taxCategory: string;
  /** The Norman category as the dump carried it ("" = uncategorized). */
  normanCategory: string;
  /** Row carries amortization metadata — an activated asset (AfA path). */
  activatedAsset: boolean;
  verified: boolean;
}

export interface NormanParseResult {
  rows: NormanRow[];
  /** Zero-amount card authorisation holds, skipped. */
  skippedZeroAmount: number;
}

/**
 * Parse a Norman transaction dump. `uuidToKey` is the optional uuid -> short
 * key table for dumps that carry category ids instead of names.
 */
export function parseNormanDump(
  text: string,
  uuidToKey?: ReadonlyMap<string, string>,
): NormanParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`norman-dump: not valid JSON (${(e as Error).message})`);
  }
  // The dump is a plain array; a verbatim API page ({results: [...]}) also reads.
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.results)
      ? ((raw as Record<string, unknown>).results as unknown[])
      : null;
  if (list === null) {
    throw new Error("norman-dump: expected a JSON array of transaction objects (or {results: [...]})");
  }

  const rows: NormanRow[] = [];
  let skippedZeroAmount = 0;
  for (const [i, item] of list.entries()) {
    if (typeof item !== "object" || item === null) {
      throw new Error(`norman-dump: entry ${i} is not an object`);
    }
    const r = item as Record<string, unknown>;
    const normanId = String(r.publicId ?? "");
    if (normanId === "") {
      throw new Error(`norman-dump: entry ${i} has no publicId`);
    }
    const date = String(r.valueDate ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`norman-dump: ${normanId}: bad or missing valueDate "${String(r.valueDate ?? "")}"`);
    }
    const amount = Number(r.amount);
    if (!Number.isFinite(amount)) {
      throw new Error(`norman-dump: ${normanId}: non-numeric amount "${String(r.amount)}"`);
    }
    if (amount === 0) {
      skippedZeroAmount += 1; // card authorisation hold — no financial effect
      continue;
    }

    const { key, display } = resolveCategory(r.category, uuidToKey);
    const activatedAsset = hasAmortization(r.categoryMetadata);
    // An activated asset must not land as an expense (the AfA claim from
    // assets.json is the deductible path) — it books neutral, visibly.
    const taxCategory = activatedAsset ? "asset_purchase" : key !== "" ? (NORMAN_KEY_TO_PACK.get(key) ?? "") : "";

    rows.push({
      normanId,
      date,
      merchant: String(r.description ?? ""),
      amount,
      currency: String(r.currency ?? "") || "EUR",
      taxCategory,
      normanCategory: display,
      activatedAsset,
      verified: String(r.userStatus ?? "") === "VERIFIED",
    });
  }
  return { rows, skippedZeroAmount };
}

/** Resolve the dump's category field (object | name | uuid | null) to a short key. */
function resolveCategory(
  cat: unknown,
  uuidToKey?: ReadonlyMap<string, string>,
): { key: string; display: string } {
  if (cat === null || cat === undefined) return { key: "", display: "" };
  if (typeof cat === "object") {
    const c = cat as Record<string, unknown>;
    const name = String(c.name ?? "");
    const byName = NORMAN_NAME_TO_KEY.get(name);
    if (byName !== undefined) return { key: byName, display: name };
    for (const idField of ["publicId", "id", "uuid"]) {
      const id = String(c[idField] ?? "");
      const byUuid = id !== "" ? uuidToKey?.get(id) : undefined;
      if (byUuid !== undefined) return { key: byUuid, display: name !== "" ? name : id };
    }
    return { key: "", display: name };
  }
  const s = String(cat);
  const byUuid = uuidToKey?.get(s);
  if (byUuid !== undefined) return { key: byUuid, display: s };
  const byName = NORMAN_NAME_TO_KEY.get(s);
  if (byName !== undefined) return { key: byName, display: s };
  return { key: "", display: s };
}

/** True when categoryMetadata carries an amortization object (Norman's AfA). */
function hasAmortization(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const am = (meta as Record<string, unknown>).amortization;
  return typeof am === "object" && am !== null;
}
