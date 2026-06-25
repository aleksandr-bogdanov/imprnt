/**
 * Internal-transfer matching.
 *
 * Candidate legs (flagged by connectors via transferCandidate, or already typed
 * "transfer") are paired across DIFFERENT accounts when:
 *   - signs are opposite (one outflow, one inflow),
 *   - |amount_eur| values are within tolerance (default €1.50 to absorb fees and
 *     FX rounding) — cross-currency is fine because we compare on EUR,
 *   - booking dates are within `maxDayGap` days (default 3).
 *
 * Matched legs share a transfer_group id and get is_transfer = true. A leg with
 * no amount_eur (missing FX rate) cannot be matched on EUR and is reported as
 * unmatched rather than guessed.
 */

import type { Transaction } from "./types.ts";

export interface TransferOptions {
  /** Max absolute EUR difference between the two legs. */
  toleranceEur: number;
  /** Max difference in days between leg dates. */
  maxDayGap: number;
}

export const DEFAULT_TRANSFER_OPTIONS: TransferOptions = {
  toleranceEur: 1.5,
  maxDayGap: 3,
};

export interface TransferPair {
  groupId: string;
  outflow: Transaction;
  inflow: Transaction;
}

export interface TransferResult {
  /** Newly matched pairs in this run. */
  pairs: TransferPair[];
  /** Candidate legs that could not be paired. */
  unmatched: Transaction[];
  /** Ledger with is_transfer / transfer_group applied to matched legs. */
  updated: Transaction[];
}

/** A transaction is a transfer candidate if a connector flagged it or it's typed transfer. */
function isCandidate(tx: Transaction): boolean {
  return tx.is_transfer || tx.type === "transfer";
}

/** Whole-day difference between two ISO dates. */
function dayGap(isoA: string, isoB: string): number {
  const a = Date.parse(isoA + "T00:00:00Z");
  const b = Date.parse(isoB + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / 86_400_000;
}

/** Deterministic group id from the two leg ids (sorted so order is irrelevant). */
function groupIdFor(idA: string, idB: string): string {
  const [first, second] = [idA, idB].sort();
  return `tg_${first}_${second}`;
}

/**
 * Match transfer legs. Greedy first-fit over candidates sorted by date; each leg
 * is used at most once. Returns the new pairs, the unmatched candidates, and the
 * full ledger with grouping applied. Already-grouped legs are left untouched and
 * excluded from re-matching so the command is safe to re-run.
 */
export function matchTransfers(
  txs: readonly Transaction[],
  options: TransferOptions = DEFAULT_TRANSFER_OPTIONS,
): TransferResult {
  // Work on shallow clones so we never mutate the caller's objects.
  const updated: Transaction[] = txs.map((t) => ({ ...t }));
  const byId = new Map(updated.map((t) => [t.id, t] as const));

  // Candidate pool: flagged/transfer-typed, not already grouped, with a usable
  // EUR value (needed to compare amounts across currencies).
  const candidates = updated
    .filter((t) => isCandidate(t) && t.transfer_group === "" && t.amount_eur !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const consumed = new Set<string>();
  const pairs: TransferPair[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const legA = candidates[i]!;
    if (consumed.has(legA.id)) continue;
    const eurA = legA.amount_eur!; // non-null by filter above

    for (let j = i + 1; j < candidates.length; j++) {
      const legB = candidates[j]!;
      if (consumed.has(legB.id)) continue;
      if (legB.account === legA.account) continue; // must cross accounts
      const eurB = legB.amount_eur!;

      const oppositeSign = Math.sign(eurA) !== Math.sign(eurB) && eurA !== 0 && eurB !== 0;
      if (!oppositeSign) continue;
      if (Math.abs(Math.abs(eurA) - Math.abs(eurB)) > options.toleranceEur) continue;
      if (dayGap(legA.date, legB.date) > options.maxDayGap) continue;

      // Match found. Resolve which leg is the outflow for reporting clarity.
      const outflow = eurA < 0 ? legA : legB;
      const inflow = eurA < 0 ? legB : legA;
      const groupId = groupIdFor(legA.id, legB.id);

      for (const id of [legA.id, legB.id]) {
        const tx = byId.get(id)!;
        tx.is_transfer = true;
        tx.transfer_group = groupId;
        if (tx.type === "unknown" || tx.type === "spend" || tx.type === "income") {
          tx.type = "transfer";
        }
      }

      consumed.add(legA.id);
      consumed.add(legB.id);
      pairs.push({ groupId, outflow, inflow });
      break; // legA is now paired; move to the next i
    }
  }

  const unmatched = candidates.filter((t) => !consumed.has(t.id));
  return { pairs, unmatched, updated };
}
