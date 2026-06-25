/**
 * Savings projection — the reason the tool exists.
 *
 * Take the savings stock right now and roll it forward at a chosen monthly rate:
 * where do the savings land in a year, in five years. The rate is a dial you
 * drags ("keep this up" vs "tighten"), defaulting to the recent actual. The
 * forecast is honest precisely because the assumption is set by hand rather than
 * the tool pretending to know it.
 *
 * The model is deliberately a straight line: stock(t) = start + rate * t. The ETF
 * (Trading212) sits in `start` at cost basis and is held flat — market growth is
 * unmodeled upside, a drawdown is not drawn either, so the only thing moving the
 * line is new money set aside. Shown in EUR and RUB, since the income mix is
 * mostly RUB. Pure and deterministic — no I/O, no LLM.
 */

/** One point on the projected curve. month 0 is now. */
export interface ProjectionPoint {
  /** Months from now (0 = today's stock). */
  month: number;
  eur: number;
  /** EUR value at the supplied EUR->RUB rate; null when no rate was given. */
  rub: number | null;
}

export interface ProjectionInput {
  /** Savings stock right now, EUR. */
  startEur: number;
  /** Go-forward monthly savings rate, EUR/month (the slider). May be negative. */
  monthlyRateEur: number;
  /** How many months to project (inclusive of the endpoint). */
  horizonMonths: number;
  /** EUR -> RUB multiplier (RUB per 1 EUR). null to omit the RUB column. */
  rubPerEur?: number | null;
}

/** Round to 2 decimals, normalizing -0 to 0. */
function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * The full monthly curve from now (month 0) to `horizonMonths`, straight-line at
 * the given rate. Length is horizonMonths + 1.
 */
export function project(input: ProjectionInput): ProjectionPoint[] {
  const { startEur, monthlyRateEur, horizonMonths } = input;
  const rubPerEur = input.rubPerEur ?? null;
  if (!Number.isInteger(horizonMonths) || horizonMonths < 0) {
    throw new Error(`project: horizonMonths must be a non-negative integer (got ${horizonMonths})`);
  }
  const points: ProjectionPoint[] = [];
  for (let m = 0; m <= horizonMonths; m++) {
    const eur = round2(startEur + monthlyRateEur * m);
    points.push({ month: m, eur, rub: rubPerEur === null ? null : round2(eur * rubPerEur) });
  }
  return points;
}

/** The projected point at exactly `month` months out. */
export function projectAt(input: ProjectionInput, month: number): ProjectionPoint {
  if (!Number.isInteger(month) || month < 0) {
    throw new Error(`projectAt: month must be a non-negative integer (got ${month})`);
  }
  const eur = round2(input.startEur + input.monthlyRateEur * month);
  const rubPerEur = input.rubPerEur ?? null;
  return { month, eur, rub: rubPerEur === null ? null : round2(eur * rubPerEur) };
}
