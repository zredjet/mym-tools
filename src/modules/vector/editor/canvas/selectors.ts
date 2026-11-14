/**
 * キャンバスの層が store から引く値 (selector)。
 *
 * どれも `create*` で購読者ごとに作り、直前の引数と結果を 1 件だけ覚える。文書・ページ・表示位置・大きさが
 * 同じなら同じ配列を返すので、`useSyncExternalStore` に毎回新しい値を渡さない。別の大きさで呼ぶ購読者が
 * 増えても、互いの覚えた結果を上書きしない。
 */
import { rectsIntersect } from "../model/geometry";
import type { CanvasDocument, NodeId, PageId } from "../model/types";
import { canvasTextMeasurer } from "../render/measureText";
import type { TextMeasurer } from "../render/types";
import type { EditorStore, Viewport } from "../state/types";
import { visibleTopLevelIds } from "./culling";
import { frameLabel, labeledFrames, type FrameLabel } from "./frameLabels";
import { visiblePageRect, type Size } from "./viewport";

interface ViewKey {
  doc: CanvasDocument;
  pageId: PageId;
  viewport: Viewport;
  width: number;
  height: number;
}

function sameKey(a: ViewKey, b: ViewKey): boolean {
  return (
    a.doc === b.doc &&
    a.pageId === b.pageId &&
    a.viewport === b.viewport &&
    a.width === b.width &&
    a.height === b.height
  );
}

/** 文書・ページ・表示位置・大きさから値を求める関数を、直前の 1 件を覚える selector にする。 */
function memoizeByView<T>(compute: (key: ViewKey) => T): (state: EditorStore, size: Size) => T {
  let last: { key: ViewKey; value: T } | null = null;
  return (state, size) => {
    const key: ViewKey = {
      doc: state.doc,
      pageId: state.pageId,
      viewport: state.viewport,
      width: size.width,
      height: size.height,
    };
    if (last && sameKey(last.key, key)) return last.value;
    const value = compute(key);
    last = { key, value };
    return value;
  };
}

/** 画面外のページ直下のノードを除いた ID を返す selector を作る。 */
export function createVisibleTopLevelIdsSelector(
  measurer: TextMeasurer = canvasTextMeasurer,
): (state: EditorStore, size: Size) => NodeId[] {
  return memoizeByView(({ doc, pageId, viewport, width, height }) =>
    visibleTopLevelIds(doc, pageId, visiblePageRect(viewport, { width, height }), measurer),
  );
}

/** 画面に入る frame のラベルを返す selector を作る。 */
export function createFrameLabelsSelector(
  measurer: TextMeasurer = canvasTextMeasurer,
): (state: EditorStore, size: Size) => FrameLabel[] {
  return memoizeByView(({ doc, pageId, viewport, width, height }) => {
    const view = visiblePageRect(viewport, { width, height });
    const labels: FrameLabel[] = [];
    for (const frame of labeledFrames(doc, pageId)) {
      const label = frameLabel(doc, frame.id, viewport.zoom, measurer);
      if (label && rectsIntersect(label.rect, view)) labels.push(label);
    }
    return labels;
  });
}
