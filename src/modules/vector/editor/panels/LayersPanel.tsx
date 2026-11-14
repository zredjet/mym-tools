import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_NODE_NAMES } from "../model/create";
import { getNode } from "../model/tree";
import type { NodeId } from "../model/types";
import { editorStore, useEditorStore } from "../state/store";
import { IconButton } from "./fields/Section";
import { LayerRow } from "./layers/LayerRow";
import {
  applyLayerDrop,
  cachedLayerRowsKey,
  dropZoneAt,
  expandForSelection,
  parseLayerRowsKey,
  rangeBetween,
  resolveLayerDrop,
  type DropZone,
} from "./layers/layerTree";

/** パネルの幅 (§5.1)。 */
export const LAYERS_PANEL_WIDTH = 220;

/**
 * 左のレイヤーパネル (§5.2)。`view.layersPanel` が false のときは、開くボタンだけの細い帯にする。
 */
export function LayersPanel() {
  const open = useEditorStore((s) => s.view.layersPanel);
  if (!open)
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-[var(--border)] bg-[var(--bg-sidebar)] py-1.5">
        <IconButton
          label="レイヤーパネルを開く"
          title="レイヤーパネルを開く (Alt+1)"
          onClick={() => editorStore.getState().setView({ layersPanel: true })}
        >
          <PanelLeftOpen size={16} aria-hidden="true" />
        </IconButton>
      </div>
    );
  return <LayersPanelBody />;
}

interface DropState {
  overId: NodeId;
  zone: DropZone;
}

function LayersPanelBody() {
  /** 閉じた frame / group。既定はすべて開く */
  const [collapsed, setCollapsed] = useState<ReadonlySet<NodeId>>(() => new Set());
  const [draggedIds, setDraggedIds] = useState<readonly NodeId[] | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  /** Shift を押しながらのクリックの起点 */
  const anchor = useRef<NodeId | null>(null);

  // 行の並びが変わったときだけ描き直す (ノードの位置や色の変更では変わらない)
  const key = useEditorStore((s) => cachedLayerRowsKey(s.doc, s.pageId, collapsed));
  const rows = useMemo(() => parseLayerRowsKey(key), [key]);

  // キャンバスで選んだノードが見えるように、閉じた祖先を開く
  useEffect(
    () =>
      editorStore.subscribe((state, prev) => {
        if (state.selection === prev.selection) return;
        setCollapsed((current) => expandForSelection(state.doc, state.selection, current));
      }),
    [],
  );

  const onSelect = useCallback(
    (id: NodeId, modifiers: { shift: boolean; toggle: boolean }) => {
      const store = editorStore.getState();
      if (modifiers.toggle) {
        anchor.current = id;
        store.setSelection(
          store.selection.includes(id)
            ? store.selection.filter((other) => other !== id)
            : [...store.selection, id],
        );
      } else if (modifiers.shift && anchor.current !== null) {
        store.setSelection(rangeBetween(rows, anchor.current, id));
      } else {
        anchor.current = id;
        store.setSelection([id]);
      }
    },
    [rows],
  );

  const onToggleExpanded = useCallback((id: NodeId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    const store = editorStore.getState();
    if (store.selection.includes(id)) setDraggedIds([...store.selection]);
    else {
      anchor.current = id;
      store.setSelection([id]);
      setDraggedIds([id]);
    }
  };

  const onDragMove = (event: DragMoveEvent) => {
    const over = event.over;
    const row = over ? rows.find((r) => r.id === String(over.id)) : undefined;
    if (!over || !row || !draggedIds) {
      setDrop(null);
      return;
    }
    const start = event.activatorEvent as MouseEvent | null;
    const pointerY = (start?.clientY ?? 0) + event.delta.y;
    const ratio = over.rect.height > 0 ? (pointerY - over.rect.top) / over.rect.height : 0.5;
    const zone = dropZoneAt(ratio, row.container);
    const resolved = resolveLayerDrop(
      editorStore.getState().doc,
      draggedIds,
      row.id,
      zone,
      row.expanded,
    );
    const next = resolved ? { overId: row.id, zone: resolved.zone } : null;
    setDrop((prev) => (prev?.overId === next?.overId && prev?.zone === next?.zone ? prev : next));
  };

  const finishDrag = (commit: boolean) => {
    const ids = draggedIds;
    const target = drop;
    setDraggedIds(null);
    setDrop(null);
    if (!commit || !ids || !target) return;
    const store = editorStore.getState();
    // `target.zone` は表示に使った位置 (開いた行の下は `inside` に直してある) なので、そのまま解く
    const resolved = resolveLayerDrop(store.doc, ids, target.overId, target.zone, false);
    if (!resolved) return;
    store.apply((doc) => applyLayerDrop(doc, ids, resolved));
    editorStore.getState().setSelection(ids);
    if (resolved.target.kind === "node") {
      const parentId = resolved.target.id;
      setCollapsed((current) => {
        if (!current.has(parentId)) return current;
        const next = new Set(current);
        next.delete(parentId);
        return next;
      });
    }
  };

  const dragLabel = useEditorStore((s) => {
    const first = draggedIds?.[0];
    if (first === undefined || !draggedIds) return null;
    if (draggedIds.length > 1) return `${draggedIds.length} 個のレイヤー`;
    const node = getNode(s.doc, first);
    if (!node) return null;
    return node.name === "" ? DEFAULT_NODE_NAMES[node.type] : node.name;
  });

  return (
    <aside
      aria-label="レイヤー"
      className="flex min-h-0 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)]"
      style={{ width: LAYERS_PANEL_WIDTH }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border)] pr-1.5 pl-3">
        <h2 className="text-[13px] font-medium text-[var(--fg)]">レイヤー</h2>
        <IconButton
          label="レイヤーパネルを閉じる"
          title="レイヤーパネルを閉じる (Alt+1)"
          onClick={() => editorStore.getState().setView({ layersPanel: false })}
        >
          <PanelLeftClose size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={onDragMove}
        onDragEnd={() => finishDrag(true)}
        onDragCancel={() => finishDrag(false)}
      >
        <div
          role="tree"
          aria-label="レイヤー"
          aria-multiselectable="true"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1"
          onClick={(event) => {
            if (event.target === event.currentTarget) editorStore.getState().setSelection([]);
          }}
        >
          {rows.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-[var(--fg-muted)]">レイヤーはありません</p>
          ) : (
            rows.map((row) => (
              <LayerRow
                key={row.id}
                row={row}
                dropZone={drop?.overId === row.id ? drop.zone : null}
                dragging={draggedIds?.includes(row.id) ?? false}
                onSelect={onSelect}
                onToggleExpanded={onToggleExpanded}
              />
            ))
          )}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragLabel !== null && (
            <div className="inline-flex h-7 max-w-[200px] items-center truncate rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--fg)] shadow-[0_8px_24px_rgba(0,0,0,0.10)]">
              {dragLabel}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </aside>
  );
}
