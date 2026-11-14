import { describe, expect, it } from "vitest";
import { breakUnits, mayTrimAtLineEnd, shapingUnits, trimTrailingSpaces } from "./lineBreak";

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

  it("breakAfterSolidus (WebKit) なら / の後で折り返す。数字の前と、/ の並びの間では折り返さない", () => {
    const webkit = { breakAfterSolidus: true };
    expect(breakUnits("qux/quux", webkit)).toEqual(["qux/", "quux"]);
    expect(breakUnits("1/2", webkit)).toEqual(["1/2"]);
    expect(breakUnits("https://example.com/path?q=1", webkit)).toEqual([
      "https://",
      "example.com/",
      "path?",
      "q=1",
    ]);
    expect(breakUnits("qux/quux", { breakAfterSolidus: false })).toEqual(["qux/quux"]);
  });

  it("空白の後は、続く文字が句読点や閉じ括弧でも分ける (どのエンジンも同じ)", () => {
    expect(breakUnits("a \u3001b")).toEqual(["a ", "\u3001", "b"]);
    expect(breakUnits("x = ?")).toEqual(["x ", "= ", "?"]);
    expect(breakUnits("( a )")).toEqual(["( ", "a ", ")"]);
  });

  it("三点リーダの後は欧文やダッシュの前でも分ける (前では分けない)", () => {
    expect(breakUnits("あ\u2026\u2026abc")).toEqual(["あ\u2026\u2026", "abc"]);
    expect(breakUnits("x\u2026y")).toEqual(["x\u2026", "y"]);
    expect(breakUnits("\u2026\u2026\u2015\u2015")).toEqual(["\u2026\u2026", "\u2015\u2015"]);
    expect(breakUnits("\u2026\u300d")).toEqual(["\u2026\u300d"]);
  });

  it("/ の前では分けず、後ろは和文の前で分ける", () => {
    expect(breakUnits("円/個")).toEqual(["円/", "個"]);
    expect(breakUnits("abc/123 x/y")).toEqual(["abc/123 ", "x/y"]);
  });

  it("ASCII の引用符の前後では分けない。欧文の後ろの閉じの引用符と和文の間でも分けない", () => {
    expect(breakUnits('は"テスト"です')).toEqual(['は"テ', "ス", 'ト"で', "す"]);
    expect(breakUnits("It's 'a'は")).toEqual(["It's ", "'a'は"]);
    expect(breakUnits("\u2018a\u2019は")).toEqual(["\u2018a\u2019は"]);
    expect(breakUnits("\u201cテ\u201dで")).toEqual(["\u201cテ\u201d", "で"]);
  });

  it("前置の記号 (通貨記号など) の後では分けない。¥ や € の前は : などの後から分ける", () => {
    expect(breakUnits("価格\uffe51,000")).toEqual(["価", "格", "\uffe51,000"]);
    expect(breakUnits("$5 +5 \u00a51,000")).toEqual(["$5 ", "+5 ", "\u00a51,000"]);
    expect(breakUnits("C:\\Users a.\u20acc")).toEqual(["C:\\Users ", "a.", "\u20acc"]);
  });

  it("breakBeforeAsciiPrefix (WebKit) なら、: などと前置の記号の間、前置の記号の並びの間でも分ける", () => {
    const webkit = { breakBeforeAsciiPrefix: true };
    expect(breakUnits("C:\\Users\\name", webkit)).toEqual(["C:", "\\Users\\name"]);
    expect(breakUnits("a:\\\\b a,+b", webkit)).toEqual(["a:", "\\", "\\b ", "a,", "+b"]);
  });

  it("- の後の数字は、breakHyphenBeforeDigit (Chromium) なら単語の途中だけ分ける。ほかのハイフンは数字の前でも分ける", () => {
    const chromium = { breakHyphenBeforeDigit: true };
    expect(breakUnits("1-2 a-1 -1")).toEqual(["1-2 ", "a-1 ", "-1"]);
    expect(breakUnits("1-2 a-1 -1 (-1)", chromium)).toEqual([
      "1-",
      "2 ",
      "a-",
      "1 ",
      "-1 ",
      "(-1)",
    ]);
    expect(breakUnits("1\u20132")).toEqual(["1\u2013", "2"]);
  });

  it("breakAfterSolidus (WebKit) なら、/ の後で数字の前でも分ける (数字にはさまれた / を除く)", () => {
    const webkit = { breakAfterSolidus: true };
    expect(breakUnits("abc/123 a/1b 1/2/3", webkit)).toEqual([
      "abc/",
      "123 ",
      "a/",
      "1b ",
      "1/2/3",
    ]);
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

  it("keepIdeographicSpace (WebKit) でも、全角の空白は後ろで分け、前では分けない", () => {
    expect(breakUnits("見出し\u3000テキスト", { keepIdeographicSpace: true })).toEqual([
      "見",
      "出",
      "し\u3000",
      "テ",
      "キ",
      "ス",
      "ト",
    ]);
    expect(breakUnits("ab\u3000\u3001cd", { keepIdeographicSpace: true })).toEqual([
      "ab\u3000\u3001",
      "cd",
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

  it("keepIdeographicSpace (WebKit) なら全角の空白はぶら下げない", () => {
    expect(trimTrailingSpaces("ab\u3000 \t", { keepIdeographicSpace: true })).toBe("ab\u3000");
  });
});

describe("shapingUnits", () => {
  it("行分割の単位に加えて、小書きのかなと長音記号の前でも分ける (句読点はまとめたまま)", () => {
    expect(breakUnits("ちょっとコーヒー。")).toEqual(["ちょっ", "と", "コー", "ヒー。"]);
    expect(shapingUnits("ちょっとコーヒー。")).toEqual([
      "ち",
      "ょ",
      "っ",
      "と",
      "コ",
      "ー",
      "ヒ",
      "ー。",
    ]);
    expect(shapingUnits("Hello world")).toEqual(["Hello ", "world"]);
  });
});

describe("mayTrimAtLineEnd", () => {
  it("全角の閉じ括弧、全角の読点・句点、閉じの引用符", () => {
    for (const ch of ["\u300d", "\uff09", "\u301b", "\u3001", "\u3002", "\u201d"])
      expect(mayTrimAtLineEnd(ch.charCodeAt(0))).toBe(true);
    for (const ch of [")", "あ", "\u300c"]) expect(mayTrimAtLineEnd(ch.charCodeAt(0))).toBe(false);
  });
});
