import { useCallback, useEffect, useState } from "react";
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate, useParams } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
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
import { deleteItem, listAllItems, reorderItems } from "@/ipc/items";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { Item, MemoPayloadV1 } from "@/lib/types";
import { modulePath } from "@/modules/registry";

export function MemoListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return <MemoListPageContent key={projectId} projectId={projectId} />;
}

function MemoListPageContent({ projectId }: { projectId: string | undefined }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingItem, setDeletingItem] = useState<Item | null>(null);

  const refresh = useCallback(async (pid: string) => {
    try {
      setLoading(true);
      setItems(await listAllItems({ moduleId: "memo", projectId: pid }));
      setError(null);
    } catch (cause) {
      setError(formatInvokeError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    void listAllItems({ moduleId: "memo", projectId })
      .then((result) => {
        if (!cancelled) {
          setItems(result);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(formatInvokeError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const createPath = projectId == null ? "" : modulePath(projectId, "memo", "/new");
  useHotkeys("mod+n", (event) => {
    event.preventDefault();
    if (createPath !== "") navigate(createPath);
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (event.over == null || event.active.id === event.over.id || projectId == null) return;
      const from = items.findIndex((item) => item.id === event.active.id);
      const to = items.findIndex((item) => item.id === event.over?.id);
      if (from < 0 || to < 0) return;
      const reordered = arrayMove(items, from, to);
      setItems(reordered);
      try {
        await reorderItems({
          projectId,
          moduleId: "memo",
          orderedIds: reordered.map((item) => item.id),
        });
        setError(null);
      } catch (cause) {
        setError(formatInvokeError(cause));
        await refresh(projectId);
      }
    },
    [items, projectId, refresh],
  );

  if (projectId == null) {
    return (
      <div className="p-6 text-sm text-[var(--fg-muted)]">プロジェクトが選択されていません。</div>
    );
  }

  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          Memos <span className="text-[var(--fg-subtle)]">· {items.length}</span>
        </h1>
        <Button variant="primary" onClick={() => navigate(createPath)}>
          <Plus size={14} aria-hidden /> 新規メモ
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
            title="まだメモがありません"
            description="長いMarkdownメモをページで作成・編集できます。"
            actions={
              <Button variant="primary" onClick={() => navigate(createPath)}>
                <Plus size={14} aria-hidden /> 新規メモ
              </Button>
            }
          />
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={items.map((item) => item.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
              {items.map((item) => (
                <MemoRow
                  key={item.id}
                  item={item}
                  onOpen={() => navigate(modulePath(projectId, "memo", `/${item.id}`))}
                  onEdit={() => navigate(modulePath(projectId, "memo", `/edit/${item.id}`))}
                  onDelete={() => setDeletingItem(item)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <ConfirmDeleteDialog
        open={deletingItem != null}
        entityLabel="メモ"
        name={deletingItem?.title ?? ""}
        onClose={() => setDeletingItem(null)}
        onConfirm={async () => {
          if (deletingItem == null) return;
          await deleteItem({ moduleId: "memo", itemId: deletingItem.id });
          await refresh(projectId);
        }}
      />
    </div>
  );
}

function MemoRow({
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const body = (item.payload as Partial<MemoPayloadV1>).body ?? "";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex min-h-[var(--row-h)] items-center gap-3 px-3 py-1 hover:bg-[var(--bg-muted)]",
        isDragging && "z-10 bg-[var(--bg-muted)] opacity-90 shadow",
      )}
    >
      <button
        type="button"
        aria-label="ドラッグして並び替え"
        className="cursor-grab text-[var(--fg-subtle)]"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} aria-hidden />
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium text-[var(--fg)]">
          {item.title}
        </span>
        {body !== "" && (
          <span className="block truncate text-[11px] text-[var(--fg-subtle)]">{body}</span>
        )}
      </button>
      {item.tags.length > 0 && (
        <span className="hidden truncate text-[12px] text-[var(--fg-muted)] md:inline">
          {item.tags.map((tag) => `#${tag}`).join(" ")}
        </span>
      )}
      <button
        type="button"
        aria-label="編集"
        onClick={onEdit}
        className="text-[var(--fg-subtle)] hover:text-[var(--accent)]"
      >
        <Pencil size={13} />
      </button>
      <button
        type="button"
        aria-label="削除"
        onClick={onDelete}
        className="text-[var(--fg-subtle)] hover:text-[var(--destructive)]"
      >
        <Trash2 size={13} />
      </button>
    </li>
  );
}
