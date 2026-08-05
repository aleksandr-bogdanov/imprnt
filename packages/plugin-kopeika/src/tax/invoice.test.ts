import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitCounter,
  deriveClientsFromDatev,
  findClient,
  fmtDeDate,
  fmtDeMoney,
  formatInvoiceNumber,
  loadClients,
  loadCounter,
  mergeClients,
  nextKundennr,
  paypalAmountSegment,
  renderInvoiceHtml,
  saveClients,
  type Client,
  type InvoiceFill,
  type InvoiceProfile,
} from "./invoice.ts";

// All values SYNTHETIC — the Greta Beispiel convention. No real names, no real
// numbers, no real Kundennummern anywhere in the package.

const PROFILE: InvoiceProfile = {
  businessName: "Greta Beispiel | Beispielstudio",
  address: ["Musterstr. 1", "10000 Berlin"],
  phone: "0170000000",
  email: "greta@example.com",
  website: "example.com",
  paypalMe: "https://paypal.me/gretastudio",
  logo: "branding/logo.png",
  vatClause: "*Umsatzsteuerfreie Leistungen gemäß §19 UStG.",
  serviceLabel: "Gesangsunterricht",
  studioDisplay: "Beispielstudio",
};

const fill = (over: Partial<InvoiceFill> = {}): InvoiceFill => ({
  invoiceNo: "RE0007",
  kundennr: "10003",
  date: "2026-05-11",
  deliveryDate: "2026-05-11",
  clientName: "Erika Musterfrau",
  clientAnrede: "Frau",
  clientAddress: [],
  serviceLabel: "Gesangsunterricht",
  qty: 4,
  unitPriceEur: 62.5,
  totalEur: 250,
  paypalLinkUrl: "https://paypal.me/gretastudio/250eur",
  qrSvg: "<svg><!-- qr --></svg>",
  logoDataUri: "data:image/png;base64,AAAA",
  profile: PROFILE,
  steuernummer: "11/222/33333",
  draft: false,
  ...over,
});

describe("formatting", () => {
  test("German money: dots for thousands, comma decimals, always two places", () => {
    expect(fmtDeMoney(20)).toBe("20,00");
    expect(fmtDeMoney(62.5)).toBe("62,50");
    expect(fmtDeMoney(1234.56)).toBe("1.234,56");
    expect(fmtDeMoney(1234567.8)).toBe("1.234.567,80");
    expect(fmtDeMoney(-3.05)).toBe("-3,05");
  });

  test("German date from ISO, bad input fails loud", () => {
    expect(fmtDeDate("2026-05-11")).toBe("11.05.2026");
    expect(() => fmtDeDate("11.05.2026")).toThrow(/YYYY-MM-DD/);
  });

  test("paypal.me amount segment: whole euros bare, else two decimals", () => {
    expect(paypalAmountSegment(250)).toBe("250");
    expect(paypalAmountSegment(20)).toBe("20");
    expect(paypalAmountSegment(62.5)).toBe("62.50");
  });
});

