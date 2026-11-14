import { describe, expect, it } from "vitest";
import { breakUnits, trimTrailingSpaces } from "./lineBreak";

describe("breakUnits", () => {
  it("欧文は空白の後で分け、空白は前の単位に含める", () => {
    expect(breakUnits("Hello world")).toEqual(["Hello ", "world"]);
    expect(breakUnits("a  b")).toEqual(["a  ", "b"]);
    expect(breakUnits("  lead")).toEqual(["  ", "lead"]);
    expect(breakUnits("Hello, world.")).toEqual(["Hello, ", "world."]);
  });

  it("和文は文字の間で分ける", () => {
    expect(breakUnits("日本語")).toEqual(["日", "本", "語"]);
    expect(breakUnits("あ😀い")).toEqual(["あ", "😀", "い"]);
  });

  it("行頭禁則の文字 (句読点・閉じ括弧・小書きのかな・長音記号) の前では分けない", () => {
    expect(breakUnits("語。です")).toEqual(["語。", "で", "す"]);
    expect(breakUnits("ちょっと")).toEqual(["ちょっ", "と"]);
    expect(breakUnits("コーヒー、")).toEqual(["コー", "ヒー、"]);
    expect(breakUnits("あ）」い")).toEqual(["あ）」", "い"]);
    expect(breakUnits("え……")).toEqual(["え……"]);
    expect(breakUnits("100%")).toEqual(["100%"]);
  });

  it("行末禁則の文字 (開き括弧) の後では分けない", () => {
    expect(breakUnits("「あ」い")).toEqual(["「あ」", "い"]);
    expect(breakUnits("い（う）")).toEqual(["い", "（う）"]);
  });

  it("和文と欧文の間は分けられる。全角の句読点の後も分けられる", () => {
    expect(breakUnits("Windows版")).toEqual(["Windows", "版"]);
    expect(breakUnits("版Windows")).toEqual(["版", "Windows"]);
    expect(breakUnits("です。Hello")).toEqual(["で", "す。", "Hello"]);
    expect(breakUnits("abc「x」")).toEqual(["abc", "「x」"]);
  });

  it("! と ? の後は欧文の前でも分けられる (前では分けない)", () => {
    expect(breakUnits("a?query=1")).toEqual(["a?", "query=1"]);
    expect(breakUnits("Hi!there")).toEqual(["Hi!", "there"]);
    expect(breakUnits("本当？うん")).toEqual(["本", "当？", "う", "ん"]);
  });

  it("ASCII の括弧と句読点は欧文の単語から離さない", () => {
    expect(breakUnits("(abc)def")).toEqual(["(abc)def"]);
    expect(breakUnits("e.g.")).toEqual(["e.g."]);
  });

  it("ハイフンの後で分ける。数字の前と、ハイフンの前と、/ の後では分けない", () => {
    expect(breakUnits("foo-bar")).toEqual(["foo-", "bar"]);
    expect(breakUnits("-1")).toEqual(["-1"]);
    expect(breakUnits("a/b")).toEqual(["a/b"]);
    expect(breakUnits("あ-い")).toEqual(["あ-", "い"]);
  });

  it("ノーブレークスペースの前後とゼロ幅スペースの扱い", () => {
    expect(breakUnits("a\u00a0b c")).toEqual(["a\u00a0b ", "c"]);
    expect(breakUnits("ab\u200bcd")).toEqual(["ab\u200b", "cd"]);
  });

  it("全角の空白は後ろで分け、前では分けない", () => {
    expect(breakUnits("見出し\u3000テキスト")).toEqual([
      "見",
      "出",
      "し\u3000",
      "テ",
      "キ",
      "ス",
      "ト",
    ]);
  });

  it("書記素クラスタを割らない", () => {
    expect(breakUnits("👨\u200d👩\u200d👧👍🏽")).toEqual(["👨\u200d👩\u200d👧", "👍🏽"]);
    expect(breakUnits("か\u3099き")).toEqual(["か\u3099", "き"]);
  });

  it("単位をつなぐと元の文字列に戻る。空の段落は空の単位 1 つ", () => {
    const text = "Hello, 世界！ ちょっと(test) 「かぎ」-1 👍🏽";
    expect(breakUnits(text).join("")).toBe(text);
    expect(breakUnits("")).toEqual([""]);
  });
});

describe("trimTrailingSpaces", () => {
  it("行末の空白 (タブと全角の空白を含む) を落とす", () => {
    expect(trimTrailingSpaces("ab \t\u3000")).toBe("ab");
    expect(trimTrailingSpaces("ab")).toBe("ab");
    expect(trimTrailingSpaces("   ")).toBe("");
    expect(trimTrailingSpaces("a\u00a0")).toBe("a\u00a0");
  });
});
