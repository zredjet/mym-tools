/**
 * 文字幅の計測 (`TextMeasurer`) のブラウザ用の実装 (§4.7)。SVG の描画と同じ幅を返す。
 * キャンバス・書き出し・行分割は `canvasTextMeasurer` を使う。
 *
 * - フォントは描画と同じ `font-family` (`cssFont` / `cssFontFamily`) で指定する
 * - 速さのため canvas の `measureText` を使い、描画と幅が違う場合は見えない SVG の `<text>` の
 *   `getComputedTextLength` で測る: 絵文字を含む文字列 (Chromium の canvas は 16px の絵文字を 20px と測る)、
 *   canvas と SVG で幅が合わないフォント (Chromium の `system-ui` など。フォントごとに最初に測り比べる)
 * - 字間は足し算で扱う (Safari 15 の canvas は `letterSpacing` を持たない)。CSS / SVG の
 *   `letter-spacing` と同じく、書記素クラスタごとに付け、最後の文字の後にも付く
 * - ベースラインの位置を決めるため、フォントのアセント・ディセントも返す (`fontMetrics`)。編集欄と同じ
 *   HTML の行の箱から求めるので、編集欄の文字と描画の文字の上下の位置がそろう。契約 (`TextMeasurer`) に
 *   ない追加の口 (`text/metrics.ts`) で、持たない計測では既定の比率を使う
 */
import { graphemeCount } from "../text/graphemes";
import type { LineBreakOptions } from "../text/lineBreak";
import type { FontMetrics, MetricsTextMeasurer } from "../text/metrics";
import { cssFont, cssFontFamily } from "./buildNodeSvg";
import type { FontSpec } from "./types";

/** 字間の合計。書記素クラスタごとに付ける (CSS / SVG の `letter-spacing` と同じ単位)。 */
export function letterSpacingWidth(text: string, letterSpacing: number): number {
  if (letterSpacing === 0 || text === "") return 0;
  return graphemeCount(text) * letterSpacing;
}

/** コードポイントの数 (サロゲートペアを 1 文字と数える)。 */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // 上位サロゲートの次に下位サロゲートが続くなら 2 単位で 1 文字
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** jsdom などレイアウトのない環境か (canvas も SVG の計測も使わない)。 */
function isLayoutlessEnvironment(): boolean {
  return (
    typeof document === "undefined" ||
    typeof navigator === "undefined" ||
    /jsdom/i.test(navigator.userAgent)
  );
}

/** 計測に使う文書。レイアウトのない環境では null。 */
export function defaultMeasureDocument(): Document | null {
  return isLayoutlessEnvironment() ? null : document;
}

/**
 * canvas の 2D コンテキストを 1 つだけ作る。jsdom など canvas が使えない環境では null。
 * `textRendering` があれば `geometricPrecision` にする (Chromium の canvas は既定で字幅を丸め、
 * SVG の描画より広く測る。Safari 15 は持たない)。
 */
export function createMeasureContext(
  getDocument: () => Document | null = defaultMeasureDocument,
): () => CanvasRenderingContext2D | null {
  let context: CanvasRenderingContext2D | null | undefined;
  return () => {
    if (context === undefined) {
      try {
        const doc = getDocument();
        context = doc ? doc.createElement("canvas").getContext("2d") : null;
        const styles = context as (CanvasRenderingContext2D & { textRendering?: string }) | null;
        if (styles && "textRendering" in styles) styles.textRendering = "geometricPrecision";
      } catch {
        context = null;
      }
    }
    return context;
  };
}

/** 文字の種類 (`scriptClasses` のビット)。canvas と描画の幅が合うかを、フォントとこの種類の組で見る。 */
export const LATIN = 1;
export const CJK = 2;
/** そのほかの文字 (ギリシャ・キリル・アラビア文字、記号など)。どのフォントで描かれるかが読めない */
export const OTHER = 4;
export const EMOJI = 8;

function isEmojiCode(code: number): boolean {
  return (
    code === 0x200d ||
    code === 0x20e3 ||
    code === 0xfe0f ||
    (code >= 0x2300 && code <= 0x23ff) ||
    (code >= 0x25a0 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff)
  );
}

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * 文字列に含まれる文字の種類 (`LATIN` | `CJK` | `OTHER` | `EMOJI` のビットの和)。
 * 欧文はラテン文字と一般句読点 (U+0000〜U+024F、U+2000〜U+206F)。和文は CJK の記号・かな・漢字・
 * ハングル・全角形と、U+20000 以降の漢字。絵文字は U+1F000 以降、タグ文字、絵文字になりうる記号と
 * ZWJ・異体字セレクタ 16・キーキャップ。
 */
