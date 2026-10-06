import { describe, expect, it } from "vitest";

import { charKind, countText, formatCodePoint, sjisByteLength } from "./charCount";

const lf = { crlf: false };

describe("sjisByteLength", () => {
  it("follows the encoding_rs Shift_JIS encoder", () => {
    expect(sjisByteLength("A".codePointAt(0)!)).toBe(1);
    expect(sjisByteLength(0x80)).toBe(1);
    expect(sjisByteLength("¥".codePointAt(0)!)).toBe(1);
    expect(sjisByteLength("‾".codePointAt(0)!)).toBe(1);
    expect(sjisByteLength("ｱ".codePointAt(0)!)).toBe(1);
    expect(sjisByteLength("あ".codePointAt(0)!)).toBe(2);
    expect(sjisByteLength("亜".codePointAt(0)!)).toBe(2);
    expect(sjisByteLength("−".codePointAt(0)!)).toBe(2);
    expect(sjisByteLength("～".codePointAt(0)!)).toBe(2);
    expect(sjisByteLength("髙".codePointAt(0)!)).toBe(2);
  });

  it("rejects characters the encoder cannot map", () => {
    expect(sjisByteLength("〜".codePointAt(0)!)).toBe(0);
    expect(sjisByteLength("€".codePointAt(0)!)).toBe(0);
    expect(sjisByteLength(0xe000)).toBe(0);
    expect(sjisByteLength("😀".codePointAt(0)!)).toBe(0);
    expect(sjisByteLength("𠮷".codePointAt(0)!)).toBe(0);
  });
});

describe("charKind", () => {
  it.each([
    ["あ", "hiragana"],
    ["゛", "hiragana"],
    ["ア", "katakana"],
    ["ｱ", "katakana"],
    ["ー", "katakana"],
    ["ｰ", "katakana"],
    ["ﾞ", "katakana"],
    ["漢", "kanji"],
    ["々", "kanji"],
    ["〆", "kanji"],
    ["〇", "kanji"],
    ["a", "latin"],
    ["Ａ", "latin"],
    ["é", "latin"],
    ["1", "digit"],
    ["１", "digit"],
    [" ", "space"],
    ["\t", "space"],
    ["　", "space"],
    [" ", "space"],
    ["\n", "newline"],
    ["\r", "newline"],
    ["・", "other"],
    ["。", "other"],
    ["!", "other"],
    ["😀", "other"],
  ])("classifies %j as %s", (char, kind) => {
    expect(charKind(char)).toBe(kind);
  });
});

describe("countText", () => {
  it("returns zeros for empty text", () => {
    const result = countText("", lf);
    expect(result.graphemes).toBe(0);
    expect(result.lines).toBe(0);
    expect(result.blankLines).toBe(0);
    expect(result.bytes).toEqual({ utf8: 0, sjis: 0, utf16: 0 });
  });

  it("counts graphemes, code points and UTF-16 units separately", () => {
    const family = "👨‍👩‍👧";
    const result = countText(`が${family}`, lf);
    expect(result.graphemes).toBe(2);
    expect(result.codePoints).toBe(6);
    expect(result.utf16Units).toBe(9);
  });

  it("counts characters without whitespace or newlines", () => {
    expect(countText("a b　c\n d", lf).nonWhitespace).toBe(4);
  });

  it("does not count the empty tail after the last newline as a line", () => {
    expect(countText("a", lf).lines).toBe(1);
    expect(countText("a\n", lf).lines).toBe(1);
    expect(countText("a\n\n", lf).lines).toBe(2);
    expect(countText("\n", lf).lines).toBe(1);
  });

  it("counts empty and whitespace-only lines as blank", () => {
    const result = countText("a\n\n \t　\nb\n", lf);
    expect(result.lines).toBe(4);
    expect(result.blankLines).toBe(2);
  });

  it("counts bytes per encoding with LF or CRLF newlines", () => {
    const text = "aあ\nｱ";
    expect(countText(text, lf).bytes).toEqual({ utf8: 8, sjis: 5, utf16: 8 });
    expect(countText(text, { crlf: true }).bytes).toEqual({ utf8: 9, sjis: 6, utf16: 10 });
  });

  it("treats an existing CRLF as one line break", () => {
    const result = countText("a\r\nb", lf);
    expect(result.lines).toBe(2);
    expect(result.bytes.utf8).toBe(3);
    expect(result.kinds.newline).toBe(2);
  });

  it("splits width by Shift_JIS byte length and excludes newlines", () => {
    expect(countText("aｱあ😀\n", lf).width).toEqual({ half: 2, full: 1, unencodable: 1 });
  });

  it("adds every code point to exactly one kind", () => {
    const text = "ひらがなカタカナ漢字ABC123 \n・😀";
    const result = countText(text, lf);
    const total = Object.values(result.kinds).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(result.codePoints);
  });

  it("lists characters Shift_JIS cannot encode, including invisible ones", () => {
    const result = countText("〜a〜‍€", lf);
    expect(result.unencodable).toEqual([
      { codePoint: 0x301c, char: "〜", count: 2, invisible: false },
      { codePoint: 0x200d, char: "‍", count: 1, invisible: true },
      { codePoint: 0x20ac, char: "€", count: 1, invisible: false },
    ]);
    expect(result.width.unencodable).toBe(4);
  });

  it("keeps at most 20 kinds of unencodable characters", () => {
    const text = Array.from({ length: 30 }, (_, index) =>
      String.fromCodePoint(0x1f600 + index),
    ).join("");
    const result = countText(text, lf);
    expect(result.unencodable).toHaveLength(20);
    expect(result.width.unencodable).toBe(30);
  });

  it("rejects input over 1 MiB", () => {
    expect(() => countText("a".repeat(1024 * 1024 + 1), lf)).toThrow("1MiB");
  });
});

describe("formatCodePoint", () => {
  it("pads to four hex digits", () => {
    expect(formatCodePoint(0xa)).toBe("U+000A");
    expect(formatCodePoint(0x1f600)).toBe("U+1F600");
  });
});
