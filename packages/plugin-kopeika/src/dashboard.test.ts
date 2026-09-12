import { describe, expect, test } from "bun:test";
import { buildReport, buildSpendGroups } from "./analytics.ts";
import { renderDashboard } from "./dashboard.ts";
import { tx } from "./test-helpers.ts";

describe("renderDashboard", () => {
  test("output is self-contained: external URLs are only the fonts stylesheet and the pinned Tabulator build (no fetch)", () => {
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
    // The whole product posture is "financial data never reaches a remote": the page
    // carries no data-bearing request. The one allowed third-party fetch is the font
    // stylesheet (Playfair Display, Golos Text, JetBrains Mono - the July 2026 design
    // production has run since), which sends nothing about the household.
    const external = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    // Allowed: the font stylesheet and the pinned Tabulator build from cdnjs (the
    // spend table's editor). Both are static assets; neither receives any data.
    for (const url of external) {
      expect(url).toMatch(/^https:\/\/(fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com\/ajax\/libs\/tabulator\/)/);
    }
    for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
      expect(m[1]).toMatch(/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/tabulator\//);
    }
    expect(html).not.toMatch(/\bfetch\(/);
  });
});