export function scriptClasses(text: string): number {
  let classes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x250 || (code >= 0x2000 && code <= 0x206f && code !== 0x200d)) classes |= LATIN;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 上位サロゲートで分かる: U+1F000〜U+1FFFF (絵文字、地域指示記号)、U+20000〜U+3FFFF (漢字)、U+E0000 (タグ)
      if (code >= 0xd83c && code <= 0xd83f) classes |= EMOJI;
      else if (code >= 0xd840 && code <= 0xd8bf) classes |= CJK;
      else if (code === 0xdb40) classes |= EMOJI;
      else classes |= OTHER;
      i++;
    } else if (isEmojiCode(code)) classes |= EMOJI;
    else if (isCjkCode(code)) classes |= CJK;
    else classes |= OTHER;
  }
  return classes;
}

/** 絵文字として描かれうる文字を含むか。 */
export function mayContainEmoji(text: string): boolean {
  return (scriptClasses(text) & EMOJI) !== 0;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/**
 * 計測用の要素を置く (画面の外、見えない、ポインターを受けない)。body ではなく html の直下に置き、
 * アプリの UI スケール (`body { zoom }`) の影響を受けないようにする。
 */
const HIDDEN_STYLE =
  "position:absolute;left:-10000px;top:-10000px;visibility:hidden;pointer-events:none;contain:layout style";

function attach(doc: Document, element: Element): void {
  if (!element.isConnected) doc.documentElement.appendChild(element);
}

/**
 * 見えない SVG の `<text>` で幅を測る (`getComputedTextLength`)。測れない環境では null を返す。
 * Chromium では描画と同じ幅 (カーニングを含む) を返すが、WebKit はカーニングを含まない値を返すので、
 * 使うかどうかは `createCanvasTextMeasurer` が実測で決める。
 * 空白は描画 (`xml:space="preserve"`) と同じく保つ。属性は XML の名前空間に置かないと効かないので
 * `setAttributeNS` を使い、CSS の `white-space: pre` も付ける。測り終えたら本文を空にする。
 */
export function createSvgTextMeasure(
  getDocument: () => Document | null = defaultMeasureDocument,
): (text: string, font: FontSpec) => number | null {
  let element: SVGTextElement | null | undefined;
  let doc: Document | null = null;
  const ensure = (): SVGTextElement | null => {
    if (element === undefined) {
      try {
        doc = getDocument();
        if (!doc) element = null;
        else {
          const svg = doc.createElementNS(SVG_NS, "svg");
          svg.setAttribute("aria-hidden", "true");
          svg.setAttribute("data-canvas-text-measure", "");
          svg.setAttribute("style", `${HIDDEN_STYLE};width:0;height:0;overflow:hidden`);
          const text = doc.createElementNS(SVG_NS, "text") as SVGTextElement;
          text.setAttributeNS(XML_NS, "xml:space", "preserve");
          text.setAttribute("style", "white-space:pre");
          svg.appendChild(text);
          element = typeof text.getComputedTextLength === "function" ? text : null;
        }
      } catch {
        element = null;
      }
    }
    const svg = element?.parentNode;
    if (doc && svg instanceof Element) attach(doc, svg);
    return element;
  };
  return (text, font) => {
    const target = ensure();
    if (!target) return null;
    target.setAttribute("font-family", cssFontFamily(font.family));
    target.setAttribute("font-size", String(font.size));
    target.setAttribute("font-weight", String(font.weight));
    target.setAttribute("font-style", font.italic ? "italic" : "normal");
    target.textContent = text;
    const width = target.getComputedTextLength();
    target.textContent = "";
    return Number.isFinite(width) ? width : null;
  };
}

/**
 * フォントのアセントとディセントを、HTML の行の箱から求める (編集欄の `<textarea>` と同じ組版)。
 * インラインの要素の内容の箱 (アセント + ディセント) と、高さ 0 のインラインブロックで示したベースラインを測る。
 * 要素は html の直下に置き、さらに幅 100px の物差しで割って、UI スケール (`zoom`) に関係なく CSS px で返す。
 * 測れない環境では null。
 */
export function createDomFontMetrics(
  getDocument: () => Document | null = defaultMeasureDocument,
): (font: FontSpec) => FontMetrics | null {
  let parts:
    | {
        doc: Document;
        box: HTMLElement;
        text: HTMLElement;
        marker: HTMLElement;
        ruler: HTMLElement;
      }
    | null
    | undefined;
  const ensure = () => {
    if (parts === undefined) {
      try {
        const doc = getDocument();
        if (!doc) parts = null;
        else {
          const box = doc.createElement("div");
          box.setAttribute("aria-hidden", "true");
          box.setAttribute("data-canvas-text-measure", "");
          box.setAttribute("style", `${HIDDEN_STYLE};white-space:pre;line-height:normal`);
          const text = doc.createElement("span");
          text.textContent = "x";
          const marker = doc.createElement("span");
          marker.setAttribute("style", "display:inline-block;width:0;height:0");
          const ruler = doc.createElement("div");
          ruler.setAttribute("style", "width:100px;height:0");
          box.append(text, marker, ruler);
          parts = { doc, box, text, marker, ruler };
        }
      } catch {
        parts = null;
      }
    }
    if (parts) attach(parts.doc, parts.box);
    return parts;
  };
  return (font) => {
    const current = ensure();
    if (!current) return null;
    current.box.style.font = cssFont(font);
    current.box.style.lineHeight = "normal";
    const scale = current.ruler.getBoundingClientRect().width / 100;
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const content = current.text.getBoundingClientRect();
    const baseline = current.marker.getBoundingClientRect().top;
    const ascent = (baseline - content.top) / scale;
    const descent = (content.bottom - baseline) / scale;
    if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent + descent <= 0) return null;
    return { ascent, descent };
  };
}

