import limits from "./limits.json";

/**
 * payload v2 の上限と書式 (`docs/canvas-editor-design.md` §3.7)。
 * 値は `limits.json` が正典で、Rust 側 (`src-tauri/src/modules/vector/`) も同じファイルを読む。
 */
export const CANVAS_LIMITS = limits;

export const NODE_ID_PATTERN = new RegExp(limits.idPattern);
export const HEX_COLOR_PATTERN = new RegExp(limits.colorPattern);
