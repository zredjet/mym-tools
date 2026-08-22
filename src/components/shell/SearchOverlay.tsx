/**
 * ⌘K 検索オーバーレイ (`docs/ui-design.md` §6.7 / §8.3)。
 *
 * バックエンド `core_search` に接続し、Scope (project/global) と有効な stateful module の
 * フィルタを提供する。結果表示と遷移先は registry の SearchAdapter から導出する。
 *
 * ## 状態リセットパターン
 *
 * 開閉時に query / filter を初期化したいが `useEffect` 経由の setState は eslint
 * react-hooks/set-state-in-effect で警告される。代わりに Content コンポーネントを
 * `open` で出し入れすることで自然な mount/unmount で初期化される。
 */
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Modal } from "@/components/ui/Modal";
import { search as runSearch } from "@/ipc/search";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { Item, ModuleId, SearchScope } from "@/lib/types";
import { enabledModules, getModuleDefinition, modulePath } from "@/modules/registry";
import { useAppStore } from "@/store/useAppStore";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 現在プロジェクト ID + 名 (Scope の `Current project` 表示と検索に使う) */
  currentProjectId: string | null;
  currentProjectName: string | null;
}

type Scope = "project" | "global";

const SEARCH_DEBOUNCE_MS = 200;

export function SearchOverlay({ open, onClose, currentProjectId, currentProjectName }: Props) {
  return (
    <Modal open={open} onClose={onClose} widthClassName="w-full max-w-2xl">
      {open && (
        <SearchOverlayContent
          currentProjectId={currentProjectId}
          currentProjectName={currentProjectName}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function SearchOverlayContent({
  currentProjectId,
  currentProjectName,
  onClose,
}: {
  currentProjectId: string | null;
  currentProjectName: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const moduleEnabled = useAppStore((state) => state.moduleEnabled);
  const searchDefaultScope = useAppStore((state) => state.searchDefaultScope);
  const searchableModules = useMemo(
    () => enabledModules(moduleEnabled).filter((module) => !module.isStateless),
    [moduleEnabled],
  );
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(
    searchDefaultScope === "project" && currentProjectId == null ? "global" : searchDefaultScope,
  );
  const [moduleFilter, setModuleFilter] = useState<ModuleId | "all">("all");
  const [results, setResults] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // query 変更で debounced 検索実行。空クエリでは何もせず、表示側で `query.trim() === ""`
  // を分岐に使う (前回 results が残っても表示には出ない)。
  // 検索実行中の cancellation は cleanup 関数で `cancelled` フラグを立てて行う
  // (eslint react-hooks/set-state-in-effect の「外部システム同期」例外パターン)。
  useEffect(() => {
    if (query.trim() === "" || searchableModules.length === 0) return;
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      const searchScope: SearchScope =
        scope === "project" && currentProjectId != null
          ? { type: "project", project_id: currentProjectId }
          : { type: "global" };
      void (async () => {
        if (!cancelled) setLoading(true);
        try {
          const found = await runSearch({
            scope: searchScope,
            query,
            moduleFilter:
              moduleFilter === "all"
                ? searchableModules.map((module) => module.id)
                : [moduleFilter],
            limit: 50,
          });
          if (!cancelled) {
            setResults(found);
            setError(null);
          }
        } catch (e) {
          if (!cancelled) setError(formatInvokeError(e));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [query, scope, moduleFilter, currentProjectId, searchableModules]);

  const handleResultClick = (item: Item) => {
    onClose();
    const definition = getModuleDefinition(item.module_id);
    if (definition?.searchAdapter == null) return;
    const view = definition.searchAdapter.formatResult(item);
    navigate(modulePath(item.project_id, definition.id, view.targetPath));
  };

  return (
    <div className="-mx-4 -my-3">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <Search size={16} aria-hidden className="text-[var(--fg-muted)]" />
        <input
          type="text"
          autoFocus
          placeholder="検索..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 flex-1 bg-transparent text-sm text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)]"
          aria-label="検索クエリ"
        />
        <span className="rounded bg-[var(--bg-muted)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-subtle)]">
          Esc
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2">
        <div className="flex items-center gap-1 text-[12px] text-[var(--fg-muted)]">
          <span className="text-[var(--fg-subtle)]">Scope:</span>
          <ScopeChip
            label={`Current project${currentProjectName ? ` (${currentProjectName})` : ""}`}
            selected={scope === "project"}
            disabled={currentProjectId == null}
            onClick={() => setScope("project")}
          />
          <ScopeChip
            label="All projects"
            selected={scope === "global"}
            onClick={() => setScope("global")}
          />
        </div>
        <div className="flex items-center gap-1 text-[12px] text-[var(--fg-muted)]">
          <span className="text-[var(--fg-subtle)]">Module:</span>
          {[{ id: "all", displayName: "すべて" }, ...searchableModules].map((m) => (
            <ScopeChip
              key={m.id}
              label={m.displayName}
              selected={moduleFilter === m.id}
              onClick={() => setModuleFilter(m.id)}
            />
          ))}
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto px-4 py-3 text-[13px] text-[var(--fg-muted)]">
        {error != null ? (
          <p role="alert" className="text-[var(--destructive)]">
            {error}
          </p>
        ) : query.trim() === "" ? (
          <p className="text-[var(--fg-subtle)]">
            検索ワードを入力 (3 文字以上で trigram 検索、それ未満は LIKE フォールバック)
          </p>
        ) : loading ? (
          <p className="text-[var(--fg-subtle)]">検索中...</p>
        ) : results.length === 0 ? (
          <p className="text-[var(--fg-subtle)]">
            該当なし — クエリ <code className="font-mono">{query}</code>
          </p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {results.map((item) => {
              const definition = getModuleDefinition(item.module_id);
              const view = definition?.searchAdapter?.formatResult(item) ?? {
                title: item.title,
                targetPath: "/",
              };
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleResultClick(item)}
                    className="flex w-full items-center gap-3 rounded-[var(--radius)] px-2 py-1.5 text-left hover:bg-[var(--bg-muted)]"
                  >
                    <span className="rounded-full bg-[var(--bg-muted)] px-2 py-0.5 font-mono text-[11px] text-[var(--fg-subtle)] uppercase">
                      {definition?.displayName ?? item.module_id}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[var(--fg)]">
                        {view.title}
                      </span>
                      {view.subtitle != null && (
                        <span className="block truncate text-[11px] text-[var(--fg-subtle)]">
                          {view.subtitle}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ScopeChip({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-full px-2.5 py-0.5 text-[12px] transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "bg-[var(--bg-accent-soft)] text-[var(--accent)]"
          : "text-[var(--fg)] hover:bg-[var(--bg-muted)]",
      )}
    >
      {label}
    </button>
  );
}
