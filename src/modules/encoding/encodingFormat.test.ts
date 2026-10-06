import { describe, expect, it } from "vitest";

import type { EncodingInspection } from "@/ipc/encoding";

import {
  defaultOutputPath,
  includesMacSymbol,
  newlineSummary,
  noChangeReason,
} from "./encodingFormat";

function inspection(overrides: Partial<EncodingInspection>): EncodingInspection {
  return {
    size: 10,
    bom: null,
    detection: null,
    encoding: "shift_jis",
    ascii_only: false,
    malformed_count: 0,
    malformed: [],
    newlines: { crlf: 2, lf: 0, cr: 0 },
    line_count: 2,
    char_count: 8,
    private_use_count: 0,
    preview: "",
    preview_truncated: false,
    ...overrides,
  };
}

describe("defaultOutputPath", () => {
  it("adds the target suffix before the extension", () => {
    expect(defaultOutputPath("/tmp/data.csv", "utf8_bom")).toBe("/tmp/data-utf8bom.csv");
    expect(defaultOutputPath("C:\\work\\メモ.txt", "shift_jis")).toBe("C:\\work\\メモ-sjis.txt");
  });

  it("handles names without an extension and dot files", () => {
    expect(defaultOutputPath("/tmp/README", "euc_jp")).toBe("/tmp/README-eucjp");
    expect(defaultOutputPath("/tmp/.env", "utf8")).toBe("/tmp/.env-utf8");
  });
});

describe("newlineSummary", () => {
  it("names the only newline kind, a mix, or none", () => {
    expect(newlineSummary({ crlf: 3, lf: 0, cr: 0 })).toBe("CRLF");
    expect(newlineSummary({ crlf: 0, lf: 1, cr: 0 })).toBe("LF");
    expect(newlineSummary({ crlf: 1, lf: 1, cr: 0 })).toBe("混在");
    expect(newlineSummary({ crlf: 0, lf: 0, cr: 0 })).toBe("なし");
  });
});

describe("noChangeReason", () => {
  it("detects conversions that would write the same bytes", () => {
    const sjis = inspection({});
    expect(noChangeReason(sjis, "shift_jis", "keep", false)).not.toBeNull();
    expect(noChangeReason(sjis, "shift_jis", "crlf", false)).not.toBeNull();
    expect(noChangeReason(sjis, "shift_jis", "lf", false)).toBeNull();
    expect(noChangeReason(sjis, "shift_jis", "keep", true)).toBeNull();
    expect(noChangeReason(sjis, "utf8", "keep", false)).toBeNull();
  });

  it("treats adding or removing the UTF-8 BOM as a change", () => {
    const plain = inspection({ encoding: "utf8" });
    const withBom = inspection({ encoding: "utf8", bom: "utf8" });
    expect(noChangeReason(plain, "utf8", "keep", false)).not.toBeNull();
    expect(noChangeReason(plain, "utf8_bom", "keep", false)).toBeNull();
    expect(noChangeReason(withBom, "utf8", "keep", false)).toBeNull();
    expect(noChangeReason(withBom, "utf8_bom", "keep", false)).not.toBeNull();
  });

  it("does not block when the source is unknown", () => {
    expect(noChangeReason(inspection({ encoding: null }), "utf8", "keep", false)).toBeNull();
  });
});

describe("includesMacSymbol", () => {
  it("finds symbols the Mac normalization would replace", () => {
    expect(includesMacSymbol(["😀", "〜"])).toBe(true);
    expect(includesMacSymbol(["😀"])).toBe(false);
  });
});
