import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { cleanupTmp, tmpCsv } from "../test-helpers.ts";
import {
  applyForward,
  EMPTY_FORWARD,
  evaluateThresholds,
  loadForward,
  loadThresholds,
  monthsElapsedInYear,
  pickBinding,
  type ForwardBook,
  type Threshold,
  type YearActuals,
} from "./thresholds.ts";

// All values SYNTHETIC. Statutory numbers (545, 25000) are public law.

const th = (over: Partial<Threshold> = {}): Threshold => ({
  name: "Test line",
  basis: "profit",
  window: "calendar-year",
  limit: 10000,
  direction: "stay-under",
  includeOffbook: false,
  crossingCosts: "",
  ...over,
});

const fwdBook = (over: Partial<ForwardBook> = {}): ForwardBook => ({
  ...EMPTY_FORWARD,
  ...over,
});

describe("monthsElapsedInYear", () => {
  test("past year is complete, future year has not started", () => {
    expect(monthsElapsedInYear("2025", "2026-08")).toBe(12);
    expect(monthsElapsedInYear("2026", "2026-08")).toBe(8);
    expect(monthsElapsedInYear("2027", "2026-08")).toBe(0);
  });
});

describe("applyForward", () => {
  test("expected income counts the forward months only, current month is actuals", () => {
    const f = fwdBook({
      expectedIncome: [{ label: "teaching", monthlyEur: 1000, from: "2026-09", to: "2026-12" }],
    });
    const a = applyForward(f, "2026", "2026-08");
    expect(a.incomeEur).toBe(4000);
    expect(a.fromMonth).toBe(9);
    expect(a.toMonth).toBe(12);
  });

  test("a range that started before the window clamps to the remaining months", () => {
    const f = fwdBook({
      expectedIncome: [{ label: "teaching", monthlyEur: 1000, from: "2026-06", to: "2026-10" }],
    });
    // Jun-Aug are actuals; only Sep + Oct remain.
    expect(applyForward(f, "2026", "2026-08").incomeEur).toBe(2000);
  });

  test("a fully elapsed range and a past projection year contribute nothing", () => {
    const f = fwdBook({
      expectedIncome: [{ label: "old gig", monthlyEur: 1000, from: "2026-01", to: "2026-05" }],
    });
    expect(applyForward(f, "2026", "2026-08").incomeEur).toBe(0);
    expect(applyForward(f, "2025", "2026-08").incomeEur).toBe(0);
  });

  test("projecting a future year counts the whole in-year range", () => {
    const f = fwdBook({
      expectedIncome: [{ label: "teaching", monthlyEur: 1000, from: "2027-01", to: "2027-03" }],
    });
    const a = applyForward(f, "2027", "2026-08");
    expect(a.incomeEur).toBe(3000);
    expect(a.fromMonth).toBe(1);
  });

  test("planned purchases: in-window counts, elapsed goes stale, other-year is ignored", () => {
    const f = fwdBook({
      plannedPurchases: [
        { label: "interface", eur: 350, by: "2026-11" },
        { label: "mic", eur: 200, by: "2026-03-15" },
        { label: "next-year laptop", eur: 900, by: "2027-02" },
      ],
    });
    const a = applyForward(f, "2026", "2026-08");
    expect(a.purchasesEur).toBe(350);
    expect(a.stalePurchases.map((p) => p.label)).toEqual(["mic"]);
  });

  test("off-book adjustments sum signed, independent of the window", () => {
    const f = fwdBook({
      offbook: [
        { label: "workroom", yearlyEur: -3360 },
        { label: "royalties", yearlyEur: 120 },
      ],
    });
    expect(applyForward(f, "2026", "2026-08").offbookEur).toBe(-3240);
  });
});

