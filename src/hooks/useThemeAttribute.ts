/**
 * ストアの `theme` を `<html data-theme>` 属性に同期させる。
 *
 * トークンは CSS で `[data-theme="dark"]` セレクタ経由で切り替えるため
 * (`docs/ui-design.md` §2.1.3)、属性の付与・削除だけが本フックの責務。
 */
import { useEffect } from "react";

import { useAppStore } from "@/store/useAppStore";

export function useThemeAttribute(): void {
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      if (dark) root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
    };
    apply();
    if (theme === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
