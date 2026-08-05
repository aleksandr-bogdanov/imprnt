/**
 * Lexoffice DATEV Belegdaten connector (directory of XML files).
 *
 * Input is the unzipped "DATEV-Export_Belegbilder_mit_Belegdaten" folder: one
 * `<uuid>.xml` per Beleg (DATEV Belegverwaltung ledger-import v050, generated
 * by Lexware Office), each usually paired with a `<uuid>.pdf` Belegbild. One
 * XML holds one `<consolidate>` with one or more ledger entries — a Bewirtung
 * Beleg carries TWO (the 70/30 split into SKR 6640 + 6644), so entries, not
 * files, are the unit.
 *
 * Semantics (verified against a real Lexware Office export (92 XMLs / 110 entries)):
 *   - accountsReceivableLedger = income. Positive amount = revenue; a negative
 *     amount is a Storno/Erfassungsfehler correction ("STORNO" stamped on the
 *     paired Belegbild). Both are kept — income must net them.
 *   - accountsPayableLedger = expense. Positive amount = cost (ledger sign is
 *     flipped to kopeika's negative-outflow convention); a negative amount is
 *     a supplier credit note.
 *   - `accountNo` is the SKR account code. The import pipeline maps it to a
 *     tax category via the country pack; an unmapped code stays undisposed and
 *     queues — never guessed.
 *
 * These are BOOK rows, not bank rows: they document Belege, not payments. They
 * import with household category "Exclude" so the family analytics never see
 * them; the tax face reads them through the tax axis.
 */

export interface DatevEntry {
  date: string; // ISO YYYY-MM-DD
  /** Counterpart: customerName (income) or supplierName (expense). */
  merchant: string;
  /** Signed per kopeika convention: income positive, expense negative. */
  amount: number;
  currency: string;
  side: "income" | "expense";
  /** SKR account code (e.g. "4184", "6640"). */
  accountNo: string;
  accountName: string;
  invoiceId: string;
  information: string;
  /** Source XML basename, for the ledger's source_file column. */
  file: string;
  /** Stable dedup disambiguator within (date, merchant, amount). */
  dedupExtra: string;
}

export interface DatevFile {
  name: string;
  text: string;
}

const LEDGER_BLOCK_RE =
  /<(accountsReceivableLedger|accountsPayableLedger|cashLedger)>([\s\S]*?)<\/\1>/g;

/** Parse every ledger entry across a set of DATEV XML files. */
export function parseLexofficeDatev(files: readonly DatevFile[]): DatevEntry[] {
  const entries: DatevEntry[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".xml")) continue;
    // document.xml is the DATEV archive manifest (root <archive>, document/v05.0
    // namespace) listing every Beleg's guid + files — metadata, no ledger entries.
    if (file.text.includes("<archive") && file.text.includes("xml.datev.de/bedi/tps/document")) {
      continue;
    }
    if (!file.text.includes("<LedgerImport")) {
      throw new Error(`lexoffice-datev: ${file.name} is not a DATEV LedgerImport XML`);
    }
    for (const m of file.text.matchAll(LEDGER_BLOCK_RE)) {
      const blockType = m[1]!;
      const block = m[2]!;
      const get = (tag: string): string => {
        const t = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return t ? decodeXml(t[1]!) : "";
      };

      const date = get("date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`lexoffice-datev: ${file.name}: bad or missing <date> "${date}"`);
      }
      const amountRaw = get("amount");
      const amount = Number(amountRaw);
      if (!Number.isFinite(amount)) {
        throw new Error(`lexoffice-datev: ${file.name}: non-numeric <amount> "${amountRaw}"`);
      }
      const side = blockType === "accountsReceivableLedger" ? "income" : "expense";
      const accountNo = get("accountNo");
      const invoiceId = get("invoiceId");
      const merchant = side === "income" ? get("customerName") : get("supplierName");

      entries.push({
        date,
        merchant: merchant !== "" ? merchant : get("bookingText"),
        // Ledger sign: income entries keep their sign (a Storno stays negative);
        // expense entries flip (a positive cost is an outflow).
        amount: side === "income" ? amount : -amount,
        currency: get("currencyCode") || "EUR",
        side,
        accountNo,
        accountName: get("accountName"),
        invoiceId,
        information: get("information"),
        file: file.name,
        // invoiceId + accountNo disambiguates the real same-day collisions:
        // two invoices to the same customer for the same amount,
        // and a Beleg's 70/30 pair (same invoice, two accounts). Content-based,
        // so a re-export of the same books dedups against the first import.
        dedupExtra: `${invoiceId}|${accountNo}`,
      });
    }
  }
  return entries;
}

/** Decode the XML entities Lexware actually emits (plus numeric forms). */
function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
