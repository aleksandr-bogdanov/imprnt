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
  match: "substring" | "regex" | "exact";
  field: "merchant_raw" | "note" | "account";
  category: string;
  /** Optional account scope: rule only fires on rows of this account. */
  account: string;
  note: string;
  regex: RegExp | null;
}

export interface TaxPin {
  category: string;
  note: string;
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
   */
  accounts: Record<string, "dedicated" | "mixed">;
}

export interface Person {
  profile: PersonProfile;
  rules: TaxRule[];
  pins: Map<string, TaxPin>;
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
  const accounts: Record<string, "dedicated" | "mixed"> = {};
  for (const [acc, mode] of Object.entries((rawProfile.accounts ?? {}) as Record<string, unknown>)) {
    const m = String(mode);
    if (m !== "dedicated" && m !== "mixed") {
      throw new Error(`${profilePath}: account "${acc}" mode must be dedicated|mixed (got "${m}")`);
    }
    accounts[acc] = m;
  }
  const profile: PersonProfile = {
    slug,
    name: String(rawProfile.name ?? slug),
    pack: String(rawProfile.pack ?? "de"),
    identity: isRecord(rawProfile.identity) ? asStringRecord(rawProfile.identity) : {},
    accounts,
  };

  return {
    profile,
    rules: loadTaxRules(join(dir, "rules.json")),
    pins: loadPins(join(dir, "pins.json")),
    dir,
  };
}

function loadTaxRules(path: string): TaxRule[] {
  if (!existsSync(path)) return [];
  const raw = readJson(path);
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  return list.map((r: Record<string, unknown>, i: number) => {
    const match = String(r.match ?? "substring");
    if (match !== "substring" && match !== "regex" && match !== "exact") {
      throw new Error(`${path}: rule ${i}: invalid match "${match}"`);
    }
    const field = String(r.field ?? "merchant_raw");
    if (field !== "merchant_raw" && field !== "note" && field !== "account") {
      throw new Error(`${path}: rule ${i}: invalid field "${field}"`);
    }
    const pattern = String(r.pattern ?? "");
    const category = String(r.category ?? "");
    if (pattern === "" || category === "") {
      throw new Error(`${path}: rule ${i}: pattern and category are required`);
    }
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
      account: String(r.account ?? ""),
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
export function taxRuleMatches(rule: TaxRule, tx: Transaction): boolean {
  if (rule.account !== "" && tx.account !== rule.account) return false;
  const value = tx[rule.field];
  switch (rule.match) {
    case "substring":
      return value.toLowerCase().includes(rule.pattern.toLowerCase());
    case "exact":
      return value === rule.pattern;
    case "regex":
      return rule.regex!.test(value);
  }
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