/**
 * エンジンによって違う折り返しの規則を、編集欄と同じ CSS の要素で 1 回だけ確かめる。測れない環境では既定 (空)。
 * - `/` の後: 等幅フォントで `xx aaaa/bbbb` を 8.5 文字の幅に置き、`aaaa/` が 1 行目に残れば `/` の後で折り返す
 *   (WebKit)。折り返さなければ単語ごと次の行へ送られる (Chromium)
 * - 単位ごとの組み: かなの並びを、ふつうと `word-break: keep-all` (和文の間で折り返さない = 単位に分けない)
 *   で組んだ幅を比べ、違えば HTML は折り返せる単位ごとに組んでいる (WebKit)。かなをカーニングするフォント
 *   (ヒラギノなど) が見つからなければ、違いが出ないので決めない (行全体で判定する)
 */
/** かなの並び (ヒラギノなどはかなの組をカーニングする)。単位ごとに組むと、単位をまたぐ分だけ広くなる。 */
export const UNIT_SHAPING_PROBE = "テキストテキストテキストテキスト";
export const UNIT_SHAPING_PROBE_FAMILIES = [
  "Hiragino Sans",
  "Hiragino Kaku Gothic ProN",
  "Yu Gothic",
  "Meiryo",
  "sans-serif",
] as const;

/** HTML が折り返せる単位ごとに組むか (`createLineBreakProbe` の一部)。 */
function shapesPerUnit(doc: Document): boolean {
  const box = doc.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.setAttribute("lang", "ja");
  box.setAttribute(
    "style",
    `${HIDDEN_STYLE};white-space:pre-wrap;overflow-wrap:break-word;line-break:strict`,
  );
  const normal = doc.createElement("span");
  const kept = doc.createElement("span");
  normal.textContent = UNIT_SHAPING_PROBE;
  kept.textContent = UNIT_SHAPING_PROBE;
  kept.setAttribute("style", "word-break:keep-all");
  box.append(normal, doc.createElement("br"), kept);
  attach(doc, box);
  try {
    for (const family of UNIT_SHAPING_PROBE_FAMILIES) {
      box.style.font = `32px ${cssFontFamily(family)}`;
      const split = normal.getBoundingClientRect().width;
      const whole = kept.getBoundingClientRect().width;
      if (split > 0 && whole > 0 && Math.abs(split - whole) > 0.5) return true;
    }
    return false;
  } finally {
    box.remove();
  }
}

