/**
 * ストアの `rowDensity` を `:root` の CSS 変数 `--row-h` に同期させる
 * (`docs/ui-design.md` §2.3)。
 *
 * `--row-h` は Sidebar の行高 + 各モジュールリスト (`PromptListPage` /
 * `LinkMemoListPage`) の高さに使われる。Color はスウォッチ grid なので影響なし。
 *
 * Theme / UI scale と同じ責務分離パターン (`useThemeAttribute` /
 * `useUiScaleAttribute`)。
 */
import { useEffect } from "react";

import { ROW_DENSITY_PX, useAppStore } from "@/store/useAppStore";

export function useRowDensityAttribute(): void {
  const rowDensity = useAppStore((s) => s.rowDensity);
  useEffect(() => {
    document.documentElement.style.setProperty("--row-h", `${ROW_DENSITY_PX[rowDensity]}px`);
  }, [rowDensity]);
}
