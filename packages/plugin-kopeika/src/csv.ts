/**
 * RFC 4180 CSV parsing and writing.
 *
 * Why hand-rolled: the real bank exports mix quoting styles. Revolut leaves most
 * fields bare and only quotes descriptions containing a comma
 * ("OKTAN Brzeski, Grzenkowicz sp.j."). N26 quotes some fields and not others on
 * the same row, and embeds commas inside quoted payment-reference fields. A naive
 * split(",") corrupts both. This parser is a character-level state machine that
 * honors quotes, escaped quotes (""), embedded commas, embedded newlines, and
 * both CRLF and LF line endings.
 */

/**
 * Parse a full CSV document into an array of records (string-keyed by header).
 * The first non-empty physical record is treated as the header row.
 *
 * `delimiter` defaults to a comma (RFC 4180). Pass ";" for the semicolon-delimited
 * exports some banks emit (T-Bank), where the decimal separator is a comma inside
 * quoted fields — the quote-aware state machine keeps those commas as data.
 *
 * Throws if the document is empty (no header). Rows with a different field count
 * than the header are still returned, padded/truncated against header keys, but
 * the raw field array is preserved on `__fields` for connectors that prefer
 * positional access — neither is silently dropped.
 */
export interface CsvRecord {
  /** Header-keyed view. Missing trailing fields resolve to "". */
  get(column: string): string;
  /** Positional view of the raw parsed fields for this row. */
  fields: readonly string[];
}

export interface ParsedCsv {
  header: readonly string[];
  records: CsvRecord[];
}

export function parseCsv(text: string, delimiter: string = ","): ParsedCsv {
  const rows = parseRows(text, delimiter);
  if (rows.length === 0) {
    throw new Error("parseCsv: empty document — no header row found");
  }
  const header = rows[0]!;
  const headerIndex = new Map<string, number>();
  header.forEach((name, i) => {
    // First occurrence wins on duplicate headers; explicit so behavior is defined.
    if (!headerIndex.has(name)) headerIndex.set(name, i);
  });

  const records: CsvRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const fields = rows[r]!;
    records.push({
      fields,
      get(column: string): string {
        const idx = headerIndex.get(column);
        if (idx === undefined) {
          throw new Error(
            `parseCsv: column "${column}" not present in header [${header.join(", ")}]`,
          );
        }
        return fields[idx] ?? "";
      },
    });
  }

  return { header, records };
}

/**
 * Low-level: parse CSV text into a 2D array of raw field strings.
 * Skips a completely empty final line (trailing newline) but preserves
 * intentionally-empty fields within rows.
 */
function parseRows(text: string, delimiter: string = ","): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false; // distinguishes a genuine empty row from a trailing newline

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false; // closing quote
        }
      } else {
        field += ch;
      }
      sawAnyChar = true;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (ch === delimiter) {
      pushField();
      sawAnyChar = true;
    } else if (ch === "\r") {
      // Handle CRLF: consume the following LF as part of one line break.
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else if (ch === "\n") {
      pushRow();
    } else {
      field += ch;
      sawAnyChar = true;
    }
  }

  // Flush the final record if the file did not end with a newline, OR if the
  // last line had content. A bare trailing newline leaves field="" and
  // sawAnyChar=false, which we drop.
  if (sawAnyChar || field.length > 0 || row.length > 0) {
    pushField();
    rows.push(row);
  }

  return rows;
}

/** Quote a single field iff it contains a comma, quote, CR, or LF (RFC 4180). */
function quoteField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialize rows to an RFC 4180 CSV string with a trailing newline.
 * `header` is written first; each row is an array aligned to header order.
 */
export function writeCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines: string[] = [];
  lines.push(header.map(quoteField).join(","));
  for (const row of rows) {
    lines.push(row.map(quoteField).join(","));
  }
  return lines.join("\n") + "\n";
}