export function createLineBreakProbe(
  getDocument: () => Document | null = defaultMeasureDocument,
): () => LineBreakOptions {
  let result: LineBreakOptions | undefined;
  return () => {
    if (result !== undefined) return result;
    result = {};
    try {
      const doc = getDocument();
      if (!doc) return result;
      const box = doc.createElement("div");
      box.setAttribute("aria-hidden", "true");
      box.setAttribute("lang", "ja");
      box.setAttribute(
        "style",
        `${HIDDEN_STYLE};font:16px monospace;line-height:20px;width:8.5ch;white-space:pre-wrap;` +
          "overflow-wrap:break-word;word-break:normal;line-break:strict",
      );
      const text = doc.createTextNode("xx aaaa/bbbb");
      box.appendChild(text);
      attach(doc, box);
      const range = doc.createRange();
      const topOf = (index: number) => {
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        return range.getBoundingClientRect().top;
      };
      const first = topOf(0);
      const solidus = topOf(7);
      // 行が分かれたかは最後の文字で見る (WebKit は、折り返した直後の文字の範囲を前の行の末尾として返す)
      const last = topOf(11);
      box.remove();
      // 行が分かれていない (レイアウトのない環境) なら決めない
      if (last > first)
        result = { breakAfterSolidus: solidus === first, shapePerUnit: shapesPerUnit(doc) };
    } catch {
      // 確かめられなければ既定の規則
    }
    return result;
  };
}

/** 覚えておく文字列の長さの上限 (UTF-16 の単位)。長い 1 行や、折り返す前の長い単語は覚えない。 */
export const MAX_CACHED_TEXT_LENGTH = 256;
/** 覚えておく文字列の合計の長さの上限。超えたら全部捨てる。 */
export const MAX_CACHED_TOTAL_LENGTH = 1_000_000;

/** フォントごとに、文字列から幅を引く表。キーの文字列の合計の長さで上限を持つ。 */
class WidthCache {
  private readonly byFont = new Map<string, Map<string, number>>();
  private total = 0;

  get(font: string, text: string): number | undefined {
    return this.byFont.get(font)?.get(text);
  }

  set(font: string, text: string, width: number): void {
    if (text.length > MAX_CACHED_TEXT_LENGTH) return;
    if (this.total + text.length + font.length > MAX_CACHED_TOTAL_LENGTH) this.clear();
    let table = this.byFont.get(font);
    if (!table) {
      table = new Map();
      this.byFont.set(font, table);
      this.total += font.length;
    }
    if (!table.has(text)) this.total += text.length;
    table.set(text, width);
  }

  clear(): void {
    this.byFont.clear();
    this.total = 0;
  }

  /** 覚えている文字列の合計の長さ (テスト用) */
  get size(): number {
    return this.total;
  }
}

/**
 * SVG のレイアウトの幅 (`getComputedTextLength`) がカーニングを含むかを確かめる文字列とフォント。
 * カーニングするフォントが 1 つ見つかればよい (macOS と Windows のどちらかに必ずある)。
 */
export const KERNING_PROBE = "AVAVAVAV WAWAWA ToToTo YoYoYo";
export const KERNING_PROBE_FAMILIES = [
  "Times New Roman",
  "Helvetica",
  "Arial",
  "Georgia",
  "serif",
  "sans-serif",
] as const;

/**
 * canvas と描画の幅が合うかを確かめる文字列。文字の種類ごとに複数持ち、どれか 1 つでも合わなければ、
 * そのフォントのその種類の文字を含む文字列は SVG で測る (代わりのフォントの選び方が canvas と描画で違う、など)。
 */
export const AGREEMENT_PROBES: Readonly<Record<typeof LATIN | typeof CJK, readonly string[]>> = {
  [LATIN]: [
    "Ta To AV WA Yo ff fi fl",
    "Hello, world! 0123456789 (a)[b]{c}",
    "“quotes” ‘s’ — – … ¥€£ äöüé",
  ],
  [CJK]: ["テキスト、「かな」。漢字", "(「かぎ」)【括弧】ー〜…", "ＡＢＣ１２３ｶﾀｶﾅ 한국어"],
};

/**
 * canvas と SVG の幅が合うとみなす差 (px)。Chromium の SVG の幅は 1/64 px に丸まるので、その分を見込む。
 * 代わりのフォントが違うときの差は 1 文字で 0.5 px を超える。
 */
