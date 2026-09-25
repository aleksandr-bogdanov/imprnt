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

/**
 * A transaction is a transfer candidate if a connector flagged it or it's typed
 * transfer. A PayPal card-funding leg is not: its counterpart is a card charge,
 * paired by `matchCardFunding` on merchant evidence, and amount alone would pair
 * it with any own transfer of the same size.
 */
function isCandidate(tx: Transaction): boolean {
  if (isFundingLeg(tx)) return false;
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

/**
 * PayPal card funding.
 *
 * A PayPal purchase paid from a card shows up twice: in the PayPal export as the
 * purchase plus a funding leg ("General Card Deposit"), and in the card's bank
 * export as the charge itself, usually under the merchant's own name ("Temu"),
 * sometimes as "PAYPAL *MERCHANT". The PayPal purchase carries the real merchant,
 * so the bank charge is the copy: this pass pairs it with the funding leg as a
 * transfer. A refund runs the same way through "General Card Withdrawal", and a
 * payout to a bank account through "User Initiated Withdrawal", whose bank row
 * reads "Payment from PAYPAL EUROPE".
 *
 * A bank row qualifies only on the exact opposite amount, dated 0 to `maxDayGap`
 * days after the funding leg, and with merchant evidence: its text contains
 * "paypal", or it shares a word with the purchase that the funding leg paid
 * (same PayPal account, same date and time, opposite amount). A row somebody
 * decided by hand (a pin, a split, a tax disposition) is never re-typed here. It
 * is returned as `held` so the decision stays visible.
 */

const FUNDING_LEGS: ReadonlySet<string> = new Set([
  "General Card Deposit",
  "Bank Deposit to PP Account",
  "General Card Withdrawal",
  "User Initiated Withdrawal",
]);

export function isFundingLeg(tx: Transaction): boolean {
  return tx.data_source === "paypal" && FUNDING_LEGS.has(tx.merchant_raw);
}

/** Sources that never hold a card charge: PayPal itself and the bookkeeping exports and manual rows. */
const NOT_A_CARD: ReadonlySet<string> = new Set(["paypal", "norman-dump", "lexoffice-datev", "manual"]);

const STOP_WORDS: ReadonlySet<string> = new Set([
  "paypal", "gmbh", "com", "the", "and", "www", "europe", "sarl", "cie", "bank",
  "payment", "payments", "ltd", "inc", "llc", "ag", "se", "bv", "sca",
]);

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/\p{M}/gu, "");
}

function words(text: string): Set<string> {
  return new Set((fold(text).match(/\p{L}{3,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)));
}

function squash(text: string): string {
  return fold(text).replace(/\P{L}/gu, "");
}

/**
 * Card descriptors squash a PayPal payee into one token ("Jordanrivers" for
 * "Jordan Rivers", "Riverssam7" for "Sam Rivers"), so a shared whole
 * word is not the only evidence: a payee word of five or more letters inside the
 * squashed descriptor counts, and so does the descriptor inside the squashed payee.
 */
function sameCounterparty(cardMerchant: string, payees: readonly string[]): boolean {
  const cardWords = words(cardMerchant);
  const cardSquashed = squash(cardMerchant);
  for (const payee of payees) {
    const payeeWords = words(payee);
    for (const w of cardWords) if (payeeWords.has(w)) return true;
    for (const w of payeeWords) if (w.length >= 5 && cardSquashed.includes(w)) return true;
    if (cardSquashed.length >= 6 && squash(payee).includes(cardSquashed)) return true;
  }
  return false;
}

export interface CardFundingPair {
  groupId: string;
  funding: Transaction;
  card: Transaction;
}

export interface CardFundingResult {
  pairs: CardFundingPair[];
  /** Matches left alone because the bank row carries a pin, a split or a tax disposition. */
  held: { funding: Transaction; card: Transaction }[];
  updated: Transaction[];
}

export function matchCardFunding(
  txs: readonly Transaction[],
  decided: ReadonlySet<string>,
  maxDayGap = 5,
): CardFundingResult {
  const updated: Transaction[] = txs.map((t) => ({ ...t }));
  const bank = updated
    .filter((t) => !NOT_A_CARD.has(t.data_source) && t.transfer_group === "")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const paypalByMoment = new Map<string, Transaction[]>();
  for (const t of updated) {
    if (t.data_source !== "paypal") continue;
    const key = `${t.account}|${t.date}|${t.time}`;
    paypalByMoment.set(key, [...(paypalByMoment.get(key) ?? []), t]);
  }

  const consumed = new Set<string>();
  const pairs: CardFundingPair[] = [];
  const held: CardFundingResult["held"] = [];

  const legs = updated.filter((t) => isFundingLeg(t) && t.transfer_group === "");
  for (const leg of legs) {
    // The purchase the leg paid: same PayPal account and moment. A card can fund
    // only part of a purchase, and an export without a time of day shares the
    // moment across a whole day, so every non-funding row there is a candidate payee.
    const payees = (paypalByMoment.get(`${leg.account}|${leg.date}|${leg.time}`) ?? [])
      .filter((t) => t.id !== leg.id && !FUNDING_LEGS.has(t.merchant_raw) && Math.sign(t.amount_native) !== Math.sign(leg.amount_native))
      .map((t) => t.merchant_raw);

    const card = bank.find((b) => {
      if (consumed.has(b.id) || b.amount_eur === null || leg.amount_eur === null) return false;
      if (Math.abs(b.amount_eur + leg.amount_eur) >= 0.005) return false;
      const gap = (Date.parse(b.date) - Date.parse(leg.date)) / 86_400_000;
      if (gap < 0 || gap > maxDayGap) return false;
      if (b.merchant_raw.toLowerCase().includes("paypal")) return true;
      return sameCounterparty(b.merchant_raw, payees);
    });
    if (!card) continue;
    consumed.add(card.id);

    if (decided.has(card.id) || card.tax_person !== "") {
      held.push({ funding: leg, card });
      continue;
    }
    const groupId = groupIdFor(leg.id, card.id);
    for (const t of [leg, card]) {
      t.is_transfer = true;
      t.transfer_group = groupId;
      if (t.type === "unknown" || t.type === "spend" || t.type === "income") t.type = "transfer";
    }
    pairs.push({ groupId, funding: leg, card });
  }

  return { pairs, held, updated };
}
