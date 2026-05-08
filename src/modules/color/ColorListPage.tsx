/**
 * M-Color 一覧 (`docs/ui-design.md` §6.5 / §9.3)。
 *
 * Phase 1 PR-M (本 PR): create + edit + C-15 タイプ・トゥ・コンファーム削除。
 * - 3〜6 列のレスポンシブパレットグリッド
 * - 各セルは正方形 swatch + 名前 + HEX
 * - hover で編集 / 削除ボタン表示
 * - `mod+n` で新規
 */
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ColorItemDialog } from "@/modules/color/ColorItemDialog";
import { deleteItem, listItems } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";
import type { ColorPayloadV1, Item } from "@/lib/types";

export function ColorListPage() {
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
      const list = await listItems({ moduleId: "color", projectId: pid });
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
        const list = await listItems({ moduleId: "color", projectId });
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

  useHotkeys("mod+n", (e) => {
    e.preventDefault();
    setCreateOpen(true);
  });

  const handleConfirmDelete = useCallback(async () => {
    if (deletingItem == null) return;
    await deleteItem({ moduleId: "color", itemId: deletingItem.id });
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
          Colors <span className="text-[var(--fg-subtle)]">· {items.length}</span>
        </h1>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} aria-hidden /> 新規 Color
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
            icon="🎨"
            title="パレットが空です"
            description="ブランド色や UI トークンを HEX/RGB/HSL/OKLCH で管理できます。"
            actions={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={14} aria-hidden /> 新規 Color
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="grid grid-cols-3 gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item) => (
            <ColorSwatch
              key={item.id}
              item={item}
              onEdit={() => setEditingItem(item)}
              onDelete={() => setDeletingItem(item)}
            />
          ))}
        </ul>
      )}

      <ColorItemDialog
        mode="create"
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => void refresh(projectId)}
      />
      {editingItem != null && (
        <ColorItemDialog
          mode="edit"
          item={editingItem}
          open={editingItem != null}
          onClose={() => setEditingItem(null)}
          onSaved={() => void refresh(projectId)}
        />
      )}
      <ConfirmDeleteDialog
        open={deletingItem != null}
        entityLabel="Color"
        name={deletingItem?.title ?? ""}
        onClose={() => setDeletingItem(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

function ColorSwatch({
  item,
  onEdit,
  onDelete,
}: {
  item: Item;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const payload = item.payload as ColorPayloadV1 | undefined;
  const hex = typeof payload?.hex === "string" ? payload.hex : "#000000";
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
      <button
        type="button"
        onClick={onEdit}
        className="aspect-square w-full"
        style={{ background: hex }}
        aria-label={`${item.title} を編集`}
      />
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-[var(--fg)]" title={item.title}>
            {item.title}
          </p>
          <p className="font-mono text-[11px] text-[var(--fg-muted)]">{hex}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label="編集"
            title="編集"
            onClick={onEdit}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] hover:text-[var(--accent)]"
          >
            <Pencil size={13} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="削除"
            title="削除"
            onClick={onDelete}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] hover:text-[var(--destructive)]"
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      </div>
    </li>
  );
}
