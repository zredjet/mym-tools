/**
 * プロジェクト切替コマンドパレット (`docs/ui-design.md` §6 C-3 / §8.1)。
 *
 * `Cmd/Ctrl + Shift + P` で開く。プロジェクト名で絞り込み + ↑↓ 選択 + Enter で
 * 該当プロジェクトに遷移する Linear / VS Code 風の switcher。
 *
 * - 遷移先は `/projects/<pid>/m/<lastOpenedModule || "prompt">`
 *   (現在いるモジュールがあればそれを引き継ぐ)
 * - クリックも対応 (キーボード派 / マウス派の両方を救う)
 * - 0 件マッチ時は「該当なし」表示。新規プロジェクトはサイドバーの `[+]` で作る
 *
 * ## キー
 * - `↑` / `↓`: 候補移動
 * - `Enter`: 選択中の project に遷移
 * - `Esc`: 閉じる (Modal 共通)
 *
 * ## 状態リセット (SearchOverlay と同じパターン)
 *
 * Content コンポーネントを `open` で出し入れすることで、再オープン時に query /
 * 選択 index が自然に初期化される (`useEffect` 経由 setState を回避)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";
import type { ModuleId, Project } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

interface Props {
  open: boolean;
  onClose: () => void;
  projects: Project[];
}

export function ProjectSwitcher({ open, onClose, projects }: Props) {
  return (
    <Modal open={open} onClose={onClose} widthClassName="w-full max-w-xl">
      {open && <Content projects={projects} onClose={onClose} />}
    </Modal>
  );
}

function Content({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const navigate = useNavigate();
  const { moduleId } = useParams<{ moduleId?: string }>();
  const lastOpenedModuleId = useAppStore((s) => s.lastOpenedModuleId);
  const setLastProject = useAppStore((s) => s.setLastOpenedProjectId);
  const setLastModule = useAppStore((s) => s.setLastOpenedModuleId);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // case-insensitive 部分一致 (name のみ。description は出すが検索対象外)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  // query 変更時に active index を 0 にリセット (input の onChange で同時にやる)
  // → ただし filter 結果が空のときは 0 でも OK (Enter 時に何も起きない)
  const clampedIndex = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  const goTo = (project: Project) => {
    const m: ModuleId = (moduleId as ModuleId | undefined) ?? lastOpenedModuleId ?? "prompt";
    // hash は project スコープではないので、それを引き継いだら prompt にフォールバック
    const targetModule: ModuleId = m === "hash" ? "prompt" : m;
    setLastProject(project.id);
    setLastModule(targetModule);
    navigate(`/projects/${project.id}/m/${targetModule}`);
    onClose();
  };

  // 選択行が画面外に行ったら scroll-into-view (キーボード操作時の追従)。
  // jsdom には `scrollIntoView` が無いので関数存在チェック (テスト時は no-op)
  useEffect(() => {
    const list = listRef.current;
    if (list == null) return;
    const child = list.children[clampedIndex] as HTMLElement | undefined;
    if (child != null && typeof child.scrollIntoView === "function") {
      child.scrollIntoView({ block: "nearest" });
    }
  }, [clampedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[clampedIndex];
      if (target != null) goTo(target);
    }
  };

  return (
    <div className="-mx-4 -my-3">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <Search size={16} aria-hidden className="text-[var(--fg-muted)]" />
        <input
          type="text"
          autoFocus
          placeholder="プロジェクトを検索..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          className="h-7 flex-1 bg-transparent text-sm text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)]"
          aria-label="プロジェクト検索"
        />
        <span className="rounded bg-[var(--bg-muted)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-subtle)]">
          Esc
        </span>
      </div>

      <div className="max-h-80 overflow-y-auto px-2 py-2 text-[13px]">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-[12px] text-[var(--fg-subtle)]">
            {projects.length === 0
              ? "プロジェクトがありません — サイドバーの [+] から作成してください"
              : `「${query}」に一致するプロジェクトはありません`}
          </p>
        ) : (
          <ul ref={listRef} className="flex flex-col">
            {filtered.map((p, idx) => {
              const isActive = idx === clampedIndex;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => goTo(p)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded-[var(--radius)] px-2 py-1.5 text-left",
                      isActive
                        ? "bg-[var(--bg-accent-soft)] text-[var(--accent)]"
                        : "text-[var(--fg)] hover:bg-[var(--bg-muted)]",
                    )}
                  >
                    <span
                      className={cn(
                        "truncate text-[13px]",
                        isActive ? "font-medium" : "font-normal",
                      )}
                    >
                      {p.name}
                    </span>
                    {p.description != null && p.description !== "" && (
                      <span
                        className={cn(
                          "truncate text-[11px]",
                          isActive ? "text-[var(--accent)] opacity-80" : "text-[var(--fg-muted)]",
                        )}
                      >
                        {p.description}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--fg-subtle)]">
        <span>↑↓ 移動・Enter 選択・Esc 閉じる</span>
        <span className="tabular-nums">
          {filtered.length} / {projects.length}
        </span>
      </div>
    </div>
  );
}
