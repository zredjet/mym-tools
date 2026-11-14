/**
 * テキストツール (§4.7)。クリックで `auto-width`、ドラッグで幅を決めた `auto-height` のテキストを作り、
 * すぐ本文の編集を始める。作ったら選択ツールへ戻る。
 *
 * 作成は本文の編集と同じジェスチャーに含める (`startTextCreation`) ので、空のまま編集を終えたら
 * 履歴にも `revision` にも何も残らない。
 */
import { getTextToolDrag, newTextNode, setTextToolDrag, textParentAt } from "../text/creation";
import { startTextCreation } from "../text/editSession";
import { fontDetector } from "../text/fonts";
import { TextToolOverlay } from "../text/TextToolOverlay";
import type { Tool } from "./types";

/** クリックとドラッグを分ける移動量 (画面 px)。 */
export const TEXT_DRAG_THRESHOLD = 3;

export const textTool: Tool = {
  id: "text",
  cursor: "text",
  onPointerDown(event) {
    if (event.button !== 0) return;
    setTextToolDrag({
      start: event.page,
      current: event.page,
      startScreen: event.screen,
      dragged: false,
    });
  },
  onPointerMove(event) {
    const drag = getTextToolDrag();
    if (!drag) return;
    const dragged =
      drag.dragged ||
      Math.hypot(event.screen.x - drag.startScreen.x, event.screen.y - drag.startScreen.y) >=
        TEXT_DRAG_THRESHOLD;
    setTextToolDrag({ ...drag, current: event.page, dragged });
  },
  onPointerUp(event, { store, measurer }) {
    const drag = getTextToolDrag();
    if (!drag) return;
    // 自分の状態を片付けてから作る (`setTool` はその場で自分の `onCancel` を呼ぶ)
    setTextToolDrag(null);
    const { doc, pageId, scopeId } = store.getState();
    const parent = textParentAt(doc, pageId, scopeId, drag.start);
    const end = drag.dragged ? event.page : null;
    const node = newTextNode(doc, parent, drag.start, end, fontDetector.defaultFamily());
    startTextCreation(store, node, parent, measurer);
    store.getState().setTool("select");
  },
  onCancel() {
    setTextToolDrag(null);
  },
  Overlay: TextToolOverlay,
};
