/**
 * ページ直下の frame の名前のラベル (純関数)。frame の左上の外側に、倍率に関係なく同じ大きさで出す。
 * 「選択と変形」のセッションは `frameLabelRect` でラベルの矩形を得て、クリックで frame を選ぶ (§4.5)。
 */
import { DEFAULT_NODE_NAMES } from "../model/create";
import type { Rect } from "../model/geometry";
import { getNode, getPage, getParent } from "../model/tree";
import type { CanvasDocument, FrameNode, NodeId, PageId } from "../model/types";
import type { FontSpec, TextMeasurer } from "../render/types";

/** ラベルの文字 (画面 px)。描画も計測もこのフォントを使う。 */
export const FRAME_LABEL_FONT: FontSpec = {
  family: "system-ui",
  size: 11,
  weight: 500,
  italic: false,
  letterSpacing: 0,
};
/** ラベルの高さ (画面 px) */
export const FRAME_LABEL_HEIGHT = 16;
/** ラベルの下端と frame の上端の間 (画面 px) */
export const FRAME_LABEL_GAP = 2;
/** frame が小さく写っていても確保するラベルの幅 (画面 px) */
const MIN_LABEL_WIDTH = 16;
const ELLIPSIS = "…";

export function frameLabelText(frame: FrameNode): string {
  return frame.name.trim() === "" ? DEFAULT_NODE_NAMES.frame : frame.name;
}

/** ページ直下の表示中の frame。ラベルを出す対象。 */
export function labeledFrames(doc: CanvasDocument, pageId: PageId): FrameNode[] {
  const page = getPage(doc, pageId);
  if (!page) return [];
  const result: FrameNode[] = [];
  for (const id of page.children) {
    const node = getNode(doc, id);
    if (node?.type === "frame" && node.visible) result.push(node);
  }
  return result;
}

/** 幅に収まるよう末尾を「…」で切る。収まらなければ空文字。 */
export function truncateLabel(text: string, maxWidth: number, measurer: TextMeasurer): string {
  if (measurer.measure(text, FRAME_LABEL_FONT) <= maxWidth) return text;
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = chars.slice(0, mid).join("") + ELLIPSIS;
    if (measurer.measure(candidate, FRAME_LABEL_FONT) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low === 0 ? "" : chars.slice(0, low).join("") + ELLIPSIS;
}

export interface FrameLabel {
  id: NodeId;
  /** 表示する文字 (幅に収まらなければ「…」で切ったもの) */
  text: string;
  /** ページ座標の矩形 */
  rect: Rect;
}

/**
 * ラベルの位置と文字。幅は名前の幅と frame の画面上の幅の小さい方 (frame が小さく写るときは 16 画面 px)。
 * ページ直下の表示中の frame でなければ null。
 */
export function frameLabel(
  doc: CanvasDocument,
  frameId: NodeId,
  zoom: number,
  measurer: TextMeasurer,
): FrameLabel | null {
  const frame = getNode(doc, frameId);
  if (!frame || frame.type !== "frame" || !frame.visible) return null;
  if (getParent(doc, frameId)?.kind !== "page") return null;
  const full = frameLabelText(frame);
  const maxWidth = Math.max(MIN_LABEL_WIDTH, frame.width * zoom);
  const text = truncateLabel(full, maxWidth, measurer);
  const width = Math.min(measurer.measure(text, FRAME_LABEL_FONT), maxWidth);
  return {
    id: frame.id,
    text,
    rect: {
      x: frame.x,
      y: frame.y - (FRAME_LABEL_HEIGHT + FRAME_LABEL_GAP) / zoom,
      width: Math.max(width, MIN_LABEL_WIDTH) / zoom,
      height: FRAME_LABEL_HEIGHT / zoom,
    },
  };
}

/** ラベルの矩形 (ページ座標)。ラベルのクリックで frame を選ぶヒットテストに使う。 */
export function frameLabelRect(
  doc: CanvasDocument,
  frameId: NodeId,
  zoom: number,
  measurer: TextMeasurer,
): Rect | null {
  return frameLabel(doc, frameId, zoom, measurer)?.rect ?? null;
}
