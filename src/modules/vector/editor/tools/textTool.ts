import type { Tool } from "./types";

/** テキストの作成。中身は「テキスト」のセッションで実装する。 */
export const textTool: Tool = { id: "text", cursor: "text" };
