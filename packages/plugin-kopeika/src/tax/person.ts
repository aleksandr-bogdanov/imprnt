/**
 * Per-person tax profile: identity, the accounts that feed the books, ratified
 * merchant rules, and pinned per-transaction decisions.
 *
 * Everything lives under profiles/<person>/ — the consolidated PII zone.
 * Committed in a remoteless private vault, gitignored the moment a remote
 * exists (check.js enforces). The shipped package carries examples only.
 *
 * The authority ladder (the Norman lesson, made structural):
 *   pins   — explicit per-transaction human decisions; nothing overrides them,
 *            and only the `decide` verb writes them.
 *   import — the source itself carried the category (DATEV SKR codes).
 *   rules  — ratified merchant regexes; they fill EMPTY dispositions only and
 *            never re-decide a row.
 * A row with no disposition on a `dedicated` account is queued for `decide`.
 * On a `mixed` account (a shared bank account) an unmatched row simply stays
 * household — only rules and pins pull rows onto the books.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Transaction } from "../types.ts";

export interface TaxRule {
  pattern: string;
  /**
   * substring / regex / exact test `pattern` against `field`. `client` ignores
   * `pattern` and fires when the row's merchant_raw is a name in the person's
   * clients.json (case- and whitespace-insensitive) — one rule books every
   * registered student's payment, and a payer the registry does not know
   * queues instead of being guessed.
   */
  match: "substring" | "regex" | "exact" | "client";
  field: "merchant_raw" | "note" | "account";
  category: string;
  /** Optional account scope: rule only fires on rows of these accounts (empty = any). */
  accounts: string[];
  /**
   * Optional lower date bound (YYYY-MM-DD, inclusive). A rule with `from` never
   * touches an earlier row. This is how a bank feed takes over from a migrated
   * book export without double-booking the overlap: the export carries the rows
   * up to the cutover, the rule claims the feed from the cutover on.
   */
  from: string;
  note: string;
  regex: RegExp | null;
}

export interface TaxPin {
  category: string;
  note: string;
}

export interface TaxAccount {
  mode: "dedicated" | "mixed";
  from: string;
}

export interface PersonProfile {
  slug: string;
  /** Display name for report headers. */
  name: string;
  /** Country pack code, default "de". */
  pack: string;
  /** Steuernummer, Rechtsform, § 19 flag etc. — identity data for exports. */
  identity: Record<string, string>;
  /**
   * Accounts feeding this person's books. dedicated: every row belongs on the
   * books, an undisposed row queues. mixed: only rules/pins claim rows.
   * `from` (YYYY-MM-DD, inclusive, "" = always) is the day a feed takes over the
   * books: rows before it never queue, so a bank feed can start where a migrated
   * export (Norman, Lexoffice) stops without re-deciding the overlap.
   */
  accounts: Record<string, TaxAccount>;
  /**
   * The raw `invoice` object from profile.json (letterhead, PayPal, logo) —
   * validated by the invoice face (src/tax/invoice.ts), null when absent.
   */
  invoice: Record<string, unknown> | null;
}

export interface Person {
  profile: PersonProfile;
  rules: TaxRule[];
  pins: Map<string, TaxPin>;
  /** Normalized client names from clients.json, what a `match: "client"` rule tests against. */
  clientNames: Set<string>;
  dir: string;
}

export function personDir(rootDir: string, slug: string): string {
  return join(rootDir, "profiles", slug);
}

/** List profile slugs that exist under profiles/ (directories with profile.json). */
export function listPersons(rootDir: string): string[] {
  const profilesDir = join(rootDir, "profiles");
  if (!existsSync(profilesDir)) return [];
  return readdirSync(profilesDir)
    .filter((entry) => {
      const dir = join(profilesDir, entry);
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, "profile.json"));
      } catch {
        return false;
      }
    })
    .sort();
}

/** Load one person's profile + rules + pins. Throws when the profile is absent. */
export function loadPerson(rootDir: string, slug: string): Person {
  const dir = personDir(rootDir, slug);
  const profilePath = join(dir, "profile.json");
  if (!existsSync(profilePath)) {
    throw new Error(
      `no tax profile for "${slug}" — expected ${profilePath}. Create it (see profiles.example/) or run the onboarding interview.`,
    );
  }
  const rawProfile = readJson(profilePath);
  const accounts: Record<string, TaxAccount> = {};
  for (const [acc, spec] of Object.entries((rawProfile.accounts ?? {}) as Record<string, unknown>)) {
    // "dedicated" | "mixed", or { "mode": ..., "from": "YYYY-MM-DD" }.
    const obj = isRecord(spec) ? spec : { mode: spec };
    const m = String(obj.mode ?? "");
    if (m !== "dedicated" && m !== "mixed") {
      throw new Error(`${profilePath}: account "${acc}" mode must be dedicated|mixed (got "${m}")`);
    }
    const from = String(obj.from ?? "");
    if (from !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new Error(`${profilePath}: account "${acc}": "from" must be YYYY-MM-DD (got "${from}")`);
    }
    accounts[acc] = { mode: m, from };
  }
  const profile: PersonProfile = {
    slug,
    name: String(rawProfile.name ?? slug),
    pack: String(rawProfile.pack ?? "de"),
    identity: isRecord(rawProfile.identity) ? asStringRecord(rawProfile.identity) : {},
    accounts,
    invoice: isRecord(rawProfile.invoice) ? rawProfile.invoice : null,
  };

  return {
    profile,
    rules: loadTaxRules(join(dir, "rules.json")),
    pins: loadPins(join(dir, "pins.json")),
    clientNames: loadClientNames(join(dir, "clients.json")),
    dir,
  };
}

