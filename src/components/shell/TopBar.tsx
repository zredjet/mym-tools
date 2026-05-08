/**
 * トップバー (`docs/ui-design.md` §3.4 / §6.1)。高さ 40px 固定。
 *
 * 左: 現在プロジェクトのドロップダウン (Phase 1 では表示のみ、ドロップダウンは Phase 1 中盤)
 * 中央: ⌘K Search トリガ (クリック / Cmd+K で SearchOverlay を開く)
 * 右: テーマトグル + About (About は Phase 1 終盤の C-9 で接続)
 */
import { Info, Search } from "lucide-react";

import { ThemeToggle } from "@/components/shell/ThemeToggle";
import type { Project } from "@/lib/types";

interface Props {
  currentProject: Project | null;
  onOpenSearch: () => void;
}

export function TopBar({ currentProject, onOpenSearch }: Props) {
  return (
    <header
      className="flex h-[var(--topbar-h)] shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-3"
      role="banner"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-[var(--fg)]">
        {currentProject != null ? (
          <>
            <span className="truncate" title={currentProject.name}>
              {currentProject.name}
            </span>
          </>
        ) : (
          <span className="text-[var(--fg-muted)]">プロジェクト未選択</span>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenSearch}
        className="group inline-flex h-7 max-w-md min-w-72 flex-1 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-[13px] text-[var(--fg-muted)] hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
        aria-label="検索を開く"
      >
        <Search size={14} aria-hidden />
        <span className="truncate">Search...</span>
        <span className="ml-auto rounded bg-[var(--bg-muted)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-subtle)]">
          ⌘K
        </span>
      </button>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <button
          type="button"
          aria-label="About"
          title="About"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius)] text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]"
        >
          <Info size={16} aria-hidden />
        </button>
      </div>
    </header>
  );
}
