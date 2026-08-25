/**
 * M-Link 固有 Tauri コマンドのラッパー (`module-contract.md` §12.2)。
 */
import { invoke } from "@tauri-apps/api/core";

/** `linkmemo_normalize_target` の戻り値 (`src-tauri/src/modules/linkmemo/normalize.rs`) */
export interface NormalizedTarget {
  type: "url" | "path";
  target: string;
}

/**
 * 入力文字列を `(type, target)` に正規化する (pure function、`module-contract.md` §12.2)。
 *
 * 主な振る舞い:
 * - `http(s)://` → `type=url`、入力そのまま
 * - `file://...` → `type=path`、OS 別 path に正規化 (POSIX / Windows / UNC)
 * - それ以外 → `type=path`、入力そのまま
 */
export function linkmemoNormalizeTarget(input: string): Promise<NormalizedTarget> {
  return invoke<NormalizedTarget>("linkmemo_normalize_target", { input });
}

/**
 * `type` (`url` / `path`) に応じて OS の既定アプリで `target` を開く
 * (URL → 既定ブラウザ / path → 既定ファイラー)。`memo` は IPC 不要のため呼ばない。
 */
export function linkmemoOpen(input: { itemType: "url" | "path"; target: string }): Promise<void> {
  return invoke<void>("linkmemo_open", {
    itemType: input.itemType,
    target: input.target,
  });
}
