/**
 * SVG の `text` を、位置を指定したまとまり (チャンク) ごとの 1 行に分ける (§8.12)。
 *
 * - `text` 自身と、`x` か `y` を持つ `tspan` がチャンクを始める。位置を持たない `tspan` と `a` は今のチャンクに続ける
 * - 位置は各属性の最初の値 (`x="10 20 30"` の文字ごとの位置は表せない)。`x` だけ・`y` だけのときは、もう片方を
 *   前のチャンクの続きから求める (前のチャンクの幅は計測で近似する)
 * - 空白: `xml:space="preserve"` なら改行とタブを空白にする。そうでなければ改行とタブを空白にして続く空白を
 *   1 個にまとめ、チャンクの前後の空白を落とす (ブラウザの SVG の組み方の近似)
 * - `textPath` の中身は落とす。`display: none` の要素は飛ばす
 *
 * チャンクの書式は、チャンクを始めた要素の書式。途中で書式が変わったら `mixedStyle`。
 * `dx` `dy` `rotate` `textLength` と文字ごとの位置は読まない (呼び出し側が、テキストの位置を近似として一覧に出す)。
 */
import type { DroppedCollector } from "./dropped";
import { computeStyle, nonInheritedValue, SVG_NS, type ComputedStyle } from "./style";
import { parseLength, type LengthContext } from "./values";

export interface TextChunk {
  /** 行の位置 (利用者の座標)。`text-anchor` の基準点とベースライン */
  x: number;
  y: number;
  style: ComputedStyle;
  /** 空白を処理した本文 */
  text: string;
  /** 途中で書式 (フォント・色など) が変わる */
  mixedStyle: boolean;
}

interface Piece {
  text: string;
  style: ComputedStyle;
  preserve: boolean;
}

interface OpenChunk {
  x: number;
  y: number;
  style: ComputedStyle;
  pieces: Piece[];
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";

function xmlSpacePreserve(element: Element, inherited: boolean): boolean {
  const own = element.getAttributeNS(XML_NS, "space") ?? element.getAttribute("xml:space");
  if (own === "preserve") return true;
  if (own === "default") return false;
  return inherited;
}

function firstLength(
  element: Element,
  name: string,
  context: LengthContext,
  axis: "x" | "y",
): number | null {
  const raw = element.getAttribute(name);
  if (raw === null) return null;
  const first = raw.trim().split(/[\s,]+/)[0];
  if (first === undefined || first === "") return null;
  return parseLength(first, context, axis);
}

function hiddenStyle(style: ComputedStyle): boolean {
  const v = style.values["visibility"]?.toLowerCase();
  return v === "hidden" || v === "collapse";
}

function normalize(pieces: readonly Piece[]): string {
  let out = "";
  for (const piece of pieces) {
    const spaced = piece.text.replace(/[\n\r\t]/g, " ");
    out += piece.preserve ? spaced : spaced.replace(/ {2,}/g, " ");
  }
  const allPreserve = pieces.every((piece) => piece.preserve);
  if (allPreserve) return out;
  // まとめ直す (書式の境目をまたいだ空白)。前後の空白を落とす
  return out.replace(/ {2,}/g, " ").trim();
}

export interface TextReadOptions {
  context: LengthContext;
  dropped: DroppedCollector;
  /** チャンクの幅 (利用者の座標)。x を省いた次のチャンクの位置に使う */
  measureWidth: (text: string, style: ComputedStyle) => number;
}

/**
 * `text` 要素をチャンクに分ける。`style` は `text` 要素の書式 (計算済み)。
 * 見えないチャンク (`visibility: hidden`) と空のチャンクは返さない。
 */
export function readTextChunks(
  text: Element,
  style: ComputedStyle,
  options: TextReadOptions,
): TextChunk[] {
  const { context, dropped } = options;
  const chunks: TextChunk[] = [];
  let currentX = firstLength(text, "x", context, "x") ?? 0;
  let currentY = firstLength(text, "y", context, "y") ?? 0;
  let open: OpenChunk = { x: currentX, y: currentY, style, pieces: [] };

  const anchorFactor = (s: ComputedStyle) => {
    const anchor = s.values["text-anchor"];
    return anchor === "middle" ? 0.5 : anchor === "end" ? 1 : 0;
  };

  const close = () => {
    const visible = open.pieces.filter((piece) => !hiddenStyle(piece.style));
    const body = normalize(visible);
    if (body !== "") {
      chunks.push({
        x: open.x,
        y: open.y,
        style: open.style,
        text: body,
        mixedStyle: visible.some((piece) => piece.style !== open.style),
      });
      const width = options.measureWidth(body, open.style);
      if (Number.isFinite(width)) currentX = open.x + width * (1 - anchorFactor(open.style));
    }
    currentY = open.y;
  };

  const walk = (element: Element, elementStyle: ComputedStyle, preserve: boolean) => {
    for (const child of element.childNodes) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        const value = child.nodeValue ?? "";
        if (value !== "") open.pieces.push({ text: value, style: elementStyle, preserve });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      if (el.namespaceURI !== SVG_NS) continue;
      if (nonInheritedValue(el, "display")?.toLowerCase() === "none") continue;
      if (el.localName === "textPath") {
        dropped.add("textPath");
        continue;
      }
      if (el.localName !== "tspan" && el.localName !== "a") continue;
      const childStyle = computeStyle(el, elementStyle, {
        ...context,
        fontSize: elementStyle.fontSize,
      });
      const childPreserve = xmlSpacePreserve(el, preserve);
      if (el.localName === "tspan") {
        const x = firstLength(el, "x", context, "x");
        const y = firstLength(el, "y", context, "y");
        if (x !== null || y !== null) {
          close();
          open = { x: x ?? currentX, y: y ?? currentY, style: childStyle, pieces: [] };
        }
      }
      walk(el, childStyle, childPreserve);
    }
  };
  let inherited = false;
  for (let e = text.parentElement; e; e = e.parentElement) {
    const own = e.getAttributeNS(XML_NS, "space") ?? e.getAttribute("xml:space");
    if (own === "preserve" || own === "default") {
      inherited = own === "preserve";
      break;
    }
  }
  walk(text, style, xmlSpacePreserve(text, inherited));
  close();
  return chunks;
}