describe("counter", () => {
  test("format + gapless commit round-trip, extra keys preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "kopeika-inv-"));
    try {
      mkdirSync(join(dir, "invoices"), { recursive: true });
      writeFileSync(
        join(dir, "invoices", "counter.json"),
        JSON.stringify({ _comment: "keep me", prefix: "RE", width: 4, next: 185 }),
        "utf8",
      );
      const counter = loadCounter(dir);
      expect(formatInvoiceNumber(counter)).toBe("RE0185");
      // Nothing consumed by loading or formatting.
      expect(loadCounter(dir).next).toBe(185);
      commitCounter(dir, counter);
      expect(loadCounter(dir).next).toBe(186);
      const raw = JSON.parse(readFileSync(join(dir, "invoices", "counter.json"), "utf8"));
      expect(raw._comment).toBe("keep me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing counter fails loud instead of inventing a range", () => {
    const dir = mkdtempSync(join(tmpdir(), "kopeika-inv-"));
    try {
      expect(() => loadCounter(dir)).toThrow(/no invoice counter/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clients registry", () => {
  const datevXml = (customer: string, partyId: string): { name: string; text: string } => ({
    name: `${partyId}.xml`,
    text:
      `<LedgerImport><consolidate><accountsReceivableLedger>` +
      `<date>2026-01-10</date><amount>80.00</amount><accountNo>4184</accountNo>` +
      `<invoiceId>RE0001</invoiceId><partyId>${partyId}</partyId>` +
      `<bpAccountNo>${partyId}</bpAccountNo><customerName>${customer}</customerName>` +
      `</accountsReceivableLedger></consolidate></LedgerImport>`,
  });

  test("derivation reads customerName + partyId from income entries only", () => {
    const expenseXml = {
      name: "x.xml",
      text:
        `<LedgerImport><consolidate><accountsPayableLedger>` +
        `<supplierName>Musikladen GmbH</supplierName><partyId>70001</partyId>` +
        `</accountsPayableLedger></consolidate></LedgerImport>`,
    };
    const derived = deriveClientsFromDatev([
      datevXml("Erika Musterfrau", "10003"),
      datevXml("Otto Beispiel", "10005"),
      datevXml("Erika Musterfrau", "10003"), // repeat is fine
      expenseXml,
    ]);
    expect(derived.size).toBe(2);
    expect(derived.get("Erika Musterfrau")).toBe("10003");
    expect(derived.get("Otto Beispiel")).toBe("10005");
  });

  test("one name with two Kundennummern fails loud", () => {
    expect(() =>
      deriveClientsFromDatev([datevXml("Erika Musterfrau", "10003"), datevXml("Erika Musterfrau", "10009")]),
    ).toThrow(/two Kundennummern/);
  });

  test("merge keeps existing entries and their hand-filled fields", () => {
    const clients = new Map<string, Client>([
      ["Erika Musterfrau", { kundennr: "10003", anrede: "Frau", address: ["Beispielweg 2"], paypal: "" }],
    ]);
    const { added, kept } = mergeClients(
      clients,
      new Map([
        ["Erika Musterfrau", "10003"],
        ["Otto Beispiel", "10005"],
      ]),
    );
    expect(added).toBe(1);
    expect(kept).toBe(1);
    expect(clients.get("Erika Musterfrau")!.anrede).toBe("Frau");
    expect(clients.get("Otto Beispiel")!.kundennr).toBe("10005");
  });

  test("save/load round-trip and case-insensitive lookup", () => {
    const dir = mkdtempSync(join(tmpdir(), "kopeika-inv-"));
    try {
      const path = join(dir, "clients.json");
      const clients = new Map<string, Client>([
        ["Erika Musterfrau", { kundennr: "10003", anrede: "Frau", address: [], paypal: "" }],
      ]);
      saveClients(path, clients);
      const loaded = loadClients(path);
      expect(loaded.size).toBe(1);
      expect(findClient(loaded, "erika musterfrau")!.client.kundennr).toBe("10003");
      expect(findClient(loaded, "Nobody")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("next Kundennr continues from the numeric max", () => {
    const clients = new Map<string, Client>([
      ["A", { kundennr: "10003", anrede: "", address: [], paypal: "" }],
      ["B", { kundennr: "10025", anrede: "", address: [], paypal: "" }],
    ]);
    expect(nextKundennr(clients)).toBe("10026");
    expect(nextKundennr(new Map())).toBe("10001");
  });
});

describe("renderInvoiceHtml", () => {
  test("fills every placeholder with the German-formatted values", () => {
    const html = renderInvoiceHtml(fill());
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain("RE0007");
    expect(html).toContain("10003");
    expect(html).toContain("11.05.2026");
    expect(html).toContain("Frau Erika Musterfrau");
    expect(html).toContain("62,50");
    expect(html).toContain("250,00");
    expect(html).toContain("https://paypal.me/gretastudio/250eur");
    expect(html).toContain("Gesamtbetrag*");
    expect(html).toContain("*Umsatzsteuerfreie Leistungen gemäß §19 UStG.");
    expect(html).toContain("Zahlbar sofort, rein netto");
    expect(html).toContain("Steuernummer: 11/222/33333");
    expect(html).toContain("Seite 1/1");
    expect(html).toContain("bei Beispielstudio entschieden");
    // PayPal-only by ruling: no bank transfer block, ever.
    expect(html).not.toContain("IBAN");
    expect(html).not.toContain("berweisen");
  });

  test("a clean invoice carries no watermark, a draft carries DRAFT", () => {
    expect(renderInvoiceHtml(fill())).not.toContain('class="watermark"');
    expect(renderInvoiceHtml(fill({ draft: true }))).toContain('<div class="watermark">DRAFT</div>');
  });

  test("client values are HTML-escaped", () => {
    const html = renderInvoiceHtml(fill({ clientName: 'Erika <b>"M"</b> & Co' }));
    expect(html).toContain("Erika &lt;b&gt;&quot;M&quot;&lt;/b&gt; &amp; Co");
  });

  test("an anrede-less client renders the bare name", () => {
    const html = renderInvoiceHtml(fill({ clientAnrede: "" }));
    expect(html).toContain('<div class="recipient">Erika Musterfrau</div>');
  });
});
