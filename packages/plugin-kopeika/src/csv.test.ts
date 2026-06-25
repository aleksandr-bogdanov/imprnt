import { describe, expect, test } from "bun:test";
import { parseCsv, writeCsv } from "./csv.ts";

describe("parseCsv basics", () => {
  test("parses a simple header + row, header-keyed access", () => {
    const { header, records } = parseCsv("a,b,c\n1,2,3\n");
    expect(header).toEqual(["a", "b", "c"]);
    expect(records).toHaveLength(1);
    expect(records[0]!.get("a")).toBe("1");
    expect(records[0]!.get("c")).toBe("3");
  });

  test("positional fields are preserved on each record", () => {
    const { records } = parseCsv("a,b\nx,y\n");
    expect(records[0]!.fields).toEqual(["x", "y"]);
  });

  test("throws on empty document (no header)", () => {
    expect(() => parseCsv("")).toThrow(/empty document/);
  });

  test("get() on an unknown column throws", () => {
    const { records } = parseCsv("a,b\n1,2\n");
    expect(() => records[0]!.get("zzz")).toThrow(/not present in header/);
  });
});

describe("parseCsv quoting + edge cases", () => {
  test("embedded comma inside quotes is one field", () => {
    const { records } = parseCsv('a,b\n"OKTAN Brzeski, Grzenkowicz",2\n');
    expect(records[0]!.get("a")).toBe("OKTAN Brzeski, Grzenkowicz");
    expect(records[0]!.get("b")).toBe("2");
  });

  test('escaped quote ("") becomes a single literal quote', () => {
    const { records } = parseCsv('a,b\n"say ""hi""",2\n');
    expect(records[0]!.get("a")).toBe('say "hi"');
  });

  test("embedded newline inside quotes stays in one field", () => {
    const { records } = parseCsv('a,b\n"line1\nline2",2\n');
    expect(records).toHaveLength(1);
    expect(records[0]!.get("a")).toBe("line1\nline2");
  });

  test("mixed quoting on the same row (some fields bare, some quoted)", () => {
    const { records } = parseCsv('Booking Date,Partner,Type\n2025-01-01,"Doe, Jane",Presentment\n');
    expect(records[0]!.get("Partner")).toBe("Doe, Jane");
    expect(records[0]!.get("Type")).toBe("Presentment");
  });

  test("trailing newline does NOT create a phantom empty row", () => {
    const { records } = parseCsv("a,b\n1,2\n");
    expect(records).toHaveLength(1);
  });

  test("no trailing newline still flushes the last row", () => {
    const { records } = parseCsv("a,b\n1,2");
    expect(records).toHaveLength(1);
    expect(records[0]!.get("b")).toBe("2");
  });

  test("CRLF line endings are handled (one row, no stray \\r)", () => {
    const { header, records } = parseCsv("a,b\r\n1,2\r\n");
    expect(header).toEqual(["a", "b"]);
    expect(records).toHaveLength(1);
    expect(records[0]!.get("b")).toBe("2");
  });

  test("intentionally-empty fields are preserved", () => {
    const { records } = parseCsv("a,b,c\n1,,3\n");
    expect(records[0]!.get("b")).toBe("");
  });

  test("missing trailing field resolves to empty string", () => {
    const { records } = parseCsv("a,b,c\n1,2\n");
    expect(records[0]!.get("c")).toBe("");
    expect(records[0]!.fields).toEqual(["1", "2"]);
  });

  test("duplicate header: first occurrence wins", () => {
    const { records } = parseCsv("x,x\nfirst,second\n");
    expect(records[0]!.get("x")).toBe("first");
  });
});

describe("writeCsv", () => {
  test("writes header + rows with a trailing newline", () => {
    const out = writeCsv(["a", "b"], [["1", "2"]]);
    expect(out).toBe("a,b\n1,2\n");
  });

  test("quotes a field containing a comma", () => {
    const out = writeCsv(["a"], [["x,y"]]);
    expect(out).toBe('a\n"x,y"\n');
  });

  test("quotes and doubles an embedded quote", () => {
    const out = writeCsv(["a"], [['say "hi"']]);
    expect(out).toBe('a\n"say ""hi"""\n');
  });

  test("quotes a field containing a newline", () => {
    const out = writeCsv(["a"], [["l1\nl2"]]);
    expect(out).toBe('a\n"l1\nl2"\n');
  });

  test("leaves a plain field bare", () => {
    const out = writeCsv(["a"], [["plain"]]);
    expect(out).toBe("a\nplain\n");
  });

  test("round-trips quoting-heavy content", () => {
    const header = ["desc", "amt"];
    const rows = [['OKTAN Brzeski, "the firm"\nltd', "-5.00"]];
    const text = writeCsv(header, rows);
    const { records } = parseCsv(text);
    expect(records[0]!.get("desc")).toBe('OKTAN Brzeski, "the firm"\nltd');
    expect(records[0]!.get("amt")).toBe("-5.00");
  });
});
