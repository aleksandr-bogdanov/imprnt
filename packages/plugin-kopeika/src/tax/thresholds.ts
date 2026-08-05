/**
 * The threshold projector: where does the year LAND against the statutory
 * lines (Familienversicherung monthly average, Kleinunternehmer § 19 revenue,
 * Liebhaberei Totalgewinn), with the gap priced while the fix is still buyable.
 *
 * Two data files per person, pure data, authored in conversation:
 *   thresholds.json — the lines that matter: basis (profit|revenue), window,
 *                     limit, direction, what crossing costs (free text).
 *   forward.json    — the forward book: expected income (a monthly amount over
 *                     a month range), planned purchases (one-off, by a date),
 *                     off-book adjustments (a yearly amount that never appears
 *                     in the ledger, e.g. an Arbeitszimmer declared elsewhere —
 *                     counted ONLY into thresholds with include_offbook true).
 *
 * Actuals always come from buildEuer (the caller passes them in), so the
 * projector and the EÜR report can never disagree. Everything here is
 * deterministic arithmetic; the LLM's job ends at writing the data files.
 *
 * Semantics pinned down:
 *   - "forward" = the months of the projected year STRICTLY AFTER the current
 *     month; the current month counts as actuals even mid-month.
 *   - expected income counts into profit AND revenue; planned purchases into
 *     profit only (an Ausgabe does not shrink revenue).
 *   - an off-book yearly amount counts once, into the projected year, never
 *     into prior years of a cumulative window (those enter as pure ledger
 *     actuals — history is not reconstructed).
 *   - the run-rate is the deliberately naive cross-check: actuals extrapolated
 *     to the full year, no forward book, no off-book. It exists because the
 *     run-rate said "comfortably under" in July and that was exactly wrong.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Threshold {
  name: string;
  basis: "profit" | "revenue";
  window: "monthly-average" | "calendar-year" | "all-years-cumulative";
  limit: number;
  direction: "stay-under" | "reach-above-eventually";
  includeOffbook: boolean;
  /** Free text: what crossing (or missing) the line costs. Shown, never parsed. */
  crossingCosts: string;
}

export interface ExpectedIncome {
  label: string;
  monthlyEur: number;
  /** YYYY-MM, inclusive on both ends. */
  from: string;
  to: string;
}

export interface PlannedPurchase {
  label: string;
  /** Positive cost figure in EUR. */
  eur: number;
  /** YYYY-MM or YYYY-MM-DD — the month it must land by. */
  by: string;
}

export interface OffbookAdjustment {
  label: string;
  /** Signed EUR per year (an expense declared elsewhere is negative). */
  yearlyEur: number;
}

export interface ForwardBook {
  expectedIncome: ExpectedIncome[];
  plannedPurchases: PlannedPurchase[];
  offbook: OffbookAdjustment[];
}

export const EMPTY_FORWARD: ForwardBook = { expectedIncome: [], plannedPurchases: [], offbook: [] };

// --- loaders -----------------------------------------------------------------

/** Load profiles/<person>/thresholds.json (an array of threshold records). */
export function loadThresholds(personDir: string): Threshold[] {
  const path = join(personDir, "thresholds.json");
  if (!existsSync(path)) return [];
  const list = readJsonArray(path);
  return list.map((t, i) => {
    const basis = String(t.basis ?? "");
    if (basis !== "profit" && basis !== "revenue") {
      throw new Error(`${path}: threshold ${i}: basis must be profit|revenue (got "${basis}")`);
    }
    const window = String(t.window ?? "");
    if (window !== "monthly-average" && window !== "calendar-year" && window !== "all-years-cumulative") {
      throw new Error(`${path}: threshold ${i}: window must be monthly-average|calendar-year|all-years-cumulative (got "${window}")`);
    }
    const direction = String(t.direction ?? "stay-under");
    if (direction !== "stay-under" && direction !== "reach-above-eventually") {
      throw new Error(`${path}: threshold ${i}: direction must be stay-under|reach-above-eventually (got "${direction}")`);
    }
    const limit = Number(t.limit);
    if (!Number.isFinite(limit)) {
      throw new Error(`${path}: threshold ${i}: limit must be a number`);
    }
    const name = String(t.name ?? "");
    if (name === "") {
      throw new Error(`${path}: threshold ${i}: name is required`);
    }
    return {
      name,
      basis,
      window,
      limit,
      direction,
      includeOffbook: t.include_offbook === true,
      crossingCosts: String(t.crossing_costs ?? ""),
    };
  });
}

