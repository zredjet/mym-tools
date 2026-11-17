import type { Tool } from "./types";

/**
 * 多角形 (`docs/canvas-editor-design.md` §8.8)。
 *
 * v3 の基盤 (C1) が ID と登録だけを置いた空のツール。中身 (ドラッグした矩形に収まる正多角形のパスを作る)
 * は「多角形・星・鉛筆」のセッション (H) がこのファイルに書く。
 */
export const polygonTool: Tool = {
  id: "polygon",
  cursor: "crosshair",
};
