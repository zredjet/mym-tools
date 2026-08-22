/**
 * M-LinkMemo 一覧 (`docs/ui-design.md` §6.4 / §9.2)。
 *
 * create + edit + C-15 タイプ・トゥ・コンファーム削除 + open を提供する。
 * - 行高 32px / type 別アイコン (URL: 🌐 / Path: 📄 / Memo: 📝)
 * - クリックで OS 既定アプリで開く (memo は `LinkMemoMemoDialog` で body を表示)
 * - 編集ボタン → `LinkMemoItemDialog` (mode=edit)
 * - 削除は `ConfirmDeleteDialog`
 * - `mod+n` で新規
 */
import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  FileText,
  Globe,
  GripVertical,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
} from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useParams } from "react-router-dom";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/Button";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { deleteItem, listItems, reorderItems } from "@/ipc/items";
import { linkmemoOpen } from "@/ipc/linkmemo";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { Item, LinkMemoPayloadV1 } from "@/lib/types";
import { LinkMemoItemDialog } from "@/modules/linkmemo/LinkMemoItemDialog";
import { LinkMemoMemoDialog } from "@/modules/linkmemo/LinkMemoMemoDialog";

export function LinkMemoListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [deletingItem, setDeletingItem] = useState<Item | null>(null);
  const [viewingMemo, setViewingMemo] = useState<Item | null>(null);

  const refresh = useCallback(async (pid: string) => {
    try {
      setLoading(true);
      const list = await listItems({ moduleId: "linkmemo", projectId: pid });
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
        const list = await listItems({ moduleId: "linkmemo", projectId });
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
    await deleteItem({ moduleId: "linkmemo", itemId: deletingItem.id });
    if (projectId != null) await refresh(projectId);
  }, [deletingItem, projectId, refresh]);

  // D&D 並び替え (`docs/ui-design.md` §3.3.1)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (over == null || active.id === over.id || projectId == null) return;
      const oldIndex = items.findIndex((i) => i.id === active.id);
      const newIndex = items.findIndex((i) => i.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const reordered = arrayMove(items, oldIndex, newIndex);
      setItems(reordered);
      try {
        await reorderItems({
          projectId,
          moduleId: "linkmemo",
          orderedIds: reordered.map((i) => i.id),
        });
        setError(null);
      } catch (e) {
        setError(formatInvokeError(e));
        await refresh(projectId);
      }
    },
    [items, projectId, refresh],
  );

  const handleOpen = async (item: Item) => {
    const payload = asPayload(item);
    // memo は OS で開けないので詳細モーダルを表示
    if (payload.type === "memo") {
      setViewingMemo(item);
      return;
    }
    if (payload.target == null || payload.target === "") return;
    try {
      await linkmemoOpen({ itemType: payload.type, target: payload.target });
    } catch (e) {
      setError(formatInvokeError(e));
    }
  };

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
          Links / Memos <span className="text-[var(--fg-subtle)]">· {items.length}</span>
        </h1>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} aria-hidden /> 新規 Link/Memo
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
            icon="🔗"
            title="Link / Memo を追加しましょう"
            description="URL / ローカルパス / メモをプロジェクトごとに整理できます。"
            actions={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={14} aria-hidden /> 新規 Link/Memo
              </Button>
            }
          />
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
              {items.map((item) => (
                <LinkMemoRow
                  key={item.id}
                  item={item}
                  onOpen={() => void handleOpen(item)}
                  onEdit={() => setEditingItem(item)}
                  onDelete={() => setDeletingItem(item)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <LinkMemoItemDialog
        mode="create"
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => void refresh(projectId)}
      />
      {editingItem != null && (
        <LinkMemoItemDialog
          mode="edit"
          item={editingItem}
          open={editingItem != null}
          onClose={() => setEditingItem(null)}
          onSaved={() => void refresh(projectId)}
        />
      )}
      <ConfirmDeleteDialog
        open={deletingItem != null}
        entityLabel="Link / Memo"
        name={deletingItem?.title ?? ""}
        onClose={() => setDeletingItem(null)}
        onConfirm={handleConfirmDelete}
      />
      <LinkMemoMemoDialog
        open={viewingMemo != null}
        item={viewingMemo}
        onClose={() => setViewingMemo(null)}
        onEdit={() => {
          // 詳細モーダルから編集に遷移
          if (viewingMemo == null) return;
          const item = viewingMemo;
          setViewingMemo(null);
          setEditingItem(item);
        }}
      />
    </div>
  );
}

function asPayload(item: Item): LinkMemoPayloadV1 {
  const p = item.payload as LinkMemoPayloadV1 | undefined;
  return p ?? { type: "memo", target: null, body: "" };
}

function LinkMemoRow({
  item,
  onOpen,
  onEdit,
  onDelete,
}: {
  item: Item;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const payload = asPayload(item);
  const Icon = payload.type === "url" ? Globe : payload.type === "path" ? FileText : StickyNote;
  const openable = payload.type !== "memo" && payload.target != null && payload.target !== "";

  // D&D (`docs/ui-design.md` §3.3.1)、Sidebar / Prompt と同パターン
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex h-[var(--row-h)] items-center gap-3 px-3 hover:bg-[var(--bg-muted)]",
        isDragging && "z-10 bg-[var(--bg-muted)] opacity-90 shadow",
      )}
    >
      <button
        type="button"
        aria-label="ドラッグして並び替え"
        title="ドラッグして並び替え"
        className="inline-flex h-5 w-3 cursor-grab items-center justify-center text-[var(--fg-subtle)] hover:text-[var(--fg-muted)] active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} aria-hidden />
      </button>
      <Icon
        size={14}
        aria-hidden
        className={
          payload.type === "url"
            ? "text-[var(--accent)]"
            : payload.type === "path"
              ? "text-[var(--fg-muted)]"
              : "text-[var(--fg-subtle)]"
        }
      />
      <button
        type="button"
        onClick={onOpen}
        title={payload.type === "memo" ? "メモを表示" : (payload.target ?? "")}
        className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--fg)] hover:text-[var(--accent)]"
      >
        {item.title}
      </button>
      {item.tags.length > 0 && (
        <span className="hidden shrink-0 truncate text-[12px] text-[var(--fg-muted)] md:inline">
          {item.tags.map((t) => `#${t}`).join(" ")}
        </span>
      )}
      {openable && (
        <button
          type="button"
          aria-label="OS で開く"
          title="OS で開く"
          onClick={onOpen}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--accent)]"
        >
          <ExternalLink size={13} aria-hidden />
        </button>
      )}
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