export const AGREEMENT_TOLERANCE = 0.05;
const FONT_TABLE_LIMIT = 1_000;

export interface CanvasMeasurerOptions {
  getContext?: () => CanvasRenderingContext2D | null;
  measureWithSvg?: (text: string, font: FontSpec) => number | null;
  measureFontMetrics?: (font: FontSpec) => FontMetrics | null;
  detectLineBreaks?: () => LineBreakOptions;
}

/** 計測の経路を選ぶ規則 (テストと検証のために公開する)。 */
export interface MeasurePathInfo {
  /** SVG のレイアウトの幅が描画と同じ (カーニングを含む) か。null はまだ確かめていない */
  svgMatchesDrawing: boolean | null;
}

/**
 * ブラウザでの計測 (§4.7)。SVG の `<text>` が実際に描かれる幅と同じ値を返す。
 *
 * どのエンジンでも、まず canvas の `measureText` で測る (速い)。WebKit (Safari、WKWebView) の canvas は
 * 描画と同じ幅を返す (カーニング、絵文字、`system-ui`、欧文フォントの中の和文を含めて実測で一致)。
 * Chromium の canvas は絵文字の幅と、代わりのフォントの選び方が描画と違うことがあるので、次の文字列だけは
 * SVG のレイアウトの幅 (`getComputedTextLength`。Chromium では描画と同じ) で測る:
 * - 絵文字とそのほかの文字 (`EMOJI` / `OTHER`) を含む文字列
 * - そのフォントで、canvas と SVG の幅が `AGREEMENT_PROBES` のどれかで合わない種類 (`LATIN` / `CJK`) の
 *   文字を含む文字列 (フォントと種類の組ごとに 1 回だけ比べる)
 *
 * どちらのエンジンかは名前で決めず、SVG のレイアウトの幅がカーニングを含むかを最初に 1 回だけ確かめて決める
 * (`KERNING_PROBE`)。含まなければ (WebKit) SVG では測らない。
 *
 * 結果はフォントと文字列の組で覚える。長い文字列は覚えず、覚える量は文字列の合計の長さで抑える。
 * canvas が使えない環境 (jsdom) では、フォントサイズ × 0.6 を 1 文字の幅とみなす。
 */
