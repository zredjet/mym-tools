/**
 * ライト/ダーク テーマ切替アイコンボタン (`docs/ui-design.md` §3.2 サイドバー右上 / トップバー右)。
 *
 * 現在テーマと逆のアイコンを表示する (= クリックすると切り替わる方向のヒント)。
 */
import { Moon, Sun } from "lucide-react";

import { useAppStore } from "@/store/useAppStore";

interface Props {
  className?: string;
}

export function ThemeToggle({ className }: Props) {
  const theme = useAppStore((s) => s.theme);
  const toggle = useAppStore((s) => s.toggleTheme);
  const Icon = theme === "dark" ? Sun : Moon;
  const label = theme === "dark" ? "ライトモードに切替" : "ダークモードに切替";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius)] text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)] ${className ?? ""}`}
      onClick={toggle}
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}
