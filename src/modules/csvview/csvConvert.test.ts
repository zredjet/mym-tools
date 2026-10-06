import { describe, expect, it } from "vitest";

import { columnNames, convertRows, toDelimited, toJson, toMarkdown } from "./csvConvert";

describe("columnNames", () => {
  it("fills empty names and renames duplicates", () => {
    expect(columnNames(["id", "", "name", "name", "name_2"], 6)).toEqual({
      names: ["id", "列2", "name", "name_2", "name_2_2", "列6"],
      warnings: ["空の見出し 2 個を「列N」にしました", "重複した見出し 2 個に _2 などを付けました"],
    });
  });

  it("uses 列N for every column without a header row", () => {
    expect(columnNames(null, 2)).toEqual({ names: ["列1", "列2"], warnings: [] });
  });
});

describe("toJson", () => {
  it("builds objects from the header row and pads short rows", () => {
    const { text } = toJson([["id", "name"], ["1", "山田"], ["2"], ["3", "佐藤", "extra"]], true);
    expect(JSON.parse(text)).toEqual([
      { id: "1", name: "山田", 列3: "" },
      { id: "2", name: "", 列3: "" },
      { id: "3", name: "佐藤", 列3: "extra" },
    ]);
  });

  it("keeps a __proto__ header as an ordinary key", () => {
    const parsed = JSON.parse(toJson([["__proto__"], ["x"]], true).text) as Record<
      string,
      unknown
    >[];
    expect(Object.keys(parsed[0]!)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(parsed[0], "__proto__")?.value).toBe("x");
  });

  it("returns arrays of strings without a header", () => {
    expect(JSON.parse(toJson([["1", "2"], ["3"]], false).text)).toEqual([["1", "2"], ["3"]]);
  });
});

describe("toMarkdown", () => {
  it("escapes backslashes, pipes and newlines", () => {
    expect(
      toMarkdown(
        [
          ["a|b", "c"],
          ["x\\y", "1\r\n2"],
        ],
        true,
      ).text,
    ).toBe("| a\\|b | c |\n| --- | --- |\n| x\\\\y | 1<br>2 |\n");
  });

  it("uses 列N headers and pads rows", () => {
    expect(toMarkdown([["1", "2"], ["3"]], false).text).toBe(
      "| 列1 | 列2 |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |\n",
    );
  });
});

describe("toDelimited", () => {
  it("quotes only fields that need it", () => {
    expect(toDelimited([["a", "b,c", 'say "hi"', "x\ny"]], ",").text).toBe(
      'a,"b,c","say ""hi""","x\ny"\n',
    );
    expect(toDelimited([["a,b", "c\td"]], "\t").text).toBe('a,b\t"c\td"\n');
    expect(toDelimited([], ",").text).toBe("");
  });
});

describe("convertRows", () => {
  it("dispatches by format", () => {
    const rows = [["h"], ["v"]];
    expect(convertRows(rows, "tsv", true).text).toBe("h\nv\n");
    expect(convertRows(rows, "csv", false).text).toBe("h\nv\n");
    expect(convertRows(rows, "markdown", true).text).toContain("| h |");
    expect(JSON.parse(convertRows(rows, "json", true).text)).toEqual([{ h: "v" }]);
  });
});