export function createCanvasTextMeasurer(
  options: CanvasMeasurerOptions = {},
): MetricsTextMeasurer & {
  /** 覚えている文字列の合計の長さ (テスト用) */
  readonly cachedLength: number;
  /** 経路の選び方の状態 (テストと検証用) */
  readonly pathInfo: MeasurePathInfo;
} {
  const getContext = options.getContext ?? createMeasureContext();
  const measureWithSvg = options.measureWithSvg ?? createSvgTextMeasure();
  const measureFontMetrics = options.measureFontMetrics ?? createDomFontMetrics();
  const detectLineBreaks = options.detectLineBreaks ?? createLineBreakProbe();
  const widths = new WidthCache();
  const metrics = new Map<string, FontMetrics | null>();
  /** フォントごとに、確かめた文字の種類と、canvas と描画が合わない種類 (ビットの和) */
  const agreement = new Map<string, { checked: number; disagreeing: number }>();
  let svgMatchesDrawing: boolean | null = null;
  // 行分割は 1 つのノードで同じ FontSpec を何度も渡すので、font の文字列を組み立て直さない
  const fontStrings = new WeakMap<FontSpec, string>();
  const fontStringOf = (font: FontSpec) => {
    let value = fontStrings.get(font);
    if (value === undefined) {
      value = cssFont(font);
      fontStrings.set(font, value);
    }
    return value;
  };
  // `ctx.font` は読み返すと書き方が変わる (正規化される) ので、最後に設定した文字列を覚えて比べる
  let currentFont = "";
  const applyFont = (ctx: CanvasRenderingContext2D, fontString: string) => {
    if (currentFont === fontString) return;
    ctx.font = fontString;
    currentFont = fontString;
  };
  const canvasWidth = (text: string, fontString: string): number | null => {
    const ctx = getContext();
    if (!ctx) return null;
    applyFont(ctx, fontString);
    return ctx.measureText(text).width;
  };

  /** SVG のレイアウトの幅が描画と同じか (カーニングを含むか)。最初に 1 回だけ確かめる。 */
  const svgIsDrawing = (): boolean => {
    if (svgMatchesDrawing !== null) return svgMatchesDrawing;
    svgMatchesDrawing = false;
    for (const family of KERNING_PROBE_FAMILIES) {
      const font: FontSpec = { family, size: 32, weight: 400, italic: false, letterSpacing: 0 };
      const fontString = cssFont(font);
      const kerned = canvasWidth(KERNING_PROBE, fontString);
      if (kerned === null) break;
      let separate = 0;
      for (const char of KERNING_PROBE) separate += canvasWidth(char, fontString) ?? 0;
      if (separate - kerned < 1) continue; // このフォントはカーニングしない
      const viaSvg = measureWithSvg(KERNING_PROBE, font);
      svgMatchesDrawing = viaSvg !== null && Math.abs(viaSvg - kerned) <= AGREEMENT_TOLERANCE;
      break;
    }
    return svgMatchesDrawing;
  };

  /** そのフォントで、canvas と描画が合わない文字の種類。種類ごとに最初に使うときに比べる。 */
  const disagreeingClasses = (font: FontSpec, fontString: string, classes: number): number => {
    let entry = agreement.get(fontString);
    if (!entry) {
      if (agreement.size >= FONT_TABLE_LIMIT) agreement.clear();
      entry = { checked: 0, disagreeing: 0 };
      agreement.set(fontString, entry);
    }
    for (const cls of [LATIN, CJK] as const) {
      if ((classes & cls) === 0 || (entry.checked & cls) !== 0) continue;
      entry.checked |= cls;
      for (const probe of AGREEMENT_PROBES[cls]) {
        const viaSvg = measureWithSvg(probe, font);
        const viaCanvas = canvasWidth(probe, fontString);
        if (viaSvg === null || viaCanvas === null) break;
        if (Math.abs(viaSvg - viaCanvas) > AGREEMENT_TOLERANCE) {
          entry.disagreeing |= cls;
          break;
        }
      }
    }
    return entry.disagreeing;
  };

  /** 描画と同じ幅を得るために SVG で測るか。 */
  const needsSvg = (text: string, font: FontSpec, fontString: string): boolean => {
    // WebKit は canvas が描画と同じ幅を返し、SVG のレイアウトの幅はカーニングを含まない
    if (!svgIsDrawing()) return false;
    const classes = scriptClasses(text);
    if ((classes & (EMOJI | OTHER)) !== 0) return true;
    return (disagreeingClasses(font, fontString, classes) & classes) !== 0;
  };

  return {
    measure(text: string, font: FontSpec): number {
      const spacing = letterSpacingWidth(text, font.letterSpacing);
      if (text === "") return 0;
      const fontString = fontStringOf(font);
      const cached = widths.get(fontString, text);
      if (cached !== undefined) return cached + spacing;
      let width = needsSvg(text, font, fontString) ? measureWithSvg(text, font) : null;
      width ??= canvasWidth(text, fontString);
      width ??= graphemeCount(text) * font.size * 0.6;
      widths.set(fontString, text, width);
      return width + spacing;
    },

    fontMetrics(font: FontSpec): FontMetrics | null {
      const fontString = fontStringOf(font);
      if (metrics.has(fontString)) return metrics.get(fontString) ?? null;
      // 編集欄と同じ HTML の行の箱から求める。測れなければ canvas の fontBoundingBox
      let result = measureFontMetrics(font);
      const ctx = result ? null : getContext();
      if (ctx) {
        applyFont(ctx, fontString);
        const measured = ctx.measureText("x");
        const ascent = measured.fontBoundingBoxAscent;
        const descent = measured.fontBoundingBoxDescent;
        // 古い WebView は値を持たない (undefined)。そのときは既定の比率に任せる
        if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0)
          result = { ascent, descent };
      }
      if (metrics.size >= FONT_TABLE_LIMIT) metrics.clear();
      metrics.set(fontString, result);
      return result;
    },

    lineBreakOptions(): LineBreakOptions {
      return detectLineBreaks();
    },

    get cachedLength() {
      return widths.size;
    },

    get pathInfo() {
      return { svgMatchesDrawing };
    },
  };
}

/** キャンバスが使う計測。 */
export const canvasTextMeasurer: MetricsTextMeasurer = createCanvasTextMeasurer();
