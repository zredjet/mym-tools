/**
 * 描画層の契約 (`docs/canvas-editor-design.md` §4.3)。
 *
 * ノードはまず `SvgEl` (SVG 要素の素朴な木) に変換する。画面はそれを React 要素にし、
 * SVG 書き出しは同じ木を文字列にする。描画の規則を 1 か所に置くための中間表現で、
 * テストはこの木を検査する。
 */
import type { CanvasDocument, NodeId, TextNode } from "../model/types";

export interface SvgEl {
  tag: string;
  /** SVG の属性名そのまま (`stroke-width` など)。値が数値なら文字列化して出す */
  attrs: Record<string, string | number>;
  children: (SvgEl | string)[];
}

export interface FontSpec {
  family: string;
  size: number;
  weight: number;
  italic: boolean;
  letterSpacing: number;
}

/** 文字列の幅 (px) を測る。ブラウザでは canvas の `measureText`、テストでは固定幅の代用品を渡す。 */
export interface TextMeasurer {
  measure(text: string, font: FontSpec): number;
}

export interface TextLine {
  text: string;
  /** テキストノードの左上を原点とした行頭の x */
  x: number;
  /** テキストノードの左上を原点としたベースラインの y */
  y: number;
  width: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** 行分割した結果の大きさ。`sizing` に応じてノードの width / height へ反映する */
  width: number;
  height: number;
}

export type LayoutText = (node: TextNode, measurer: TextMeasurer) => TextLayout;

export interface RenderOptions {
  measurer: TextMeasurer;
  /** `<defs>` に置く id の接頭辞。1 つの SVG に複数の文書を出すときの衝突を避ける */
  idPrefix: string;
}

/**
 * ノード 1 個 (子を含む) を `SvgEl` にする。`visible` が false なら null。
 * 座標は親の座標系で出すので、呼び出し側が親の位置へ `transform` する必要はない
 * (frame は自分の子を自分の位置へ移して返す)。
 */
export type BuildNodeSvg = (
  doc: CanvasDocument,
  nodeId: NodeId,
  options: RenderOptions,
) => SvgEl | null;
