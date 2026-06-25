import { describe, expect, test } from "bun:test";
import { project, projectAt, type ProjectionInput } from "./projection.ts";

const BASE: ProjectionInput = {
  startEur: 4800,
  monthlyRateEur: 600,
  horizonMonths: 60,
  rubPerEur: 95.238,
};

describe("project", () => {
  test("straight line: stock(t) = start + rate * t", () => {
    const curve = project(BASE);
    expect(curve).toHaveLength(61); // 0..60 inclusive
    expect(curve[0]!.eur).toBe(4800);
    expect(curve[12]!.eur).toBe(4800 + 600 * 12); // 12000 in 1 year
    expect(curve[60]!.eur).toBe(4800 + 600 * 60); // 40800 in 5 years
  });

  test("RUB column = EUR * rubPerEur", () => {
    const curve = project(BASE);
    expect(curve[12]!.rub).toBe(Math.round(12000 * 95.238 * 100) / 100);
  });

  test("no rubPerEur -> rub is null (column omitted)", () => {
    const curve = project({ ...BASE, rubPerEur: null });
    expect(curve[12]!.rub).toBeNull();
  });

  test("a negative rate draws a declining line (raiding savings)", () => {
    const curve = project({ ...BASE, monthlyRateEur: -100, horizonMonths: 12 });
    expect(curve[12]!.eur).toBe(4800 - 1200);
  });

  test("the ETF is held flat: only the rate moves the line, never growth", () => {
    // Two runs with the same start and rate are identical regardless of horizon —
    // there is no compounding term that would diverge.
    const a = project({ ...BASE, horizonMonths: 12 });
    const b = project({ ...BASE, horizonMonths: 60 });
    expect(b[12]!.eur).toBe(a[12]!.eur);
  });

  test("horizon must be a non-negative integer", () => {
    expect(() => project({ ...BASE, horizonMonths: -1 })).toThrow(/non-negative integer/);
    expect(() => project({ ...BASE, horizonMonths: 1.5 })).toThrow(/non-negative integer/);
  });
});

describe("projectAt", () => {
  test("matches the curve at a milestone month", () => {
    expect(projectAt(BASE, 60).eur).toBe(40800);
    expect(projectAt(BASE, 0).eur).toBe(4800);
  });

  test("rejects a fractional month", () => {
    expect(() => projectAt(BASE, 1.5)).toThrow(/non-negative integer/);
  });
});
