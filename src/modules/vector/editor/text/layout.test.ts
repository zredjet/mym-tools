import { describe, expect, it } from "vitest";
import { createText } from "../model/create";
import type { TextNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import type { FontSpec, TextMeasurer } from "../render/types";
import { ceilSize, layoutText, lineHeightOf, wrapLimit } from "./layout";
import type { MetricsTextMeasurer } from "./metrics";

// フォントサイズ 10: 1 文字 (コードポイント) の幅は 5、行の高さは 14
const measurer = fixedWidthMeasurer();

function text(init: Partial<TextNode>): TextNode {
  return createText({ fontSize: 10, ...init });
}

const lineTexts = (node: TextNode, m: TextMeasurer = measurer) =>
  layoutText(node, m).lines.map((line) => line.text);

describe("layoutText: 改行と auto-width", () => {
  it("\\n で改行し、空行と末尾の改行は空の行になる", () => {
    const layout = layoutText(text({ text: "ab\n\ncd\n" }), measurer);
    expect(layout.lines.map((line) => line.text)).toEqual(["ab", "", "cd", ""]);
    expect(layout.lines.map((line) => line.width)).toEqual([10, 0, 10, 0]);
    expect(layout.width).toBe(10);
    expect(layout.height).toBe(56);
  });

  it("空の本文は空の行 1 つ", () => {
    const layout = layoutText(text({ text: "" }), measurer);
    expect(layout.lines).toHaveLength(1);
    expect(layout).toMatchObject({ width: 0, height: 14 });
  });

  it("auto-width は幅があっても折り返さず、行末の空白も幅に数える", () => {
    const layout = layoutText(text({ text: "abcdefgh  ", width: 10 }), measurer);
    expect(layout.lines.map((line) => line.text)).toEqual(["abcdefgh  "]);
    expect(layout.width).toBe(50);
  });

  it("ベースラインは行の高さの中央に、アセントとディセントの差の半分を足した位置", () => {
    // 既定の比率: (14 + 10 × 0.7) / 2 = 10.5
    expect(layoutText(text({ text: "a\nb" }), measurer).lines.map((line) => line.y)).toEqual([
      10.5, 24.5,
    ]);
    const withMetrics: MetricsTextMeasurer = {
      measure: measurer.measure,
      fontMetrics: () => ({ ascent: 9, descent: 3 }),
    };
    // (14 + 9 - 3) / 2 = 10
    expect(
      layoutText(text({ text: "a\nb", lineHeight: 20 }), withMetrics).lines.map((line) => line.y),
    ).toEqual([13, 33]);
  });

  it("行の高さは lineHeight、null ならフォントサイズ × 1.4", () => {
    expect(lineHeightOf(text({ lineHeight: 30 }))).toBe(30);
    expect(lineHeightOf(text({ lineHeight: null }))).toBe(14);
    expect(layoutText(text({ text: "a\nb\nc", lineHeight: 30 }), measurer).height).toBe(90);
  });
});

describe("layoutText: 折り返し", () => {
  it("和文は文字の間で折り返す", () => {
    const node = text({ text: "あいうえおかき", sizing: "auto-height", width: 20 });
    expect(lineTexts(node)).toEqual(["あいうえ", "おかき"]);
    expect(layoutText(node, measurer).height).toBe(28);
  });

  it("行頭禁則の文字は前の行に残す (前の文字と一緒に次の行へ送る)", () => {
    expect(lineTexts(text({ text: "あいうえ。かき", sizing: "auto-height", width: 20 }))).toEqual([
      "あいう",
      "え。かき",
    ]);
    expect(lineTexts(text({ text: "あいうえっと", sizing: "auto-height", width: 20 }))).toEqual([
      "あいう",
      "えっと",
    ]);
  });

  it("開き括弧は行末に残さない", () => {
    expect(lineTexts(text({ text: "あいう「え」", sizing: "auto-height", width: 20 }))).toEqual([
      "あいう",
      "「え」",
    ]);
  });

  it("欧文は単語の間で折り返し、行末の空白はぶら下げる", () => {
    const node = text({ text: "Hello world foo", sizing: "auto-height", width: 30 });
    const layout = layoutText(node, measurer);
    expect(layout.lines.map((line) => line.text)).toEqual(["Hello ", "world ", "foo"]);
    // 行の幅は行末の空白を数えない
    expect(layout.lines.map((line) => line.width)).toEqual([25, 25, 15]);
  });

  it("幅に収まらない単語は文字で折る。収まらない単語は先に次の行へ送ってから折る", () => {
    expect(lineTexts(text({ text: "abcdefghij", sizing: "auto-height", width: 20 }))).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    expect(lineTexts(text({ text: "ab abcdefghij x", sizing: "auto-height", width: 20 }))).toEqual([
      "ab ",
      "abcd",
      "efgh",
      "ij x",
    ]);
  });

  it("幅 0 でも 1 行に 1 文字は置き、止まる", () => {
    expect(lineTexts(text({ text: "abc", sizing: "auto-height", width: 0 }))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("書記素クラスタ (絵文字の並び、結合文字) を割らない", () => {
    // 👍🏽 は 2 コードポイント = 幅 10、家族の絵文字は 5 コードポイント = 幅 25
    expect(lineTexts(text({ text: "👍🏽👍🏽", sizing: "auto-height", width: 5 }))).toEqual([
      "👍🏽",
      "👍🏽",
    ]);
    expect(
      lineTexts(text({ text: "a👨\u200d👩\u200d👧", sizing: "auto-height", width: 5 })),
    ).toEqual(["a", "👨\u200d👩\u200d👧"]);
    expect(lineTexts(text({ text: "か\u3099か\u3099", sizing: "auto-height", width: 5 }))).toEqual([
      "か\u3099",
      "か\u3099",
    ]);
  });

  it("計測が返すエンジンの折り返しの規則に従う (WebKit は / の後で折り返す)", () => {
    const node = text({ text: "see foo/barbaz", sizing: "auto-height", width: 40 });
    expect(lineTexts(node)).toEqual(["see ", "foo/barb", "az"]);
    const webkit: MetricsTextMeasurer = {
      measure: measurer.measure,
      fontMetrics: () => null,
      lineBreakOptions: () => ({ breakAfterSolidus: true }),
    };
    expect(lineTexts(node, webkit)).toEqual(["see foo/", "barbaz"]);
  });

  it("段落ごとに折り返し、空行を残す", () => {
    expect(
      lineTexts(text({ text: "あいうえお\n\nかき", sizing: "auto-height", width: 20 })),
    ).toEqual(["あいうえ", "お", "", "かき"]);
  });

  it("fixed も幅で折り返す。高さを超えた行もそのまま返す (はみ出して描く)", () => {
    const node = text({ text: "あいうえおかき", sizing: "fixed", width: 20, height: 10 });
    const layout = layoutText(node, measurer);
    expect(layout.lines.map((line) => line.text)).toEqual(["あいうえ", "おかき"]);
    expect(layout.height).toBe(28);
  });

  it("字間を幅に含めて折り返す", () => {
    // 字間 1 で 1 文字 6
    const node = text({ text: "あいう", sizing: "auto-height", width: 12, letterSpacing: 1 });
    const layout = layoutText(node, measurer);
    expect(layout.lines.map((line) => line.text)).toEqual(["あい", "う"]);
    expect(layout.lines.map((line) => line.width)).toEqual([12, 6]);
  });

  it("幅は行全体を測った値で決める (単位ごとの和より狭ければもっと入れる)", () => {
    // 文字の間ごとに 2 狭くなる (カーニングの代わり)
    const kerned: TextMeasurer = {
      measure: (value: string, font: FontSpec) =>
        measurer.measure(value, font) - Math.max(0, Array.from(value).length - 1) * 2,
    };
    // 単位ごとの和: "aa " 11 + "bbbb" 14 → 25 に見積もるが、行全体は 23 で幅 24 に入る
    const node = text({ text: "aa bbbb", sizing: "auto-height", width: 24 });
    expect(lineTexts(node, kerned)).toEqual(["aa bbbb"]);
  });

  it("行全体が単位ごとの和より広ければ、入らない単位を次の行へ送る", () => {
    // 2 文字以上の文字列は 1 文字につき 1 広い
    const wide: TextMeasurer = {
      measure: (value: string, font: FontSpec) => {
        const base = measurer.measure(value, font);
        const count = Array.from(value).length;
        return count > 1 ? base + count : base;
      },
    };
    // 1 文字ずつの和は 20 で幅 20 に入るが、"あいうえ" は 24 になる
    const node = text({ text: "あいうえ", sizing: "auto-height", width: 20 });
    expect(lineTexts(node, wide)).toEqual(["あいう", "え"]);
  });

  it("長い本文でも求められる", () => {
    const long = "あいうえお、かきくけこ。Hello world! ".repeat(2000);
    const layout = layoutText(text({ text: long, sizing: "auto-height", width: 300 }), measurer);
    expect(layout.lines.length).toBeGreaterThan(100);
    expect(layout.lines.map((line) => line.text).join("")).toBe(long);
    expect(layout.lines.every((line) => line.width <= 300)).toBe(true);
  });
});

describe("layoutText: 空白のない長い文字列", () => {
  /** 計測に渡した文字列の長さの合計を数える (時間の代わりに、仕事の量を決まった値で比べる)。 */
  function run(n: number, width: number) {
    let chars = 0;
    const counting: TextMeasurer = {
      measure(value, font) {
        chars += value.length;
        return measurer.measure(value, font);
      },
    };
    const node = text({ text: "a".repeat(n), sizing: "auto-height", width });
    const started = performance.now();
    const layout = layoutText(node, counting);
    return { chars, ms: performance.now() - started, layout };
  }

  for (const width of [300, 5]) {
    it(`幅 ${width}: 文字数を 2 倍にしても、仕事の量と時間は 4 倍にならない`, () => {
      const small = run(50_000, width);
      const large = run(100_000, width);
      expect(large.layout.lines.map((line) => line.text).join("")).toBe("a".repeat(100_000));
      expect(large.layout.lines.every((line) => line.width <= Math.max(width, 5))).toBe(true);
      expect(large.chars).toBeLessThan(small.chars * 2.5);
      expect(large.ms).toBeLessThan(small.ms * 4 + 50);
      // 上限いっぱい (100,000 文字) でも固まらない
      expect(large.ms).toBeLessThan(2_000);
    });
  }

  it("長い単語を割った残りは、続く単語と同じ行に並ぶ", () => {
    const node = text({ text: `${"a".repeat(10)} bb cc`, sizing: "auto-height", width: 20 });
    expect(lineTexts(node)).toEqual(["aaaa", "aaaa", "aa ", "bb ", "cc"]);
    const wide = text({ text: `${"a".repeat(10)} b`, sizing: "auto-height", width: 30 });
    expect(lineTexts(wide)).toEqual(["aaaaaa", "aaaa b"]);
  });
});

describe("layoutText: 揃え", () => {
  it("auto-height と fixed はノードの幅の中で揃える", () => {
    const at = (align: TextNode["align"]) =>
      layoutText(text({ text: "ab", align, sizing: "auto-height", width: 40 }), measurer).lines[0]
        ?.x;
    expect(at("left")).toBe(0);
    expect(at("center")).toBe(15);
    expect(at("right")).toBe(30);
  });

  it("auto-width は内容の幅 (切り上げ) の中で揃える", () => {
    const layout = layoutText(text({ text: "ab\nabcd", align: "center", width: 999 }), measurer);
    expect(layout.lines.map((line) => line.x)).toEqual([5, 0]);
    const right = layoutText(text({ text: "a\nabc", align: "right" }), measurer);
    expect(right.lines.map((line) => line.x)).toEqual([10, 0]);
  });

  it("行末にぶら下げた空白は揃えに数えない", () => {
    const layout = layoutText(
      text({ text: "abc   def", align: "right", sizing: "auto-height", width: 20 }),
      measurer,
    );
    expect(layout.lines.map((line) => [line.text, line.x])).toEqual([
      ["abc   ", 5],
      ["def", 5],
    ]);
  });
});

describe("layoutText: 使い回し", () => {
  it("同じノードと計測なら同じ結果を返し、ノードが変われば求め直す", () => {
    const node = text({ text: "abc" });
    const first = layoutText(node, measurer);
    expect(layoutText(node, measurer)).toBe(first);
    expect(layoutText({ ...node }, measurer)).not.toBe(first);
    expect(layoutText(node, fixedWidthMeasurer(1)).width).toBe(30);
  });
});

describe("wrapLimit", () => {
  it("行の幅を 1/64 px に四捨五入して枠と比べる (ブラウザと同じ)", () => {
    const fits = (width: number, box: number) => width < wrapLimit(box);
    expect(fits(130, 130)).toBe(true);
    expect(fits(130.015625, 130)).toBe(false); // 1/64 px はみ出す
    expect(fits(100.632, 100.625)).toBe(true); // 端数 0.448 / 64 は切り捨てられて収まる
    expect(fits(100.6328125 + 0.001, 100.625)).toBe(false); // 端数が 0.5 / 64 を超えると収まらない
    // auto-width を同じ幅の auto-height にしても折り返さない
    expect(fits(99.9995, ceilSize(99.9995))).toBe(true);
  });

  it("行の幅がちょうど 1/64 px はみ出すなら折り返す", () => {
    const measure: TextMeasurer = { measure: (value) => (value === "ab" ? 130.015625 : 65) };
    const node = text({ text: "ab", sizing: "auto-height", width: 130 });
    expect(lineTexts(node, measure)).toEqual(["a", "b"]);
    const fitting: TextMeasurer = { measure: (value) => (value === "ab" ? 130.007 : 65) };
    expect(lineTexts(node, fitting)).toEqual(["ab"]);
  });
});

describe("ceilSize", () => {
  it("切り上げた整数にする。浮動小数の誤差では切り上げない", () => {
    expect(ceilSize(22.4)).toBe(23);
    expect(ceilSize(24)).toBe(24);
    expect(ceilSize(14 * 5 + 1e-12)).toBe(70);
    expect(ceilSize(-3)).toBe(0);
    expect(ceilSize(1e9)).toBe(100000);
  });
});
