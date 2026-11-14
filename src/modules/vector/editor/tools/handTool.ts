import type { Tool } from "./types";

/** 手のひら (表示位置の移動)。中身は「描画とビューポート」のセッションで実装する。 */
export const handTool: Tool = { id: "hand", cursor: "grab" };
