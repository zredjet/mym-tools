import { panBy } from "../canvas/viewport";
import type { Point } from "../model/types";
import type { Tool } from "./types";

/**
 * ドラッグ中の直前の位置 (画面座標)。移動のたびに差だけを今の表示位置へ足すので、
 * ドラッグの途中でホイールやピンチが表示位置を変えても打ち消さない (§4.4)。
 */
let last: Point | null = null;

/** 手のひらでドラッグ中か。 */
export function isHandDragging(): boolean {
  return last !== null;
}

/**
 * 手のひら (表示位置の移動)。文書は変えないので履歴にも revision にも数えない。
 * Space を押している間と中ボタンのドラッグは、キャンバスが現在のツールの代わりにこれへ渡す。
 */
export const handTool: Tool = {
  id: "hand",
  cursor: "grab",
  onPointerDown(event) {
    last = event.screen;
  },
  onPointerMove(event, { store }) {
    if (!last) return;
    const state = store.getState();
    state.setViewport(panBy(state.viewport, event.screen.x - last.x, event.screen.y - last.y));
    last = event.screen;
  },
  onPointerUp() {
    last = null;
  },
  onCancel() {
    // 動かした表示位置は戻さない (Esc で戻ると、どこまで戻るか分かりにくい)
    last = null;
  },
};
