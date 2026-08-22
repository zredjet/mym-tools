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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/Button";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { deleteItem, listItems, reorderItems } from "@/ipc/items";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { Item, PalettePayloadV1 } from "@/lib/types";
import { modulePath } from "@/modules/registry";

import { PaletteNav } from "./PaletteEditorPage";
import { HARMONY_LABELS } from "./paletteMath";

export function PaletteListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingItem, setDeletingItem] = useState<Item | null>(null);

  const refresh = useCallback(async (pid: string) => {
    try {
      setLoading(true);
      setItems(await listItems({ moduleId: "palette", projectId: pid }));
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
    void (async () => {
      try {
        const list = await listItems({ moduleId: "palette", projectId });
        if (!cancelled) {
          setItems(list);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(formatInvokeError(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const openCreate = useCallback(() => {
    if (projectId != null) navigate(modulePath(projectId, "palette"));
  }, [navigate, projectId]);

  useHotkeys("mod+n", (event) => {
    event.preventDefault();
    openCreate();
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
          moduleId: "palette",
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

  const confirmDelete = useCallback(async () => {
    if (deletingItem == null) return;
    await deleteItem({ moduleId: "palette", itemId: deletingItem.id });
    if (projectId != null) await refresh(projectId);
  }, [deletingItem, projectId, refresh]);

  if (projectId == null) {
    return (
      <div className="p-6 text-sm text-[var(--fg-muted)]">プロジェクトが選択されていません。</div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg)]">
      <PaletteNav projectId={projectId} active="saved" />
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-pad)] py-5">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--fg)]">
              保存済みパレット <span className="text-[var(--fg-subtle)]">· {items.length}</span>
            </h1>
            <p className="mt-0.5 text-[12px] text-[var(--fg-subtle)]">
              プロジェクト内のカラーテーマ
            </p>
          </div>
          <Button variant="primary" onClick={openCreate}>
            <Plus size={14} aria-hidden /> 新しいパレット
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
          <div className="min-h-72 rounded-[var(--radius)] border border-dashed border-[var(--border)]">
            <EmptyState
              icon="◉"
              title="保存されたパレットはありません"
              description="カラーホイールとハーモニーから、最初の5色パレットを作成しましょう。"
              actions={
                <Button variant="primary" onClick={openCreate}>
                  <Plus size={14} aria-hidden /> パレットを作成
                </Button>
              }
            />
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={items.map((item) => item.id)} strategy={rectSortingStrategy}>
              <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                {items.map((item) => (
                  <PaletteCard
                    key={item.id}
                    item={item}
                    onEdit={() => navigate(modulePath(projectId, "palette", `/edit/${item.id}`))}
                    onDelete={() => setDeletingItem(item)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <ConfirmDeleteDialog
        open={deletingItem != null}
        entityLabel="パレット"
        name={deletingItem?.title ?? ""}
        onClose={() => setDeletingItem(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function PaletteCard({
  item,
  onEdit,
  onDelete,
}: {
  item: Item;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const payload = item.payload as Partial<PalettePayloadV1>;
  const colors = validColors(payload.colors) ? payload.colors : FALLBACK_COLORS;
  const harmony =
    payload.harmony != null && payload.harmony in HARMONY_LABELS
      ? HARMONY_LABELS[payload.harmony]
      : "カスタム";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] shadow-sm",
        isDragging && "z-10 opacity-90 shadow-lg",
      )}
    >
      <button
        type="button"
        onClick={onEdit}
        className="grid h-24 w-full grid-cols-5"
        aria-label={`${item.title} を編集`}
      >
        {colors.map((color, index) => (
          <span key={index} style={{ backgroundColor: color }} />
        ))}
      </button>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold text-[var(--fg)]">{item.title}</h2>
          <p className="mt-0.5 truncate text-[11px] text-[var(--fg-subtle)]">
            {harmony}
            {item.tags.length > 0 ? ` · ${item.tags.map((tag) => `#${tag}`).join(" ")}` : ""}
          </p>
          <p className="mt-1 truncate font-mono text-[10px] text-[var(--fg-muted)]">
            {colors.join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="ドラッグして並び替え"
            title="ドラッグして並び替え"
            className="inline-flex h-7 w-7 cursor-grab items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`${item.title} を編集`}
            onClick={onEdit}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)]"
          >
            <Pencil size={13} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`${item.title} を削除`}
            onClick={onDelete}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]"
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      </div>
    </li>
  );
}

const FALLBACK_COLORS = ["#52525B", "#71717A", "#A1A1AA", "#D4D4D8", "#F4F4F5"] as const;

function validColors(value: unknown): value is PalettePayloadV1["colors"] {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    value.every((color) => typeof color === "string" && /^#[0-9A-Fa-f]{6}$/.test(color))
  );
}
