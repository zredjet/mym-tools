import { describe, expect, it } from "vitest";
import { graphemeCount, splitGraphemes } from "./graphemes";

describe("splitGraphemes", () => {
  it("ASCII と和文は 1 文字ずつ", () => {
    expect(splitGraphemes("ab日本")).toEqual(["a", "b", "日", "本"]);
    expect(splitGraphemes("")).toEqual([]);
  });

  it("サロゲートペアを割らない", () => {
    expect(splitGraphemes("𠮷野家")).toEqual(["𠮷", "野", "家"]);
  });

  it("結合文字は前の文字にくっつける", () => {
    expect(splitGraphemes("か\u3099き")).toEqual(["か\u3099", "き"]);
    expect(splitGraphemes("e\u0301x")).toEqual(["e\u0301", "x"]);
    expect(splitGraphemes("ｶ\uff9eｷ")).toEqual(["ｶ\uff9e", "ｷ"]);
    expect(splitGraphemes("葛\u{E0100}城")).toEqual(["葛\u{E0100}", "城"]);
  });

  it("絵文字の修飾、ZWJ の並び、キーキャップ、国旗を 1 つにする", () => {
    expect(splitGraphemes("a👍🏽b")).toEqual(["a", "👍🏽", "b"]);
    expect(splitGraphemes("👨\u200d👩\u200d👧x")).toEqual(["👨\u200d👩\u200d👧", "x"]);
    expect(splitGraphemes("1\ufe0f\u20e3")).toEqual(["1\ufe0f\u20e3"]);
    expect(splitGraphemes("🇯🇵🇺🇸🇫")).toEqual(["🇯🇵", "🇺🇸", "🇫"]);
    expect(splitGraphemes("🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}")).toHaveLength(
      1,
    );
  });

  it("改行の前後では分け、CR LF は 1 つにする", () => {
    expect(splitGraphemes("a\n\u0301")).toEqual(["a", "\n", "\u0301"]);
    expect(splitGraphemes("a\r\nb")).toEqual(["a", "\r\n", "b"]);
  });

  it("対になっていないサロゲートも 1 つとして扱い、止まらない", () => {
    expect(splitGraphemes("\uD800a\uDC00")).toEqual(["\uD800", "a", "\uDC00"]);
  });
});

describe("graphemeCount", () => {
  it("書記素クラスタの数を数える", () => {
    expect(graphemeCount("abc")).toBe(3);
    expect(graphemeCount("a👍🏽か\u3099")).toBe(3);
    expect(graphemeCount("")).toBe(0);
  });
});
