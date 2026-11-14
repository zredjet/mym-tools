import { panBy } from "../canvas/viewport";
import type { Point } from "../model/types";
import type { Viewport } from "../state/types";
import type { Tool } from "./types";

/** ドラッグの開始時点。画面座標で差を取る (ページ座標は表示位置と一緒に動くため)。 */
let drag: { start: Point; viewport: Viewport } | null = null;

/** 手のひらでドラッグ中か (キャンバスがカーソルを grabbing にする)。 */
export function isHandDragging(): boolean {
  return drag !== null;
}

/**
 * 手のひら (表示位置の移動)。文書は変えないので履歴にも revision にも数えない。
 * Space を押している間と中ボタンのドラッグは、キャンバスが現在のツールの代わりにこれへ渡す。
 */
export const handTool: Tool = {
  id: "hand",
  cursor: "grab",
  onPointerDown(event, { store }) {
    drag = { start: event.screen, viewport: store.getState().viewport };
  },
  onPointerMove(event, { store }) {
    if (!drag) return;
    store
      .getState()
      .setViewport(
        panBy(drag.viewport, event.screen.x - drag.start.x, event.screen.y - drag.start.y),
      );
  },
  onPointerUp() {
    drag = null;
  },
  onCancel() {
    // 動かした表示位置は戻さない (Esc で戻ると、どこまで戻るか分かりにくい)
    drag = null;
  },
};
