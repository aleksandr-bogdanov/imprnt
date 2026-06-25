/**
 * Savings: what counts as money set aside, and how much is set aside right now.
 *
 * The v2 reframe: the household number that matters is savings going up, never
 * spend picked apart. Savings is money that lands in a designated savings
 * destination. Everything else on any account is spendable float.
 *
 * A savings destination is declared in data/savings.csv, three ways:
 *   - scope=account : a whole account is a savings account (e.g. trading212).
 *                     Its savings flow is its cash movements in and out
 *                     (type=transfer rows: a deposit adds, a withdrawal subtracts).
 *                     The stock it holds is cost basis = cumulative deposits minus
 *                     withdrawals. ETF growth is unmodeled upside, so cost basis is
 *                     what a flat projection carries.
 *   - scope=marker  : a merchant_raw label that marks a move into a savings pot
 *                     living inside another account (an N26 Space such as HOUSE).
 *                     Each matching row is signed: +into the pot, -out of it.
 *   - scope=anchor  : a savings account not imported yet, given by its current
 *                     EUR balance only (the lump-sum account is one of these until
 *                     its export arrives). It contributes a stock level, no flow.
 *
 * Signing matters: money leaving a savings destination (raiding the buffer) is a
 * negative flow that lowers the stock, so a bad month reports itself with no
 * penny-counting. Pure and deterministic apart from the file loader. No LLM.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseCsv } from "./csv.ts";
import type { Transaction } from "./types.ts";

/** A named savings destination matched by exact (case-insensitive) label. */
interface NamedDestination {
  /** Lower-cased value used for matching. */
  match: string;
  /** Original-case value, for display. */
  label: string;
}

/** A savings account/space declared as not-yet-imported, given by its balance. */
export interface SavingsAnchor {
  label: string;
  balanceEur: number;
}

/** The declared shape of the household's savings, loaded from data/savings.csv. */
export interface SavingsConfig {
  /** Accounts whose cash movements (type=transfer) are savings flow. */
  accounts: NamedDestination[];
  /** merchant_raw labels that mark a move into an in-account savings pot. */
  markers: NamedDestination[];
  /** Manual stock anchors for savings accounts not imported yet. */
  anchors: SavingsAnchor[];
}

const VALID_SCOPES: ReadonlySet<string> = new Set(["account", "marker", "anchor"]);

/** True when nothing is declared as savings — the stock is unknown, not zero. */
export function savingsConfigured(config: SavingsConfig): boolean {
  return config.accounts.length > 0 || config.markers.length > 0 || config.anchors.length > 0;
}

/**
 * Load and validate data/savings.csv (scope,value,balance_eur). A missing or
 * empty file yields an empty config — the projection then has no stock to start
 * from and the CLI says so rather than inventing a number.
 */
export function loadSavingsConfig(path: string): SavingsConfig {
  const empty: SavingsConfig = { accounts: [], markers: [], anchors: [] };
  if (!existsSync(path)) return empty;
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return empty;

  const { records } = parseCsv(text);
  const accounts: NamedDestination[] = [];
  const markers: NamedDestination[] = [];
  const anchors: SavingsAnchor[] = [];

  records.forEach((rec, i) => {
    const scope = rec.get("scope").trim().toLowerCase();
    const value = rec.get("value").trim();
    const balanceRaw = rec.get("balance_eur").trim();

    if (scope === "" && value === "" && balanceRaw === "") return; // blank line

    if (!VALID_SCOPES.has(scope)) {
      throw new Error(`loadSavingsConfig: row ${i + 2}: invalid scope "${scope}" (expected account|marker|anchor)`);
    }
    if (value === "") {
      throw new Error(`loadSavingsConfig: row ${i + 2}: empty value`);
    }

    if (scope === "anchor") {
      if (balanceRaw === "") {
        throw new Error(`loadSavingsConfig: row ${i + 2}: anchor "${value}" needs a balance_eur`);
      }
      const balanceEur = Number(balanceRaw);
      if (!Number.isFinite(balanceEur)) {
        throw new Error(`loadSavingsConfig: row ${i + 2}: non-numeric balance_eur "${balanceRaw}" for anchor "${value}"`);
      }
      anchors.push({ label: value, balanceEur });
      return;
    }

    const dest: NamedDestination = { match: value.toLowerCase(), label: value };
    if (scope === "account") accounts.push(dest);
    else markers.push(dest);
  });

  return { accounts, markers, anchors };
}

/**
 * Signed EUR this row contributes to savings, in (month-bearing) flow terms.
 * Zero when the row is not a savings move, or when it has no EUR value (a missing
 * FX rate is never guessed). Account and marker are checked in that order so a
 * row is never counted twice.
 */