describe("evaluateThresholds", () => {
  const actuals: YearActuals[] = [
    { year: "2024", profit: -3000, revenue: 500 },
    { year: "2025", profit: -2000, revenue: 4000 },
    { year: "2026", profit: 6000, revenue: 7000 },
  ];
  const fwd = applyForward(
    fwdBook({
      expectedIncome: [{ label: "teaching", monthlyEur: 1400, from: "2026-09", to: "2026-12" }],
      plannedPurchases: [{ label: "interface", eur: 400, by: "2026-10" }],
      offbook: [{ label: "workroom", yearlyEur: -3360 }],
    }),
    "2026",
    "2026-08",
  );
  const run = (t: Threshold) =>
    evaluateThresholds({ thresholds: [t], actuals, year: "2026", forward: fwd, monthsElapsed: 8 })[0]!;

  test("monthly-average stay-under with off-book: landing, gap, and the yearly fix", () => {
    const e = run(th({ window: "monthly-average", limit: 545, includeOffbook: true }));
    // projected profit = 6000 + 5600 - 400 - 3360 = 7840; /12 = 653.33
    expect(e.landing).toBe(653.33);
    expect(e.gap).toBe(-108.33);
    expect(e.violated).toBe(true);
    expect(e.fixEur).toBe(1299.96); // the /mo overshoot priced on the yearly scale
  });

  test("a revenue threshold ignores planned purchases and unflagged off-book", () => {
    const e = run(th({ basis: "revenue", limit: 25000 }));
    // projected revenue = 7000 + 5600 = 12600 — no purchases, no off-book
    expect(e.landing).toBe(12600);
    expect(e.gap).toBe(12400);
    expect(e.violated).toBe(false);
    expect(e.fixEur).toBeNull();
  });

  test("all-years-cumulative sums every year's basis plus the projection", () => {
    const e = run(th({ window: "all-years-cumulative", limit: 0, direction: "reach-above-eventually" }));
    // priors -3000 + -2000 = -5000; projected 2026 profit (no off-book) = 6000+5600-400 = 11200
    expect(e.landing).toBe(6200);
    expect(e.gap).toBe(6200); // reach-above: landing minus limit
    expect(e.violated).toBe(false);
  });

  test("a reach-above threshold still short reports the missing total", () => {
    const shortActuals: YearActuals[] = [
      { year: "2025", profit: -5000, revenue: 0 },
      { year: "2026", profit: 1000, revenue: 1000 },
    ];
    const e = evaluateThresholds({
      thresholds: [th({ window: "all-years-cumulative", limit: 0, direction: "reach-above-eventually" })],
      actuals: shortActuals,
      year: "2026",
      forward: applyForward(fwdBook(), "2026", "2026-08"),
      monthsElapsed: 8,
    })[0]!;
    expect(e.landing).toBe(-4000);
    expect(e.violated).toBe(true);
    expect(e.fixEur).toBe(4000);
  });

  test("run-rate is the naive extrapolation: no forward book, no off-book", () => {
    const e = run(th({ window: "monthly-average", limit: 545, includeOffbook: true }));
    expect(e.runRate).toBe(750); // 6000 / 8 elapsed months
    const y = run(th({ basis: "revenue", limit: 25000 }));
    expect(y.runRate).toBe(10500); // 7000 / 8 * 12
  });

  test("run-rate is null when the projected year has no actual months", () => {
    const e = evaluateThresholds({
      thresholds: [th()],
      actuals,
      year: "2027",
      forward: applyForward(fwdBook(), "2027", "2026-08"),
      monthsElapsed: 0,
    })[0]!;
    expect(e.runRate).toBeNull();
  });
});

describe("pickBinding", () => {
  const actuals: YearActuals[] = [{ year: "2026", profit: 6000, revenue: 7000 }];
  const evalAll = (ts: Threshold[]) =>
    evaluateThresholds({
      thresholds: ts,
      actuals,
      year: "2026",
      forward: applyForward(fwdBook(), "2026", "2026-08"),
      monthsElapsed: 8,
    });

  test("a violated threshold always binds", () => {
    const evals = evalAll([
      th({ name: "roomy", limit: 100000 }),
      th({ name: "crossed", limit: 5000 }),
    ]);
    expect(pickBinding(evals)!.threshold.name).toBe("crossed");
  });

  test("otherwise the tightest headroom binds, monthly gaps compared on the yearly scale", () => {
    const evals = evalAll([
      // profit 6000: yearly headroom 4000 vs monthly headroom 100/mo = 1200/yr
      th({ name: "yearly", limit: 10000 }),
      th({ name: "monthly", window: "monthly-average", limit: 600 }),
    ]);
    expect(pickBinding(evals)!.threshold.name).toBe("monthly");
    expect(pickBinding([])).toBeNull();
  });
});

describe("loaders", () => {
  test("thresholds.json parses records and defaults include_offbook to false", () => {
    const path = tmpCsv(
      "thresholds.json",
      JSON.stringify([
        {
          name: "Familienversicherung",
          basis: "profit",
          window: "monthly-average",
          limit: 545,
          direction: "stay-under",
          include_offbook: true,
          crossing_costs: "~2,950 EUR/yr freiwillige KV",
        },
        { name: "Kleinunternehmer § 19", basis: "revenue", window: "calendar-year", limit: 25000, direction: "stay-under" },
      ]),
    );
    const ts = loadThresholds(dirname(path));
    expect(ts.length).toBe(2);
    expect(ts[0]!.includeOffbook).toBe(true);
    expect(ts[1]!.includeOffbook).toBe(false);
    expect(ts[1]!.direction).toBe("stay-under");
    cleanupTmp(path);
  });

  test("an invalid basis fails loud, and a missing file means no thresholds", () => {
    const path = tmpCsv("thresholds.json", JSON.stringify([{ name: "x", basis: "vibes", window: "calendar-year", limit: 1 }]));
    expect(() => loadThresholds(dirname(path))).toThrow(/basis must be/);
    cleanupTmp(path);
    expect(loadThresholds("/nonexistent-kopeika-dir")).toEqual([]);
  });

  test("forward.json parses all three record types; a bad month fails loud", () => {
    const path = tmpCsv(
      "forward.json",
      JSON.stringify({
        _comment: "synthetic",
        expected_income: [{ label: "teaching", monthly_eur: 1400, from: "2026-09", to: "2026-12" }],
        planned_purchases: [{ label: "interface", eur: 350, by: "2026-11" }],
        offbook: [{ label: "workroom", yearly_eur: -3360 }],
      }),
    );
    const f = loadForward(dirname(path));
    expect(f.expectedIncome[0]!.monthlyEur).toBe(1400);
    expect(f.plannedPurchases[0]!.by).toBe("2026-11");
    expect(f.offbook[0]!.yearlyEur).toBe(-3360);
    cleanupTmp(path);

    const bad = tmpCsv("forward.json", JSON.stringify({ expected_income: [{ label: "x", monthly_eur: 1, from: "sept", to: "2026-12" }] }));
    expect(() => loadForward(dirname(bad))).toThrow(/from\/to must be YYYY-MM/);
    cleanupTmp(bad);
    expect(loadForward("/nonexistent-kopeika-dir")).toEqual(EMPTY_FORWARD);
  });
});