/** Load profiles/<person>/forward.json (the forward book). Absent file = empty book. */
export function loadForward(personDir: string): ForwardBook {
  const path = join(personDir, "forward.json");
  if (!existsSync(path)) return EMPTY_FORWARD;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message})`);
  }
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(raw[key]) ? (raw[key] as Record<string, unknown>[]) : [];

  const expectedIncome = list("expected_income").map((e, i) => {
    const from = String(e.from ?? "");
    const to = String(e.to ?? "");
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
      throw new Error(`${path}: expected_income ${i}: from/to must be YYYY-MM`);
    }
    const monthlyEur = Number(e.monthly_eur);
    if (!Number.isFinite(monthlyEur)) {
      throw new Error(`${path}: expected_income ${i}: monthly_eur must be a number`);
    }
    return { label: String(e.label ?? `income ${i}`), monthlyEur, from, to };
  });

  const plannedPurchases = list("planned_purchases").map((p, i) => {
    const by = String(p.by ?? "");
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(by)) {
      throw new Error(`${path}: planned_purchases ${i}: by must be YYYY-MM or YYYY-MM-DD`);
    }
    const eur = Number(p.eur);
    if (!Number.isFinite(eur) || eur <= 0) {
      throw new Error(`${path}: planned_purchases ${i}: eur must be a positive cost figure`);
    }
    return { label: String(p.label ?? `purchase ${i}`), eur, by };
  });

  const offbook = list("offbook").map((o, i) => {
    const yearlyEur = Number(o.yearly_eur);
    if (!Number.isFinite(yearlyEur)) {
      throw new Error(`${path}: offbook ${i}: yearly_eur must be a number (signed, expense negative)`);
    }
    return { label: String(o.label ?? `offbook ${i}`), yearlyEur };
  });

  return { expectedIncome, plannedPurchases, offbook };
}

function readJsonArray(path: string): Record<string, unknown>[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${path} must be a JSON array`);
  }
  return raw as Record<string, unknown>[];
}

// --- the forward window -------------------------------------------------------

/** 0-based absolute month index for YYYY-MM arithmetic across year boundaries. */
function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
}

/** Months of `year` that already count as actuals (1..12; 0 = year not started). */
export function monthsElapsedInYear(year: string, nowMonth: string): number {
  const nowYear = nowMonth.slice(0, 4);
  if (year < nowYear) return 12;
  if (year > nowYear) return 0;
  return Number(nowMonth.slice(5, 7));
}

export interface ForwardApplied {
  /** Expected income summed over the forward window (into profit AND revenue). */
  incomeEur: number;
  incomeParts: { label: string; eur: number }[];
  /** Planned purchases in the window, as a positive cost figure (into profit only). */
  purchasesEur: number;
  purchaseParts: { label: string; eur: number }[];
  /** Planned purchases whose by-month already elapsed — warned, never counted. */
  stalePurchases: PlannedPurchase[];
  /** Off-book yearly sum, signed. Counts only into include_offbook thresholds. */
  offbookEur: number;
  offbookParts: { label: string; eur: number }[];
  /** Forward window inside the year, 1-based inclusive. fromMonth > toMonth = empty. */
  fromMonth: number;
  toMonth: number;
}

/**
 * Resolve the forward book against one projected year: which months remain
 * (strictly after nowMonth), how much expected income and planned purchasing
 * falls into them, and the off-book yearly sum for the year.
 */
export function applyForward(forward: ForwardBook, year: string, nowMonth: string): ForwardApplied {
  const yearFirst = monthIndex(`${year}-01`);
  const yearLast = yearFirst + 11;
  const windowStart = Math.max(yearFirst, monthIndex(nowMonth) + 1);
  const windowEnd = yearLast;

  const incomeParts: { label: string; eur: number }[] = [];
  for (const e of forward.expectedIncome) {
    const from = Math.max(monthIndex(e.from), windowStart);
    const to = Math.min(monthIndex(e.to), windowEnd);
    const months = to - from + 1;
    if (months <= 0) continue;
    incomeParts.push({ label: e.label, eur: round2(e.monthlyEur * months) });
  }

  const purchaseParts: { label: string; eur: number }[] = [];
  const stalePurchases: PlannedPurchase[] = [];
  for (const p of forward.plannedPurchases) {
    const by = monthIndex(p.by.slice(0, 7));
    if (by >= windowStart && by <= windowEnd) {
      purchaseParts.push({ label: p.label, eur: p.eur });
    } else if (by >= yearFirst && by < windowStart) {
      // Dated inside the year but already elapsed: either it was bought (then it
      // is in the ledger and counting it would double) or it slipped. Warn.
      stalePurchases.push(p);
    }
    // A by-date in another year belongs to that year's projection.
  }

  const offbookParts = forward.offbook.map((o) => ({ label: o.label, eur: o.yearlyEur }));

  return {
    incomeEur: round2(incomeParts.reduce((s, p) => s + p.eur, 0)),
    incomeParts,
    purchasesEur: round2(purchaseParts.reduce((s, p) => s + p.eur, 0)),
    purchaseParts,
    stalePurchases,
    offbookEur: round2(offbookParts.reduce((s, p) => s + p.eur, 0)),
    offbookParts,
    fromMonth: windowStart - yearFirst + 1,
    toMonth: windowEnd - yearFirst + 1,
  };
}

