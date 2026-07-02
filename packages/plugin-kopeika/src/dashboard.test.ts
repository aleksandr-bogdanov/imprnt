import { describe, expect, test } from "bun:test";
import { buildReport, buildSpendGroups } from "./analytics.ts";
import { renderDashboard } from "./dashboard.ts";
import { tx } from "./test-helpers.ts";

describe("renderDashboard", () => {
  test("output is self-contained: no external URLs (no CDN fonts, no fetch)", () => {
    const ledger = [
      tx({ date: "2026-05-10", amount_native: -12.5, amount_eur: -12.5, category: "Groceries" }),
      tx({ date: "2026-05-25", amount_native: 2000, amount_eur: 2000, type: "income", category: "Salary" }),
    ];
    const report = buildReport(ledger);
    const html = renderDashboard({
      report,
      focusMonth: report.months[0]!.month,
      today: new Date("2026-06-01T00:00:00Z"),
      nowMonth: "2026-06",
      lang: "en",
      months: [{ month: "2026-05", groups: buildSpendGroups(ledger, "2026-05") }],
      selectedMonth: "2026-05",
    });
    // The whole product posture is "financial data never reaches a remote": the
    // page must trigger zero third-party requests when opened.
    expect(html).not.toMatch(/https?:\/\//);
  });
});
