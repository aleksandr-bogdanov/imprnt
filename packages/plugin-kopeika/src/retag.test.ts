import { describe, expect, test } from "bun:test";
import { renderRetagHtml } from "./retag.ts";
import { loadTiers } from "./tiers.ts";
import { tx } from "./test-helpers.ts";

const ledger = [
  tx({ id: "a1", date: "2026-05-10", amount_native: -12.5, amount_eur: -12.5, category: "groceries", merchant_raw: "REWE <Berlin>" }),
  tx({ id: "a2", date: "2026-05-12", amount_native: -40, amount_eur: -40, category: "eating-out", merchant_raw: "Cafe" }),
  tx({ id: "a3", date: "2026-05-25", amount_native: 2000, amount_eur: 2000, type: "income", category: "Salary" }),
  tx({ id: "a4", date: "2026-05-26", amount_native: -500, amount_eur: -500, type: "transfer", is_transfer: true, category: "" }),
];
const opts = { from: "2026-01-01", accountLabels: {}, tiers: loadTiers("/nonexistent/tiers.csv"), salaryCategory: "Salary", persons: ["alex", "anna"] } as const;

describe("renderRetagHtml", () => {
  test("only counted spend rows are embedded, with their original category and tier", () => {
    const html = renderRetagHtml(ledger, { ...opts, lang: "ru" });
    expect(html).toContain('"id":"a1"');
    expect(html).toContain('"id":"a2"');
    expect(html).not.toContain('"id":"a3"'); // income
    expect(html).not.toContain('"id":"a4"'); // internal move
    expect(html).toContain('"c0":"groceries","t0":"mandatory"');
    expect(html).toContain('"c0":"eating-out","t0":"optional"');
    expect(html).toContain("Продукты"); // the Russian labels from categories.ts
    expect(html).toContain("kopeika-changes");
    expect(html).toContain('"persons":["alex","anna"]');
    // A merchant string can never close the inline script.
    expect(html).not.toContain("REWE <Berlin>");
    expect(html).toContain("REWE \\u003cBerlin>");
  });

  test("external URLs are only the fonts stylesheet and the pinned Tabulator build (no fetch)", () => {
    const html = renderRetagHtml(ledger, { ...opts, lang: "en" });
    for (const m of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
      expect(m[0]).toMatch(/^https:\/\/(fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com\/ajax\/libs\/tabulator\/6\.4\.0\/)/);
    }
    expect(html).not.toMatch(/\bfetch\(/);
    expect(html).toContain("/retag?lang=ru");
  });
});