// --- evaluation ---------------------------------------------------------------

/** One year's actuals off buildEuer: profit and revenue (incomeTotal). */
export interface YearActuals {
  year: string;
  profit: number;
  revenue: number;
}

export interface ThresholdEval {
  threshold: Threshold;
  /** In the window's own unit: per month for monthly-average, else per year/total. */
  landing: number;
  /** Signed headroom: positive = on the healthy side of the line. */
  gap: number;
  violated: boolean;
  /**
   * For a violated stay-under: the yearly figure that brings landing exactly to
   * the limit (more Ausgaben for a profit basis, less Einnahmen for revenue).
   * For a violated reach-above: the total shortfall. null when not violated.
   */
  fixEur: number | null;
  /** The naive cross-check in the same unit; null when the year has no actuals. */
  runRate: number | null;
}

export interface ProjectorInput {
  thresholds: readonly Threshold[];
  /** Every year on the person's books (buildEuer per year), the projected year included. */
  actuals: readonly YearActuals[];
  /** The projected year, YYYY. */
  year: string;
  forward: ForwardApplied;
  /** Actual months of the projected year (monthsElapsedInYear). */
  monthsElapsed: number;
}

export function evaluateThresholds(input: ProjectorInput): ThresholdEval[] {
  const { thresholds, actuals, year, forward, monthsElapsed } = input;
  const current = actuals.find((a) => a.year === year) ?? { year, profit: 0, revenue: 0 };
  const priors = actuals.filter((a) => a.year < year);

  return thresholds.map((t) => {
    const actual = t.basis === "profit" ? current.profit : current.revenue;
    const projected = round2(
      (t.basis === "profit"
        ? current.profit + forward.incomeEur - forward.purchasesEur
        : current.revenue + forward.incomeEur) + (t.includeOffbook ? forward.offbookEur : 0),
    );
    const priorSum = round2(priors.reduce((s, a) => s + (t.basis === "profit" ? a.profit : a.revenue), 0));
    // The naive extrapolation: actuals scaled to the full year, nothing else.
    const extrapolated = monthsElapsed > 0 ? (actual / monthsElapsed) * 12 : null;

    let landing: number;
    let runRate: number | null;
    switch (t.window) {
      case "monthly-average":
        landing = round2(projected / 12);
        runRate = extrapolated === null ? null : round2(extrapolated / 12);
        break;
      case "calendar-year":
        landing = projected;
        runRate = extrapolated === null ? null : round2(extrapolated);
        break;
      case "all-years-cumulative":
        landing = round2(priorSum + projected);
        runRate = extrapolated === null ? null : round2(priorSum + extrapolated);
        break;
    }

    const gap = round2(t.direction === "stay-under" ? t.limit - landing : landing - t.limit);
    const violated = gap < 0;
    // The fix is priced on the yearly scale: a monthly-average overshoot times 12.
    const fixEur = violated ? round2(-gap * (t.window === "monthly-average" ? 12 : 1)) : null;

    return { threshold: t, landing, gap, violated, fixEur, runRate };
  });
}

/**
 * The binding threshold for the one-line status view: the first violated one,
 * else the tightest headroom measured on the yearly scale (a /mo gap × 12), so
 * monthly and yearly windows compare on the same footing.
 */
export function pickBinding(evals: readonly ThresholdEval[]): ThresholdEval | null {
  if (evals.length === 0) return null;
  const violated = evals.find((e) => e.violated);
  if (violated) return violated;
  return [...evals].sort((a, b) => yearlyGap(a) - yearlyGap(b))[0]!;
}

function yearlyGap(e: ThresholdEval): number {
  return e.gap * (e.threshold.window === "monthly-average" ? 12 : 1);
}

function round2(n: number): number {
  // Decimal-correct half-up rounding, same as the EÜR builder's (see euer.ts).
  const r = Math.round(Number((n * 100).toPrecision(12))) / 100;
  return r === 0 ? 0 : r;
}
