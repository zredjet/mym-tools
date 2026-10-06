import { describe, expect, it } from "vitest";

import { CsvParseError, detectDelimiter, parseCsv } from "./csvParser";

describe("parseCsv", () => {
  it("parses plain records with CRLF, LF and CR newlines", () => {
    expect(parseCsv("a,b\r\nc,d\ne,f\rg,h", ",").rows).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("handles quotes, escaped quotes and newlines inside quotes", () => {
    const result = parseCsv('"a,1","say ""hi""","line1\r\nline2"\nx,y,z\n', ",");
    expect(result.rows).toEqual([
      ["a,1", 'say "hi"', "line1\r\nline2"],
      ["x", "y", "z"],
    ]);
    expect(result.warningCount).toBe(0);
  });

  it("keeps empty fields, a trailing empty field and quoted empty records", () => {
    expect(parseCsv('a,,c,\n,\n""\n', ",").rows).toEqual([["a", "", "c", ""], ["", ""], [""]]);
  });

  it("skips blank lines and strips a leading BOM", () => {
    expect(parseCsv("\uFEFFa\n\n\r\nb\n", ",").rows).toEqual([["a"], ["b"]]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("", ",")).toEqual({ rows: [], warnings: [], warningCount: 0, columnCount: 0 });
  });

  it("warns about a stray quote inside an unquoted field", () => {
    const result = parseCsv('a,5" screen\nb,c', ",");
    expect(result.rows[0]).toEqual(["a", '5" screen']);
    expect(result.warnings).toEqual([
      { record: 1, line: 1, message: expect.stringContaining('" があります') as string },
    ]);
  });

  it("warns about text after a closing quote", () => {
    const result = parseCsv('x\n"ab"cd,e', ",");
    expect(result.rows[1]).toEqual(["abcd", "e"]);
    expect(result.warnings[0]).toMatchObject({ record: 2, line: 2 });
  });

  it("reports the line where an unclosed quote starts", () => {
    expect(() => parseCsv('a,b\n"c,\nd\ne', ",")).toThrow(CsvParseError);
    expect(() => parseCsv('a,b\n"c,\nd\ne', ",")).toThrow("2 行目");
  });

  it("counts lines inside quoted fields for later warnings", () => {
    const result = parseCsv('"a\r\nb\nc"\nd"e', ",");
    expect(result.warnings[0]).toMatchObject({ record: 2, line: 4 });
  });

  it("warns once about records with a different number of columns", () => {
    const result = parseCsv("a,b,c\n1,2\n3,4,5,6\n7,8,9", ",");
    expect(result.columnCount).toBe(4);
    expect(result.warningCount).toBe(1);
    expect(result.warnings[0]).toMatchObject({ record: 2, line: 2 });
    expect(result.warnings[0]!.message).toContain("2 件");
  });

  it("keeps at most 20 warnings but counts all of them", () => {
    const text = Array.from({ length: 30 }, (_, i) => `a${i}"b`).join("\n");
    const result = parseCsv(text, ",");
    expect(result.warnings).toHaveLength(20);
    expect(result.warningCount).toBe(30);
  });

  it("parses TSV copied from Excel with quoted multi-line cells", () => {
    expect(parseCsv('名前\tメモ\n山田\t"1行目\n2行目"\n', "\t").rows).toEqual([
      ["名前", "メモ"],
      ["山田", "1行目\n2行目"],
    ]);
  });
});

describe("detectDelimiter", () => {
  it("picks the delimiter used consistently in the first records", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter("a;b;c\n1;2,5;3\n")).toBe(";");
  });

  it("ignores delimiters inside quotes", () => {
    expect(detectDelimiter('"x,y,z"\t"1,2"\n"a,b"\t"c"\n')).toBe("\t");
  });

  it("falls back to a comma", () => {
    expect(detectDelimiter("single\ncolumn\n")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });
});