export function savingsFlowEur(tx: Transaction, config: SavingsConfig): number {
  if (tx.amount_eur === null) return 0;
  const acct = tx.account.trim().toLowerCase();
  if (tx.type === "transfer" && config.accounts.some((a) => a.match === acct)) {
    return tx.amount_eur;
  }
  const merchant = tx.merchant_raw.trim().toLowerCase();
  if (config.markers.some((m) => m.match === merchant)) {
    return tx.amount_eur;
  }
  return 0;
}

/** Extract YYYY-MM from an ISO date. */
function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Round to 2 decimals, normalizing -0 to 0. */
function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * Net signed savings flow per calendar month, ascending. A month present here had
 * at least one savings move; a month with none simply does not appear.
 */
export function savingsFlowByMonth(
  txs: readonly Transaction[],
  config: SavingsConfig,
): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const tx of txs) {
    const flow = savingsFlowEur(tx, config);
    if (flow === 0) continue;
    const m = monthOf(tx.date);
    byMonth.set(m, (byMonth.get(m) ?? 0) + flow);
  }
  for (const [m, v] of byMonth) byMonth.set(m, round2(v));
  return new Map([...byMonth].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** One month on the cumulative savings curve. */
export interface SavingsHistoryPoint {
  month: string; // YYYY-MM
  /** Net saved this month (signed). */
  added: number;
  /** Cumulative savings stock from flows up to and including this month. */
  stockEur: number;
}

/**
 * The savings stock month by month, as a running cumulative of net savings flow.
 * This is the "building up" curve worth showing: how the saved pile grew over
 * time. `baseEur` (e.g. manual anchors not tied to a month) is added to every
 * point so the curve starts from the true floor. Months with no savings move are
 * omitted (the line simply holds its level between points).
 */
export function savingsStockByMonth(
  txs: readonly Transaction[],
  config: SavingsConfig,
  baseEur = 0,
): SavingsHistoryPoint[] {
  const byMonth = savingsFlowByMonth(txs, config); // ascending
  const out: SavingsHistoryPoint[] = [];
  let running = baseEur;
  for (const [month, added] of byMonth) {
    running = round2(running + added);
    out.push({ month, added: round2(added), stockEur: running });
  }
  return out;
}

/** One destination's cumulative line, aligned to the shared month axis. */
export interface SavingsSeriesLine {
  /** Stable key (the component's lowercased match value). */
  key: string;
  label: string;
  kind: "account" | "marker";
  /** Cumulative EUR at each month in {@link SavingsSeriesData.months}. */
  values: number[];
}

/** Per-destination cumulative savings, for a multi-line chart. */
export interface SavingsSeriesData {
  /** Union of months any destination moved in, ascending. */
  months: string[];
  /** Cumulative total (all destinations + anchors) at each month. */
  total: number[];
  /** One forward-filled cumulative line per account/marker destination. */
  lines: SavingsSeriesLine[];
}

/**
 * Decompose savings into one cumulative line per destination (account, marker),
 * plus the total, over a shared month axis. Each line is forward-filled, so a
 * destination that did not move in a given month holds its level. Anchors have no
 * month, so they lift the total uniformly. For the breakdown chart.
 */
export function savingsSeries(txs: readonly Transaction[], config: SavingsConfig): SavingsSeriesData {
  const defs = [
    ...config.accounts.map((a) => ({ ...a, kind: "account" as const })),
    ...config.markers.map((m) => ({ ...m, kind: "marker" as const })),
  ];
  const flow = new Map<string, Map<string, number>>(); // key -> month -> net flow
  for (const d of defs) flow.set(d.match, new Map());

  for (const tx of txs) {
    if (tx.amount_eur === null) continue;
    const acct = tx.account.trim().toLowerCase();
    const accDef = config.accounts.find((a) => a.match === acct);
    if (accDef !== undefined && tx.type === "transfer") {
      addFlow(flow.get(accDef.match)!, monthOf(tx.date), tx.amount_eur);
      continue;
    }
    const merchant = tx.merchant_raw.trim().toLowerCase();
    const mkDef = config.markers.find((m) => m.match === merchant);
    if (mkDef !== undefined) addFlow(flow.get(mkDef.match)!, monthOf(tx.date), tx.amount_eur);
  }

  const monthSet = new Set<string>();
  for (const perMonth of flow.values()) for (const m of perMonth.keys()) monthSet.add(m);
  const months = [...monthSet].sort();

  const lines: SavingsSeriesLine[] = defs.map((d) => {
    const perMonth = flow.get(d.match)!;
    let running = 0;
    const values = months.map((m) => {
      running = round2(running + (perMonth.get(m) ?? 0));
      return running;
    });
    return { key: d.match, label: d.label, kind: d.kind, values };
  });

  const anchorsTotal = config.anchors.reduce((s, a) => s + a.balanceEur, 0);
  const total = months.map((_, i) => round2(lines.reduce((s, l) => s + l.values[i]!, 0) + anchorsTotal));
  return { months, total, lines };
}

function addFlow(m: Map<string, number>, month: string, eur: number): void {
  m.set(month, (m.get(month) ?? 0) + eur);
}

/** One labeled piece of the savings stock (an account's cost basis, a pot, an anchor). */
export interface StockComponent {
  label: string;
  eur: number;
  kind: "account" | "marker" | "anchor";
}

/** The savings stock right now: a total plus the pieces it is made of. */
export interface SavingsStock {
  totalEur: number;
  components: StockComponent[];
}

/**
 * Current savings stock = cumulative net flow into every declared account and
 * marker, all of time, plus the manual anchors. This is the projection's starting
 * point. Components are returned in declaration order (accounts, then markers,
 * then anchors) so the CLI can show the breakdown.
 */
export function savingsStock(txs: readonly Transaction[], config: SavingsConfig): SavingsStock {
  const accountSums = new Map<string, number>();
  const markerSums = new Map<string, number>();

  for (const tx of txs) {
    if (tx.amount_eur === null) continue;
    const acct = tx.account.trim().toLowerCase();
    const acctDest = config.accounts.find((a) => a.match === acct);
    if (acctDest !== undefined && tx.type === "transfer") {
      accountSums.set(acctDest.match, (accountSums.get(acctDest.match) ?? 0) + tx.amount_eur);
      continue; // counted as account flow; never also as a marker
    }
    const merchant = tx.merchant_raw.trim().toLowerCase();
    const markerDest = config.markers.find((m) => m.match === merchant);
    if (markerDest !== undefined) {
      markerSums.set(markerDest.match, (markerSums.get(markerDest.match) ?? 0) + tx.amount_eur);
    }
  }

  const components: StockComponent[] = [];
  for (const a of config.accounts) {
    components.push({ label: a.label, eur: round2(accountSums.get(a.match) ?? 0), kind: "account" });
  }
  for (const m of config.markers) {
    components.push({ label: m.label, eur: round2(markerSums.get(m.match) ?? 0), kind: "marker" });
  }
  for (const anc of config.anchors) {
    components.push({ label: anc.label, eur: round2(anc.balanceEur), kind: "anchor" });
  }

  const totalEur = round2(components.reduce((s, c) => s + c.eur, 0));
  return { totalEur, components };
}

/** Options for the recent-actual savings rate (the projection slider's default). */
export interface RateOptions {
  /** How many trailing complete months to average over. Default 6. */
  lookbackMonths?: number;
  /** "Now" — months strictly before its YYYY-MM are complete. Injected for tests. */
  asOf?: Date;
}

// A full trailing year is the default window: it absorbs one-off withdrawals (a
// single big raid does not define the go-forward pace) and any seasonality, which
// a short window would over-weight. The slider lets you override it anyway.
export const DEFAULT_RATE_LOOKBACK = 12;

/** YYYY-MM of a Date, in UTC. */
function currentMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The calendar month immediately before `month` (YYYY-MM). */
function previousMonth(month: string): string {
  return trailingMonths(month, 2)[0]!;
}

/**
 * The recent actual savings rate in EUR per month — the honest default for the
 * projection slider. Averages net savings flow over the last `lookbackMonths`
 * COMPLETE months ending at the month before now (the current, partial month is
 * excluded so a mid-month run does not read as a slow month).
 *
 * The window is anchored to now, not to the last month that happened to have a
 * savings move: a recent pause in saving is a string of real zeros that must pull
 * the average down, not be skipped. Months before the ledger's first savings move
 * are dropped instead (they are not zeros, they are absence of data), so a short
 * history is not diluted. Returns 0 when there is no complete-month history.
 */
export function recentMonthlyRate(
  txs: readonly Transaction[],
  config: SavingsConfig,
  options: RateOptions = {},
): number {
  const lookback = options.lookbackMonths ?? DEFAULT_RATE_LOOKBACK;
  const asOf = options.asOf ?? new Date();
  const lastComplete = previousMonth(currentMonth(asOf));

  const flow = savingsFlowByMonth(txs, config); // ascending by month
  const flowMonths = [...flow.keys()];
  if (flowMonths.length === 0) return 0;
  const firstFlow = flowMonths[0]!;
  if (lastComplete < firstFlow) return 0; // all savings activity is in the current month

  // Last `lookback` complete months, clipped to the data's start so pre-history
  // months never dilute. Gaps inside the window stay as real zeros.
  const window = trailingMonths(lastComplete, lookback).filter((m) => m >= firstFlow);
  if (window.length === 0) return 0;
  const sum = window.reduce((s, m) => s + (flow.get(m) ?? 0), 0);
  return round2(sum / window.length);
}

/** The `count` calendar months ending at `lastMonth` (inclusive), ascending. */
function trailingMonths(lastMonth: string, count: number): string[] {
  const [yStr, mStr] = lastMonth.split("-");
  let y = Number(yStr);
  let m = Number(mStr); // 1-12
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out.reverse();
}
