/**
 * ストアの `uiScale` を `<body>` の CSS `zoom` に同期させる。
 *
 * トークンは `body { zoom: var(--ui-scale) }` (`src/index.css` 参照) で参照される。
 * ルートの containing block は percentage sizing でネイティブウィンドウ内に固定し、
 * ここでは `:root` に CSS 変数を書くだけ。Theme と同じ責務分離パターン
 * (`useThemeAttribute`)。
 *
 * `zoom` プロパティを採用した理由 (ユーザー要望: 案 B / UI 全体スケール):
 * - 文字 / spacing / swatch / モーダル幅まで一括で拡縮できる (Linear / Slack 風)
 * - `font-size` + `rem` 全置換よりも refactor 範囲が圧倒的に小さい
 * - 既知の制約: `zoom` は CSS Box 4 草案だが Chromium / WebKit / Firefox 全てで
 *   実用レベル。Tauri 2 の WebView (Win=WebView2, macOS=WKWebView) も対応
 */
import { useEffect } from "react";

import { useAppStore } from "@/store/useAppStore";

export function useUiScaleAttribute(): void {
  const uiScale = useAppStore((s) => s.uiScale);
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", String(uiScale));
  }, [uiScale]);
}
