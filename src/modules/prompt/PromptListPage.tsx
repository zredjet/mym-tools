/**
 * M-Prompt 一覧 (`docs/ui-design.md` §6.1 / §6.2 / §9.1)。
 *
 * Phase 1 PR-M (本 PR): create + edit + C-15 タイプ・トゥ・コンファーム削除。
 * - 行高 32px (compact、ui-design.md §2.3)
 * - 各行に title (クリックで詳細) / 検出変数件数 / 相対 updated_at / 編集 / 削除
 * - 削除は `ConfirmDeleteDialog` で名前タイプ確認 (C-15)
 * - `mod+n` (Cmd/Ctrl+N) で新規 (`docs/ui-design.md` §8.1)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { deleteItem, listItems } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";
import { extractPromptVariables } from "@/lib/promptVars";
import type { Item, PromptPayloadV1 } from "@/lib/types";
import { PromptItemDialog } from "@/modules/prompt/PromptItemDialog";

export function PromptListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [deletingItem, setDeletingItem] = useState<Item | null>(null);

  const refresh = useCallback(async (pid: string) => {
    try {
      setLoading(true);
      const list = await listItems({ moduleId: "prompt", projectId: pid });
      setItems(list);
      setError(null);
    } catch (e) {
      setError(formatInvokeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listItems({ moduleId: "prompt", projectId });
        if (!cancelled) {
          setItems(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Cmd/Ctrl+N で新規 (`docs/ui-design.md` §8.1)
  useHotkeys("mod+n", (e) => {
    e.preventDefault();
    setCreateOpen(true);
  });

  const handleConfirmDelete = useCallback(async () => {
    if (deletingItem == null) return;
    await deleteItem({ moduleId: "prompt", itemId: deletingItem.id });
    if (projectId != null) await refresh(projectId);
  }, [deletingItem, projectId, refresh]);

  if (projectId == null) {
    return (
      <div className="m-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--fg-muted)]">
        プロジェクトが選択されていません。
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          Prompts <span className="text-[var(--fg-subtle)]">· {items.length}</span>
        </h1>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} aria-hidden /> 新規プロンプト
          <span className="ml-1 text-[10px] opacity-70">⌘N</span>
        </Button>
      </header>

      {error != null && (
        <div
          role="alert"
          className="mb-3 rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-2 text-[13px] text-[var(--destructive)]"
        >
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-[13px] text-[var(--fg-subtle)]">読込中...</p>
      ) : items.length === 0 ? (
        <div className="flex-1 rounded-[var(--radius)] border border-dashed border-[var(--border)]">
          <EmptyState
            icon="📝"
            title="まだプロンプトがありません"
            description="よく使うプロンプトを保存して、変数差し込みで再利用できます。"
            actions={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={14} aria-hidden /> 新規プロンプト
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
          {items.map((item) => (
            <PromptRow
              key={item.id}
              item={item}
              projectId={projectId}
              onEdit={() => setEditingItem(item)}
              onDelete={() => setDeletingItem(item)}
            />
          ))}
        </ul>
      )}

      <PromptItemDialog
        mode="create"
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => void refresh(projectId)}
      />
      {editingItem != null && (
        <PromptItemDialog
          mode="edit"
          item={editingItem}
          open={editingItem != null}
          onClose={() => setEditingItem(null)}
          onSaved={() => void refresh(projectId)}
        />
      )}
      <ConfirmDeleteDialog
        open={deletingItem != null}
        entityLabel="プロンプト"
        name={deletingItem?.title ?? ""}
        onClose={() => setDeletingItem(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

function PromptRow({
  item,
  projectId,
  onEdit,
  onDelete,
}: {
  item: Item;
  projectId: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const body = useMemo(() => {
    const p = item.payload as PromptPayloadV1 | undefined;
    return typeof p?.body === "string" ? p.body : "";
  }, [item.payload]);
  const varCount = useMemo(() => extractPromptVariables(body).length, [body]);

  return (
    <li className="flex h-[var(--row-h)] items-center gap-3 px-3 hover:bg-[var(--bg-muted)]">
      <button
        type="button"
        onClick={() => navigate(`/projects/${projectId}/m/prompt/${item.id}`)}
        className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--fg)] hover:text-[var(--accent)]"
      >
        {item.title}
      </button>
      {item.tags.length > 0 && (
        <span className="hidden shrink-0 truncate text-[12px] text-[var(--fg-muted)] md:inline">
          {item.tags.map((t) => `#${t}`).join(" ")}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-[var(--fg-subtle)] tabular-nums">
        {varCount > 0 ? `${varCount} var${varCount === 1 ? "" : "s"}` : ""}
      </span>
      <span
        className="shrink-0 text-[11px] text-[var(--fg-subtle)] tabular-nums"
        title={item.updated_at}
      >
        {formatRelative(item.updated_at)}
      </span>
      <button
        type="button"
        aria-label="編集"
        title="編集"
        onClick={onEdit}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--accent)]"
      >
        <Pencil size={13} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="削除"
        title="削除"
        onClick={onDelete}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--destructive)]"
      >
        <Trash2 size={13} aria-hidden />
      </button>
    </li>
  );
}

/**
 * `JST_ISO8601` (29 文字、ADR-0005) を相対表示にする。
 */
function formatRelative(jstIso: string): string {
  const ts = new Date(jstIso).getTime();
  if (Number.isNaN(ts)) return jstIso;
  const diffMs = Date.now() - ts;
  const diffMin = Math.round(diffMs / 60_000);
  const diffH = Math.round(diffMs / 3_600_000);
  const diffD = Math.round(diffMs / 86_400_000);

  if (diffMin < 1) return "たった今";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffH < 24) return `${diffH}h ago`;
  if (diffD === 1) return "昨日";
  if (diffD < 7) return `${diffD}日前`;
  if (diffD < 30) return `${Math.round(diffD / 7)}週間前`;
  return jstIso.slice(0, 10);
}
