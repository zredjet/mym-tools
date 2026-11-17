import type { Tool } from "./types";

/**
 * パスの点の編集 (`docs/canvas-editor-design.md` §8.7.1〜§8.7.3)。ツールバーには出さず、
 * `startPathEdit` が切り替える。編集しているパスは store の `editingPathId`。
 *
 * v3 の基盤 (C1) が置いた仮の中身で、Enter と Esc で点の編集を終えることだけをする (編集から出られなく
 * ならないように)。点の押下・ドラッグ・範囲選択・ダブルクリック・キーと、点とハンドルの重ね描きは
 * 「ペンと点の編集」のセッション (F) がこのファイルに書く。
 */
export const pathEditTool: Tool = {
  id: "pathEdit",
  cursor: "default",
  onKeyDown(event, { store }) {
    if (event.key !== "Enter" && event.key !== "Escape") return false;
    if (event.shift || event.alt || event.mod) return false;
    store.getState().endPathEdit();
    return true;
  },
};
