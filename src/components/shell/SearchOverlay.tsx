/**
 * ⌘K 検索オーバーレイ (`docs/ui-design.md` §6.7 / §8.3)。
 *
 * Phase 1 PR-J: UI シェルのみ (入力欄 + Scope/Module フィルタチップ + 結果プレースホルダ)。
 * 実検索のバックエンド連携 (`StorageService::search` への `invoke`) は次 PR で接続する。
 *
 * ## 状態リセットパターン
 *
 * モーダルを再オープンしたときに query / filter を初期化したいが、`useEffect` 経由での
 * setState は eslint react-hooks/set-state-in-effect で警告される (cascading render)。
 * 代わりに、**Content コンポーネントを `open` の真偽で出し入れする** ことで、開く度に
 * 新しいインスタンスとしてマウントされ、初期 state が自然にセットされる。
 */
import { Search } from "lucide-react";
import { useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";
import type { ModuleId } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 現在プロジェクト名 (Scope の `Current project` 表示に使う) */
  currentProjectName: string | null;
}

type Scope = "project" | "global";

const MODULE_FILTERS: readonly { id: ModuleId | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "prompt", label: "Prompts" },
  { id: "linkmemo", label: "Links" },
  { id: "color", label: "Colors" },
];

export function SearchOverlay({ open, onClose, currentProjectName }: Props) {
  return (
    <Modal open={open} onClose={onClose} widthClassName="w-full max-w-2xl">
      {open && <SearchOverlayContent currentProjectName={currentProjectName} />}
    </Modal>
  );
}

function SearchOverlayContent({ currentProjectName }: { currentProjectName: string | null }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(currentProjectName != null ? "project" : "global");
  const [moduleFilter, setModuleFilter] = useState<ModuleId | "all">("all");

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
        {/* Scope (data-model.md §11.1: 内部値は "project" | "global") */}
        <div className="flex items-center gap-1 text-[12px] text-[var(--fg-muted)]">
          <span className="text-[var(--fg-subtle)]">Scope:</span>
          <ScopeChip
            label={`Current project${currentProjectName ? ` (${currentProjectName})` : ""}`}
            selected={scope === "project"}
            disabled={currentProjectName == null}
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
          {MODULE_FILTERS.map((m) => (
            <ScopeChip
              key={m.id}
              label={m.label}
              selected={moduleFilter === m.id}
              onClick={() => setModuleFilter(m.id)}
            />
          ))}
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto px-4 py-3 text-[13px] text-[var(--fg-muted)]">
        {query.trim() === "" ? (
          <p className="text-[var(--fg-subtle)]">
            検索ワードを入力 (3 文字以上で trigram 検索、それ未満は LIKE フォールバック)
          </p>
        ) : (
          <p className="text-[var(--fg-subtle)]">
            検索結果 — バックエンド接続は次 PR で実装 (<code className="font-mono">{query}</code>,
            scope={scope}, module={moduleFilter})
          </p>
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