function loadTaxRules(path: string): TaxRule[] {
  if (!existsSync(path)) return [];
  const raw = readJson(path);
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  return list.map((r: Record<string, unknown>, i: number) => {
    const match = String(r.match ?? "substring");
    if (match !== "substring" && match !== "regex" && match !== "exact" && match !== "client") {
      throw new Error(`${path}: rule ${i}: invalid match "${match}"`);
    }
    const field = String(r.field ?? "merchant_raw");
    if (field !== "merchant_raw" && field !== "note" && field !== "account") {
      throw new Error(`${path}: rule ${i}: invalid field "${field}"`);
    }
    const pattern = String(r.pattern ?? (match === "client" ? "*" : ""));
    const category = String(r.category ?? "");
    if (pattern === "" || category === "") {
      throw new Error(`${path}: rule ${i}: pattern and category are required`);
    }
    const from = String(r.from ?? "");
    if (from !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new Error(`${path}: rule ${i}: "from" must be YYYY-MM-DD (got "${from}")`);
    }
    const accountRaw = r.account ?? r.accounts ?? "";
    const accounts = (Array.isArray(accountRaw) ? accountRaw : [accountRaw])
      .map((a) => String(a).trim())
      .filter((a) => a !== "");
    let regex: RegExp | null = null;
    if (match === "regex") {
      try {
        regex = new RegExp(pattern, "i");
      } catch (e) {
        throw new Error(`${path}: rule ${i}: invalid regex "${pattern}": ${(e as Error).message}`);
      }
    }
    return {
      pattern,
      match,
      field,
      category,
      accounts,
      from,
      note: String(r.note ?? ""),
      regex,
    };
  });
}

function loadPins(path: string): Map<string, TaxPin> {
  const pins = new Map<string, TaxPin>();
  if (!existsSync(path)) return pins;
  const raw = readJson(path);
  for (const [txid, v] of Object.entries(raw)) {
    if (txid.startsWith("_")) continue;
    const rec = v as Record<string, unknown>;
    pins.set(txid, { category: String(rec.category ?? ""), note: String(rec.note ?? "") });
  }
  return pins;
}

/** Persist pins (the one file the tool writes in a person's folder). */
export function savePins(dir: string, pins: Map<string, TaxPin>): void {
  mkdirSync(dir, { recursive: true });
  const obj: Record<string, TaxPin> = {};
  for (const [k, v] of [...pins.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    obj[k] = v;
  }
  writeFileSync(join(dir, "pins.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** Test one tax rule against a row. */
export function taxRuleMatches(rule: TaxRule, tx: Transaction, clientNames?: Set<string>): boolean {
  if (rule.accounts.length > 0 && !rule.accounts.includes(tx.account)) return false;
  if (rule.from !== "" && tx.date < rule.from) return false;
  const value = tx[rule.field];
  switch (rule.match) {
    case "client":
      return clientNames !== undefined && clientNames.has(normClientName(tx.merchant_raw));
    case "substring":
      return value.toLowerCase().includes(rule.pattern.toLowerCase());
    case "exact":
      return value === rule.pattern;
    case "regex":
      return rule.regex!.test(value);
  }
}

/**
 * Lower-case, single-spaced, and stripped of a bank's "Transfer from" / "Payment from"
 * prefix: the equality a payer name is tested under. Revolut writes a student's
 * transfer as "Transfer from JORDAN HALE", PayPal writes the bare name.
 */
export function normClientName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(transfer|payment|topup|top-up) from /, "");
}

/** The names in clients.json (the invoice registry), normalized. Empty when the file is absent. */
function loadClientNames(path: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(path)) return names;
  const raw = readJson(path);
  for (const name of Object.keys(raw)) {
    if (name.startsWith("_")) continue;
    names.add(normClientName(name));
  }
  return names;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message})`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringRecord(v: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) out[k] = String(val);
  return out;
}
