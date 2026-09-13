/**
 * Split transactions: one bank row, several legs. The bank row stays the fiscal
 * truth (id, date, account, the money that left); a split says what the money was
 * for when one payment bought several things - an Amazon basket with a business
 * item in it, a dm run with a kid's toy. Each leg carries its own household
 * category, an optional mandatory override, whose books it belongs on and the tax
 * category there, and a note naming the item. Legs must sum to the row's EUR
 * amount to the cent; a split that does not sum is reported by `check` and the row
 * is left whole, so the totals never drift.
 *
 * data/splits.csv: id,seq,eur,category,mandatory,books,tax_category,note
 * Written by the retag loop (the agent applies the page's `splits` block), read by
 * every report through `expandSplits`, which replaces a split row by its legs as
 * virtual transactions with id `<row id>#<seq>`. Import, dedup and the transfer
 * matcher never see legs: they work on the raw ledger.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseCsv } from "./csv.ts";
import type { Tier } from "./categories.ts";
import type { Transaction } from "./types.ts";

export interface Leg {
  id: string;
  seq: number;
  /** Signed EUR, same sign convention as the row (spend negative). */
  eur: number;
  category: string;
  mandatory: Tier | null;
  /** Person whose books this leg is on, "" for nobody's. */
  books: string;
  /** Tax category on those books, "" when not on any books. */
  tax_category: string;
  note: string;
}

export type Splits = Map<string, Leg[]>;

export const LEG_SEP = "#";

export function legId(id: string, seq: number): string {
  return `${id}${LEG_SEP}${seq}`;
}

/** The bank row an id belongs to: a leg id loses its `#seq`, a row id is itself. */
export function parentOf(id: string): string {
  const i = id.indexOf(LEG_SEP);
  return i === -1 ? id : id.slice(0, i);
}

export function isLegId(id: string): boolean {
  return id.includes(LEG_SEP);
}

export function loadSplits(path: string): Splits {
  const out: Splits = new Map();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return out;
  const { records } = parseCsv(text);
  records.forEach((rec, i) => {
    const id = rec.get("id").trim();
    if (id === "") return;
    const seq = Number(rec.get("seq").trim());
    const eur = Number(rec.get("eur").trim());
    if (!Number.isInteger(seq) || seq < 1) throw new Error(`splits.csv row ${i + 2}: seq must be a positive integer`);
    if (!Number.isFinite(eur) || eur === 0) throw new Error(`splits.csv row ${i + 2}: eur must be a non-zero number`);
    const m = rec.get("mandatory").trim().toLowerCase();
    if (m !== "" && m !== "yes" && m !== "no") throw new Error(`splits.csv row ${i + 2}: mandatory must be yes|no|empty`);
    const books = rec.get("books").trim();
    const tax_category = rec.get("tax_category").trim();
    if (books === "" && tax_category !== "") throw new Error(`splits.csv row ${i + 2}: tax_category without books`);
    const legs = out.get(id) ?? [];
    if (legs.some((l) => l.seq === seq)) throw new Error(`splits.csv row ${i + 2}: duplicate seq ${seq} for ${id}`);
    legs.push({ id, seq, eur: round2(eur), category: rec.get("category").trim(), mandatory: m === "yes" ? "mandatory" : m === "no" ? "optional" : null, books, tax_category, note: rec.get("note").trim() });
    out.set(id, legs);
  });
  for (const legs of out.values()) legs.sort((a, b) => a.seq - b.seq);
  return out;
}

export function saveSplits(path: string, splits: Splits): void {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["id,seq,eur,category,mandatory,books,tax_category,note"];
  for (const id of [...splits.keys()].sort()) {
    for (const l of [...splits.get(id)!].sort((a, b) => a.seq - b.seq)) {
      lines.push([l.id, String(l.seq), l.eur.toFixed(2), l.category, l.mandatory === "mandatory" ? "yes" : l.mandatory === "optional" ? "no" : "", l.books, l.tax_category, q(l.note)].join(","));
    }
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/** Sum of a row's legs, to the cent. */
function legSum(legs: readonly Leg[]): number {
  return round2(legs.reduce((s, l) => s + l.eur, 0));
}

/**
 * What is wrong with the splits against the ledger, one line each: a split on a
 * row that does not exist, on a row with no EUR value, or whose legs do not sum
 * to the row. Empty when every split is sound.
 */
export function splitProblems(txs: readonly Transaction[], splits: Splits): string[] {
  const byId = new Map(txs.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const [id, legs] of splits) {
    const tx = byId.get(id);
    if (!tx) { out.push(`split ${id}: no such ledger row`); continue; }
    if (tx.amount_eur === null) { out.push(`split ${id}: the row has no EUR amount`); continue; }
    const sum = legSum(legs);
    if (Math.abs(sum - tx.amount_eur) > 0.005) out.push(`split ${id} (${tx.date} ${tx.merchant_raw}): legs sum to ${sum.toFixed(2)}, the row is ${tx.amount_eur.toFixed(2)}`);
  }
  return out;
}

/** Per-leg mandatory overrides, keyed by leg id, for the tier lookup. */
export function legTiers(splits: Splits): Map<string, Tier> {
  const out = new Map<string, Tier>();
  for (const legs of splits.values()) for (const l of legs) if (l.mandatory !== null) out.set(legId(l.id, l.seq), l.mandatory);
  return out;
}

/**
 * The ledger as the reports read it: every split row replaced by its legs. A leg
 * is the row with a leg id, the leg's amount (native scaled by the same ratio),
 * category, note and books. A split whose legs do not sum leaves the row whole.
 */
export function expandSplits(txs: readonly Transaction[], splits: Splits): Transaction[] {
  if (splits.size === 0) return [...txs];
  const out: Transaction[] = [];
  for (const tx of txs) {
    const legs = splits.get(tx.id);
    if (!legs || tx.amount_eur === null || Math.abs(legSum(legs) - tx.amount_eur) > 0.005) { out.push(tx); continue; }
    const ratio = tx.amount_eur === 0 ? 1 : tx.amount_native / tx.amount_eur;
    for (const l of legs) {
      out.push({
        ...tx,
        id: legId(tx.id, l.seq),
        amount_eur: l.eur,
        amount_native: round2(l.eur * ratio),
        category: l.category !== "" ? l.category : tx.category,
        note: l.note !== "" ? l.note : tx.note,
        tax_person: l.books,
        tax_category: l.tax_category,
        tax_source: l.books !== "" ? "pin" : "",
      });
    }
  }
  return out;
}

function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r;
}
