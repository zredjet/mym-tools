/**
 * キャンバスの層が store から引く値 (selector)。表示位置と文書が同じなら前の結果を返し、
 * `useSyncExternalStore` に同じ値を返すようにする。エディタは同時に 1 つなので 1 件だけ覚える。
 */
import type { Rect } from "../model/geometry";
import { rectsIntersect } from "../model/geometry";
import type { CanvasDocument, NodeId, PageId } from "../model/types";
import { canvasTextMeasurer } from "../render/measureText";
import type { EditorStore, Viewport } from "../state/types";
import { visibleTopLevelIds } from "./culling";
import { frameLabel, labeledFrames, type FrameLabel } from "./frameLabels";
import { visiblePageRect, type Size } from "./viewport";

interface CullKey {
  doc: CanvasDocument;
  pageId: PageId;
  viewport: Viewport;
  width: number;
  height: number;
}

let lastCull: { key: CullKey; ids: NodeId[] } | null = null;

/** 画面外のページ直下のノードを除いた ID。表示位置と文書が同じなら前の結果を返す。 */
export function selectVisibleTopLevelIds(state: EditorStore, size: Size): NodeId[] {
  const last = lastCull;
  if (
    last &&
    last.key.doc === state.doc &&
    last.key.pageId === state.pageId &&
    last.key.viewport === state.viewport &&
    last.key.width === size.width &&
    last.key.height === size.height
  ) {
    return last.ids;
  }
  const view: Rect = visiblePageRect(state.viewport, size);
  const ids = visibleTopLevelIds(state.doc, state.pageId, view, canvasTextMeasurer);
  lastCull = {
    key: { doc: state.doc, pageId: state.pageId, viewport: state.viewport, ...size },
    ids,
  };
  return ids;
}

let lastLabels: {
  doc: EditorStore["doc"];
  pageId: string;
  viewport: Viewport;
  width: number;
  height: number;
  labels: FrameLabel[];
} | null = null;

/** 画面に入るラベル。文書・ページ・表示位置・大きさが同じなら前の結果を返す。 */
export function selectFrameLabels(state: EditorStore, size: Size): FrameLabel[] {
  const last = lastLabels;
  if (
    last &&
    last.doc === state.doc &&
    last.pageId === state.pageId &&
    last.viewport === state.viewport &&
    last.width === size.width &&
    last.height === size.height
  ) {
    return last.labels;
  }
  const view = visiblePageRect(state.viewport, size);
  const labels: FrameLabel[] = [];
  for (const frame of labeledFrames(state.doc, state.pageId)) {
    const label = frameLabel(state.doc, frame.id, state.viewport.zoom, canvasTextMeasurer);
    if (label && rectsIntersect(label.rect, view)) labels.push(label);
  }
  lastLabels = { doc: state.doc, pageId: state.pageId, viewport: state.viewport, ...size, labels };
  return labels;
}
