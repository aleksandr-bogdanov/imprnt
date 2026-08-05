import { describe, expect, test } from "bun:test";
import { parseLexofficeDatev } from "./lexoffice-datev.ts";

function wrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<LedgerImport xml_data="Kopie" generating_system="lexware.de" version="5.0" xmlns="http://xml.datev.de/bedi/tps/ledger/v050">
    <consolidate consolidatedAmount="0" consolidatedCurrencyCode="EUR" consolidatedDate="2026-03-23">
${inner}
    </consolidate>
</LedgerImport>`;
}

const AR = (amount: string, extra = ""): string => `        <accountsReceivableLedger>
            <date>2026-03-23</date>
            <amount>${amount}</amount>
            <accountNo>4184</accountNo>
            <currencyCode>EUR</currencyCode>
            <invoiceId>RE0109</invoiceId>
            <accountName>Steuerfreie Erlöse Kleinunternehmer nach</accountName>
            <customerName>Greta Beispiel</customerName>${extra}
        </accountsReceivableLedger>`;

const AP_SPLIT = `        <accountsPayableLedger>
            <date>2026-02-26</date>
            <amount>29.26</amount>
            <accountNo>6640</accountNo>
            <currencyCode>EUR</currencyCode>
            <invoiceId>4009725</invoiceId>
            <accountName>Bewirtungskosten</accountName>
            <supplierName>Tony&apos;s Pizzeria &amp; Restaurant</supplierName>
        </accountsPayableLedger>
        <accountsPayableLedger>
            <date>2026-02-26</date>
            <amount>12.54</amount>
            <accountNo>6644</accountNo>
            <currencyCode>EUR</currencyCode>
            <invoiceId>4009725</invoiceId>
            <accountName>Nicht abzugsfähige Bewirtungskosten</accountName>
            <supplierName>Tony&apos;s Pizzeria &amp; Restaurant</supplierName>
        </accountsPayableLedger>`;

describe("parseLexofficeDatev", () => {
  test("income entry keeps its sign and carries SKR + invoice identifiers", () => {
    const [e] = parseLexofficeDatev([{ name: "a.xml", text: wrap(AR("480.00")) }]);
    expect(e!.side).toBe("income");
    expect(e!.amount).toBe(480);
    expect(e!.accountNo).toBe("4184");
    expect(e!.invoiceId).toBe("RE0109");
    expect(e!.merchant).toBe("Greta Beispiel");
    expect(e!.dedupExtra).toBe("RE0109|4184");
  });

  test("a Storno stays negative on the income side (income must net it)", () => {
    const [e] = parseLexofficeDatev([{ name: "a.xml", text: wrap(AR("-480.00")) }]);
    expect(e!.side).toBe("income");
    expect(e!.amount).toBe(-480);
  });

  test("expense entries flip to outflow sign; one Beleg can hold the 70/30 pair", () => {
    const entries = parseLexofficeDatev([{ name: "b.xml", text: wrap(AP_SPLIT) }]);
    expect(entries.length).toBe(2);
    expect(entries[0]!.amount).toBe(-29.26);
    expect(entries[1]!.amount).toBe(-12.54);
    expect(entries[0]!.merchant).toBe("Tony's Pizzeria & Restaurant");
    // Same invoice, two SKR accounts — dedupExtra keeps both rows distinct.
    expect(entries[0]!.dedupExtra).not.toBe(entries[1]!.dedupExtra);
  });

  test("non-XML files and the archive manifest are skipped, alien XML fails loud", () => {
    expect(parseLexofficeDatev([{ name: "beleg.pdf", text: "%PDF" }])).toEqual([]);
    const manifest =
      '<?xml version="1.0"?><archive version="5.0" xmlns="http://xml.datev.de/bedi/tps/document/v05.0"><content/></archive>';
    expect(parseLexofficeDatev([{ name: "document.xml", text: manifest }])).toEqual([]);
    expect(() => parseLexofficeDatev([{ name: "x.xml", text: "<foo/>" }])).toThrow(/not a DATEV/);
  });

  test("bad date or amount fails loud instead of importing garbage", () => {
    const badDate = wrap(AR("480.00")).replace("2026-03-23</date>", "23.03.2026</date>");
    expect(() => parseLexofficeDatev([{ name: "x.xml", text: badDate }])).toThrow(/bad or missing/);
    const badAmount = wrap(AR("abc"));
    expect(() => parseLexofficeDatev([{ name: "x.xml", text: badAmount }])).toThrow(/non-numeric/);
  });
});
