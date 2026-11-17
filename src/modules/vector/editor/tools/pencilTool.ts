import type { Tool } from "./types";

/**
 * 鉛筆 (Shift+P、`docs/canvas-editor-design.md` §8.8)。
 *
 * v3 の基盤 (C1) が ID と登録だけを置いた空のツール。中身 (なぞった点を 3 次ベジェに当てはめて開いた
 * パスを作る) は「多角形・星・鉛筆」のセッション (H) がこのファイルに書く。
 */
export const pencilTool: Tool = {
  id: "pencil",
  cursor: "crosshair",
};
