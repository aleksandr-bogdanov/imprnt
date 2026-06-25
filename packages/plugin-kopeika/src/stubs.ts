/**
 * v0 STUBS — deliberately NOT implemented. These are interface points only, so
 * the wiring location is obvious when the user picks them up later. They are not
 * referenced by the CLI yet and must never run a network/LLM call silently.
 */

import type { Transaction } from "./types.ts";

/**
 * TODO(v0-stub): Google Sheets mirror/push.
 * Will need Google auth (OAuth or service account) — out of scope for v0.
 * Intended contract: read data/ledger.csv and upsert rows into a sheet by id,
 * never overwriting manually-edited cells the user owns. Push is one-way
 * (local -> sheet); the local ledger stays the source of truth.
 */
export function mirrorToSheets(_ledger: readonly Transaction[]): never {
  throw new Error(
    "kopeika: Sheets mirror/push is a v0 stub — not implemented. Needs Google auth.",
  );
}

/**
 * TODO(v0-stub): LLM-assisted categorization suggestions.
 * Interface point ONLY. The deterministic rule engine (rules.ts) remains the
 * single source of truth for what a row's category is. An LLM may PROPOSE new
 * rules for the user to ratify into data/rules.csv — it must never write a
 * category onto a ledger row directly, and no LLM call happens at import time.
 */
export interface SuggestionProvider {
  /** Given uncategorized merchants, return proposed (pattern -> category) rules. */
  suggestRules(merchants: readonly string[]): Promise<Array<{ pattern: string; category: string }>>;
}

export function suggestCategories(_provider: SuggestionProvider): never {
  throw new Error(
    "kopeika: LLM --suggest is a v0 stub — not implemented. Wire a SuggestionProvider later; it proposes rules, never mutates rows.",
  );
}
