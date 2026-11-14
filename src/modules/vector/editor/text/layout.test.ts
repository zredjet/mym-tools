import { describe, expect, it, vi } from "vitest";
import { createText } from "../model/create";
import type { TextNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import type { FontSpec, LayoutText, TextMeasurer } from "../render/types";
import { ceilSize, editorLineWidth, layoutText, lineHeightOf, wrapLimit } from "./layout";
import type { FitProbe } from "./lineFit";
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

  describe("単位ごとに組むエンジン (WebKit)", () => {
    // 行全体を測ると隣り合う文字の間ごとに 1 狭い (カーニング)。単位ごとに測ると、その分は入らない
    const kerned: TextMeasurer = {
      measure: (value: string, font: FontSpec) =>
        measurer.measure(value, font) - Math.max(0, Array.from(value).length - 1),
    };
    const perUnit: MetricsTextMeasurer = {
      measure: kerned.measure,
      fontMetrics: () => null,
      lineBreakOptions: () => ({ shapePerUnit: true }),
    };

    it("折り返すかどうかは単位ごとの幅の和で判定し、行の幅と揃えは行全体の幅 (描画) で求める", () => {
      // "あいうえお" は行全体で 25 - 4 = 21、単位ごとの和なら 25
      const node = text({ text: "あいうえお", sizing: "auto-height", width: 22, align: "right" });
      expect(lineTexts(node, kerned)).toEqual(["あいうえお"]);
      const layout = layoutText(node, perUnit);
      expect(layout.lines.map((line) => line.text)).toEqual(["あいうえ", "お"]);
      // 行の幅は描画の幅 (あいうえ: 20 - 3 = 17)。右揃えの x は 22 - 17
      expect(layout.lines.map((line) => [line.width, line.x])).toEqual([
        [17, 5],
        [5, 17],
      ]);
    });

    it("単位の中のカーニングは入る (行頭禁則でまとめた単位)", () => {
      // "ちょっ" は 1 単位で 15 - 2 = 13。"ちょっと" は 13 + 5 = 18 で幅 18 に入る
      const node = text({ text: "ちょっと", sizing: "auto-height", width: 18 });
      expect(lineTexts(node, perUnit)).toEqual(["ちょっと"]);
    });

    it("折り返しの判定には、計測が返す編集欄の幅 (editorWidth) を使う", () => {
      // 編集欄は 1 文字ずつ組む (カーニングなし)
      const editor: MetricsTextMeasurer = {
        measure: kerned.measure,
        fontMetrics: () => null,
        editorWidth: (value: string, font: FontSpec) => measurer.measure(value, font),
      };
      const node = text({ text: "あいうえお", sizing: "auto-height", width: 22 });
      expect(lineTexts(node, editor)).toEqual(["あいうえ", "お"]);
    });

    it("編集欄の行の幅 (auto-width の入力欄の幅) は計測の editorWidth。持たなければ描画の幅", () => {
      const node = text({ text: "あいうえお\nab" });
      const editor: MetricsTextMeasurer = {
        ...perUnit,
        editorWidth: (value: string, font: FontSpec) => measurer.measure(value, font),
      };
      expect(editorLineWidth(node, editor)).toBe(25);
      expect(layoutText(node, editor).width).toBe(21);
      expect(editorLineWidth(node, kerned)).toBe(21);
    });
  });

  describe("行末の約物を詰めるエンジン (Chromium の text-spacing-trim)", () => {
    const trimming: MetricsTextMeasurer = {
      measure: measurer.measure,
      fontMetrics: () => null,
      // 」 は半分詰める。」 の後の 、 も半分詰める (前の文字で変わる例)。ほかは詰めない
      lineEndTrim: (previous: string, last: string) =>
        last === "」" || (last === "、" && previous === "」") ? 0.5 : 0,
    };

    it("収まらない行も、行末の閉じ括弧を詰めて収まるなら収め、詰めた幅で揃える", () => {
      // "あいう」" は 20。詰めると 17.5 で幅 18 に入る
      const node = text({ text: "あいう」えお", sizing: "auto-height", width: 18, align: "right" });
      expect(lineTexts(node)).toEqual(["あい", "う」え", "お"]);
      const layout = layoutText(node, trimming);
      expect(layout.lines.map((line) => line.text)).toEqual(["あいう」", "えお"]);
      expect(layout.lines.map((line) => [line.width, line.x])).toEqual([
        [17.5, 0.5],
        [10, 8],
      ]);
    });

    it("詰められない文字 (割合が 0 の読点、ほかの文字) では詰めない。収まる行は詰めない", () => {
      expect(
        lineTexts(text({ text: "あいう、えお", sizing: "auto-height", width: 18 }), trimming),
      ).toEqual(["あい", "う、え", "お"]);
      const fits = layoutText(
        text({ text: "あいう」", sizing: "auto-height", width: 20 }),
        trimming,
      );
      expect(fits.lines.map((line) => line.width)).toEqual([20]);
    });

    it("単位の途中で割るときは、続く約物との詰め (、。 の 、) を割った後も残す (Chromium の編集欄と同じ)", () => {
      // 、 の後に 。 が続くと、、 が半分 (2.5) 詰まる (canvas の幅に出る)
      const adjacent: TextMeasurer = {
        measure: (value: string, font: FontSpec) =>
          measurer.measure(value, font) - 2.5 * (value.split("、。").length - 1),
      };
      const node = text({ text: "あ、。、。、。", sizing: "auto-height", width: 15 });
      expect(lineTexts(node, adjacent)).toEqual(["あ、。、", "。、。"]);
      // 詰めないエンジンでは、割った行は字幅どおり
      expect(lineTexts(node)).toEqual(["あ、。", "、。、", "。"]);
    });

    it("行の末尾に空白がぶら下がるときは詰めない (空白の後で折り返す)", () => {
      // "あいう」" は 20 で幅 18 に入らない。後ろに空白があると、詰めずに "う」 " ごと次の行へ送る
      // (空白がなければ "あいう」" を詰めて 1 行目に入れる)
      expect(
        lineTexts(text({ text: "あいう」 えお", sizing: "auto-height", width: 18 }), trimming),
      ).toEqual(["あい", "う」 ", "えお"]);
    });

    it("詰めるかは、前の文字と合わせて計測に聞く", () => {
      // "あい」、" は 20。末尾の 、 を詰めると 17.5
      expect(
        lineTexts(text({ text: "あい」、えお", sizing: "auto-height", width: 18 }), trimming),
      ).toEqual(["あい」、", "えお"]);
    });
  });

  it("収まるかは、編集欄の幅と描画の幅の広いほうで判定する (描いた行が枠からはみ出さない)", () => {
    // 編集欄は描画より 1 文字につき 1 狭い (WebKit の字間: 描画は符号位置ごと、編集欄は書記素ごと)
    const narrowEditor: MetricsTextMeasurer = {
      measure: measurer.measure,
      fontMetrics: () => null,
      editorWidth: (value: string, font: FontSpec) =>
        measurer.measure(value, font) - Array.from(value).length,
    };
    const node = text({ text: "あいうえおか", sizing: "auto-height", width: 22 });
    const layout = layoutText(node, narrowEditor);
    expect(layout.lines.map((line) => line.text)).toEqual(["あいうえ", "おか"]);
    for (const line of layout.lines) expect(line.width).toBeLessThan(22);
  });

  it("全角の空白をぶら下げないエンジン (WebKit) では、幅に数えて折り返す", () => {
    const node = text({ text: "ああああ\u3000い", sizing: "auto-height", width: 20 });
    expect(lineTexts(node)).toEqual(["ああああ\u3000", "い"]);
    const webkit: MetricsTextMeasurer = {
      measure: measurer.measure,
      fontMetrics: () => null,
      lineBreakOptions: () => ({ keepIdeographicSpace: true }),
    };
    expect(lineTexts(node, webkit)).toEqual(["あああ", "あ\u3000い"]);
  });

  it("編集欄の幅は、タブを次のタブ位置 (空白 1 つの幅ごと、近すぎればその次) まで進める", () => {
    // a = 7、空白とタブと b = 5 (描画はタブを空白 1 つとして描く)
    const widths: Record<string, number> = { a: 7, b: 5, " ": 5, "\t": 5 };
    const tabbed: TextMeasurer = {
      measure: (value: string) => Array.from(value).reduce((sum, ch) => sum + (widths[ch] ?? 0), 0),
    };
    // 7 → 10 (次のタブ位置) → 15
    expect(editorLineWidth(text({ text: "a\tb" }), tabbed)).toBe(15);
    // 7 + 7 = 14 → 15 は 1 しか進まないので 20 → 25
    expect(editorLineWidth(text({ text: "aa\tb" }), tabbed)).toBe(25);
    expect(layoutText(text({ text: "aa\tb" }), tabbed).width).toBe(24);
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

describe("layoutText: 見積もりがカーニングで大きく外れる長い行", () => {
  /**
   * 行全体を測ると、隣り合う文字の間ごとに 1 狭い (フォントサイズ 20 で 1 文字 10)。1 文字ずつの幅の和の
   * 見積もりは、1 行 (1 万字余り) で 1,000 字ほど外れる。計測の呼び出しと、渡した文字数を数える
   */
  function kerned(options: { perUnit?: boolean } = {}) {
    const work = { calls: 0, chars: 0, longCalls: 0 };
    const width = (value: string, font: FontSpec) =>
      measurer.measure(value, font) - Math.max(0, Array.from(value).length - 1);
    const counted = (value: string, font: FontSpec) => {
      work.calls++;
      work.chars += value.length;
      if (value.length >= 1000) work.longCalls++;
      return width(value, font);
    };
    const perUnit: MetricsTextMeasurer = {
      measure: counted,
      editorWidth: counted,
      fontMetrics: () => null,
      lineBreakOptions: () => ({ shapePerUnit: true }),
    };
    const kernedMeasurer: TextMeasurer = options.perUnit ? perUnit : { measure: counted };
    return { measurer: kernedMeasurer, work, width };
  }

  /** 1 行を確かめる回数の上限 (`lineFit.ts` の 2 log2(個数) + 7。個数は 100,000 字)。 */
  const PROBES_PER_LINE = 2 * Math.ceil(Math.log2(100_001)) + 7;

  for (const [name, body, options] of [
    ["空白のない 1 つの単位 (AV の繰り返し)", "AV".repeat(50_000), {}],
    ["1 文字ずつ折り返せる和文", "あ".repeat(100_000), {}],
    ["単位ごとに組むエンジン (WebKit) の 1 つの単位", "AV".repeat(50_000), { perUnit: true }],
  ] as const) {
    it(`${name}: 100,000 字・幅 100,000 でも、行全体を測る回数は行ごとに上限の内`, () => {
      const { measurer: m, work, width } = kerned(options);
      const node = text({ text: body, fontSize: 20, sizing: "auto-height", width: 100_000 });
      const layout = layoutText(node, m);
      const lines = layout.lines.map((line) => line.text);
      expect(lines.join("")).toBe(body);
      // 各行は収まる最大の文字数 (1 文字ずつ足して確かめる前の実装と同じ結果)
      const limit = wrapLimit(100_000);
      const font = {
        family: node.fontFamily,
        size: 20,
        weight: 400,
        italic: false,
        letterSpacing: 0,
      };
      lines.forEach((line, index) => {
        expect(width(line, font)).toBeLessThan(limit);
        const next = lines[index + 1];
        if (next) expect(width(line + next.slice(0, 1), font)).toBeGreaterThanOrEqual(limit);
      });
      // 行全体 (1,000 字以上) を測るのは行ごとに上限の内で、渡す文字数も本文の 20 倍まで
      // (1 文字ずつ伸ばしては測り直すと、行ごとに 1,000 回以上・合わせて 1 億字を超える)
      expect(work.longCalls).toBeLessThanOrEqual(lines.length * PROBES_PER_LINE);
      expect(work.chars).toBeLessThan(body.length * 20);
    });
  }
});

describe("layoutText: 前の探し方 (見積もりから 1 つずつ確かめる) と同じ結果", () => {
  /** `largestFitting` を前の探し方に差し替えた `layoutText` を読み込む。 */
  async function importLinearLayout(): Promise<LayoutText> {
    vi.resetModules();
    vi.doMock("./lineFit", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./lineFit")>()),
      largestFitting(lo: number, hi: number, guess: number, probe: (count: number) => FitProbe) {
        let count = Math.min(hi, Math.max(lo, guess));
        while (count > lo && !probe(count).fits) count--;
        if (probe(count).fits) while (count < hi && probe(count + 1).fits) count++;
        return count;
      },
    }));
    try {
      return (await import("./layout")).layoutText;
    } finally {
      vi.doUnmock("./lineFit");
      vi.resetModules();
    }
  }

  /** 決まった種から作る乱数 (テストを毎回同じにする)。 */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  const PIECES = [
    ..."あいうかき「」、。・ーっゃ漢字",
    " ",
    "　",
    ..."AVWTaobé12-/.,",
    "\t",
    "👍🏽",
    "AVAVAVAVAVAV",
    "aaaaaaaaaaaaaaaaaaaa",
    "https://example.com/abc/def",
  ];
  const pairs = ["AV", "VA", "To", "WA", "Wa"];
  /** 行全体を測ると、カーニングする組ごとに 2 狭い (1 文字は 5) */
  const kernedWidth = (value: string, font: FontSpec) => {
    let pairCount = 0;
    for (const pair of pairs) pairCount += value.split(pair).length - 1;
    return measurer.measure(value, font) - pairCount * 2;
  };
  const measurers: [string, TextMeasurer & Partial<MetricsTextMeasurer>][] = [
    ["字幅どおり", { measure: measurer.measure }],
    ["カーニング", { measure: kernedWidth }],
    [
      "行全体が 3 % 狭い",
      {
        measure: (value, font) =>
          measurer.measure(value, font) * (Array.from(value).length > 1 ? 0.97 : 1),
      },
    ],
    [
      "行全体が 1 文字につき 0.3 広い",
      {
        measure: (value, font) => {
          const count = Array.from(value).length;
          return measurer.measure(value, font) + (count > 1 ? count * 0.3 : 0);
        },
      },
    ],
    [
      "行末の約物を詰める (Chromium)",
      {
        measure: (value, font) =>
          measurer.measure(value, font) - 2.5 * (value.split("、。").length - 1),
        lineEndTrim: (previous, last) =>
          last === "」" || last === "。" || (last === "、" && previous === "」") ? 0.5 : 0,
      },
    ],
    [
      "単位ごとに組む (WebKit)",
      {
        measure: kernedWidth,
        editorWidth: measurer.measure,
        fontMetrics: () => null,
        lineBreakOptions: () => ({
          shapePerUnit: true,
          breakAfterSolidus: true,
          keepIdeographicSpace: true,
        }),
      },
    ],
  ];

  it("ランダムな本文・幅・字間で、行と幅と位置が同じ", async () => {
    const linearLayout = await importLinearLayout();
    const next = random(5);
    for (const [name, m] of measurers) {
      for (let trial = 0; trial < 150; trial++) {
        let body = "";
        const length = trial % 25 === 0 ? 400 : 1 + Math.floor(next() * 40);
        for (let i = 0; i < length; i++) {
          body += PIECES[Math.floor(next() * PIECES.length)] as string;
          if (next() < 0.01) body += "\n";
        }
        const node = text({
          text: body,
          sizing: "auto-height",
          width: Math.round((3 + next() * (trial % 25 === 0 ? 1500 : 300)) * 4) / 4,
          letterSpacing: [0, 0, 1, -0.5][trial % 4] as number,
          align: (["left", "center", "right"] as const)[trial % 3] ?? "left",
        });
        const expected = linearLayout(node, m);
        expect({ name, body, layout: layoutText(node, m) }).toEqual({
          name,
          body,
          layout: expected,
        });
      }
    }
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
