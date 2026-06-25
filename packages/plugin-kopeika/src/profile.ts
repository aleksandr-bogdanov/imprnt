/**
 * User profile: every personal fact kopeika needs, kept OUT of the code.
 *
 * The code ships generic. The personal layer (your names and IBANs for
 * internal-transfer detection, the net-worth marks, the display labels and
 * merchant notes) lives in `data/profile.json`, which is gitignored alongside
 * the rest of `data/`. A committed `profile.example.json` is the template.
 *
 * Loading is forgiving: a missing file yields an empty profile, so a fresh
 * checkout runs in generic mode (no own-name matching, no net-worth layer, raw
 * merchant and account labels). Fill the profile in to light those features up.
 */

import { existsSync, readFileSync } from "node:fs";

export interface Bilingual {
  en: string;
  ru: string;
}

/** One display rule: match a raw merchant by case-insensitive substring, then
 *  show a clean `name` and a bilingual "what for" note. */
export interface MerchantInfoEntry {
  pat: string;
  name?: string;
  en?: string;
  ru?: string;
}

/** Net-worth marks: facts about the world, not ledger rows. RUB/CNY nominals
 *  are converted to EUR with the rates in data/rates.csv at render time. */
export interface NetWorthMarks {
  /** Total market value of owned property, in RUB. */
  flatsRub: number;
  /** Current outstanding mortgage balance, in RUB (carried flat, subtracted). */
  mortgageRub: number;
  /** Nominal of a held structured note, in CNY (held flat). 0 to omit. */
  bcsNominalCny: number;
  /** Annual property appreciation rate, e.g. 0.08 for 8%/yr compound. */
  propertyApr: number;
}

export interface Profile {
  /** Allowed `--owner` labels. Empty means accept any non-empty owner. */
  owners: string[];
  /** Your own names, for internal-transfer detection in the connectors. */
  ownNames: string[];
  /** Your own IBANs, same purpose. */
  ownIbans: string[];
  /** Dashboard footer suffix ("for ..."). Omit to show just "kopeika". */
  footer?: Bilingual;
  /** The illiquid net-worth layer. Omit to chart liquid savings only. */
  netWorth?: NetWorthMarks;
  /** Account label -> display name, per language, for the transaction list. */
  accountLabels: Record<string, Bilingual>;
  /** Merchant display rules (clean name + "what for" note). */
  merchantInfo: MerchantInfoEntry[];
}

export const EMPTY_PROFILE: Profile = {
  owners: [],
  ownNames: [],
  ownIbans: [],
  accountLabels: {},
  merchantInfo: [],
};

/** Load and validate `data/profile.json`. Missing file -> empty profile. */
export function loadProfile(path: string): Profile {
  if (!existsSync(path)) return { ...EMPTY_PROFILE };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`profile load: ${path} is not valid JSON (${(e as Error).message})`);
  }
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  const nwRaw = raw.netWorth as Partial<NetWorthMarks> | undefined;
  return {
    owners: strList(raw.owners),
    ownNames: strList(raw.ownNames),
    ownIbans: strList(raw.ownIbans),
    footer: isBilingual(raw.footer) ? (raw.footer as Bilingual) : undefined,
    netWorth: nwRaw
      ? {
          flatsRub: Number(nwRaw.flatsRub) || 0,
          mortgageRub: Number(nwRaw.mortgageRub) || 0,
          bcsNominalCny: Number(nwRaw.bcsNominalCny) || 0,
          propertyApr: Number(nwRaw.propertyApr) || 0,
        }
      : undefined,
    accountLabels: isRecord(raw.accountLabels) ? (raw.accountLabels as Record<string, Bilingual>) : {},
    merchantInfo: Array.isArray(raw.merchantInfo) ? (raw.merchantInfo as MerchantInfoEntry[]) : [],
  };
}

function isBilingual(v: unknown): boolean {
  return typeof v === "object" && v !== null && typeof (v as Bilingual).en === "string";
}
function isRecord(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
