import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DEFAULT_NODE_NAMES } from "../model/create";
import { getNode } from "../model/tree";
import type { NodeId } from "../model/types";
import { editorStore, useEditorStore } from "../state/store";
import { IconButton } from "./fields/Section";
import { LayerRow } from "./layers/LayerRow";
import {
  applyLayerDrop,
  cachedLayerRowsKey,
  expandForSelection,
  locateDrop,
  parseLayerRowsKey,
  rangeBetween,
  resolveLayerDrop,
  type DropCandidate,
  type DropZone,
  type LayerRow as LayerRowData,
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

/** 一覧全体のドラッグの ID。どの行から始めたかは押した要素から引く。 */
const LIST_DRAG_ID = "layers";

/** ドラッグ中の名札をポインターの右下に置く (ドラッグの元は一覧全体なので、そのままでは一覧の左上に出る)。 */
const besidePointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect || !("clientX" in activatorEvent)) return transform;
  const start = activatorEvent as MouseEvent;
  return {
    ...transform,
    x: transform.x + start.clientX - draggingNodeRect.left + 12,
    y: transform.y + start.clientY - draggingNodeRect.top + 8,
  };
};

/**
 * 行を包むドラッグの元。dnd-kit の context の変化 (ドラッグ中の移動など) ではここだけが描き直され、
 * `children` (行の要素) は同じものなので、行は描き直されない。
 */
function DraggableList({ children }: { children: ReactNode }) {
  const { setNodeRef, listeners } = useDraggable({ id: LIST_DRAG_ID });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className="flex min-h-full flex-col"
      onClick={(event) => {
        if (event.target === event.currentTarget) editorStore.getState().setSelection([]);
      }}
    >
      {children}
    </div>
  );
}

/** 挿入線や枠を出している落とし先。 */
interface DropState {
  overId: NodeId;
  zone: DropZone;
  /** 挿入線の深さ */
  depth: number;
}

interface DragSession {
  ids: readonly NodeId[];
  /** 今のポインターの位置 (画面座標) */
  x: number;
  y: number;
  /** 前回の候補 (同じなら求め直さない) */
  key: string;
  candidate: DropCandidate | null;
}

/**
 * ポインターの位置の下にある行と、その今の矩形。行より下の余白なら最後の行。
 * 矩形はその場で測るので、ドラッグの途中で一覧がスクロールしても判定がずれない (§5.2)。
 */
function hitRow(
  container: HTMLElement,
  x: number,
  y: number,
): { id: NodeId; rect: DOMRect } | null {
  const hits =
    typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [];
  for (const hit of hits) {
    const row = hit.closest<HTMLElement>("[data-layer-id]");
    if (row && container.contains(row) && row.dataset.layerId !== undefined)
      return { id: row.dataset.layerId, rect: row.getBoundingClientRect() };
  }
  const box = container.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
  const rows = container.querySelectorAll<HTMLElement>("[data-layer-id]");
  const last = rows[rows.length - 1];
  if (!last || last.dataset.layerId === undefined) return null;
  const rect = last.getBoundingClientRect();
  return y > rect.bottom ? { id: last.dataset.layerId, rect } : null;
}

/** 行の id から作った一覧での位置。 */
function rowIndex(rows: readonly LayerRowData[], id: NodeId): number {
  return rows.findIndex((row) => row.id === id);
}

/** 候補を解いて、実際に文書が変わるときだけ返す (落とせない位置には線を出さない。§5.2)。 */
function resolveCandidate(
  rows: readonly LayerRowData[],
  ids: readonly NodeId[],
  candidate: DropCandidate,
) {
  const row = rows[rowIndex(rows, candidate.overId)];
  if (!row) return null;
  const doc = editorStore.getState().doc;
  const drop = resolveLayerDrop(
    doc,
    ids,
    candidate.overId,
    candidate.zone,
    row.expanded,
    candidate.climb,
  );
  if (!drop || applyLayerDrop(doc, ids, drop) === doc) return null;
  return { drop, depth: drop.zone === "inside" ? row.depth : row.depth - candidate.climb };
}

function LayersPanelBody() {
  /** 閉じた frame / group。既定はすべて開く */
  const [collapsed, setCollapsed] = useState<ReadonlySet<NodeId>>(() => new Set());
  const [draggedIds, setDraggedIds] = useState<readonly NodeId[] | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  /** Shift を押しながらのクリックの起点 */
  const anchor = useRef<NodeId | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const drag = useRef<DragSession | null>(null);
  const stopTracking = useRef<(() => void) | null>(null);

  // 行の並びが変わったときだけ描き直す (ノードの位置や色の変更では変わらない)
  const key = useEditorStore((s) => cachedLayerRowsKey(s.doc, s.pageId, collapsed));
  const rows = useMemo(() => parseLayerRowsKey(key), [key]);
  /** ハンドラから今の行を読むため (ハンドラを作り直すと全行の memo が外れる) */
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // キャンバスで選んだノードが見えるように、閉じた祖先を開く
  useEffect(
    () =>
      editorStore.subscribe((state, prev) => {
        if (state.selection === prev.selection) return;
        setCollapsed((current) => expandForSelection(state.doc, state.selection, current));
      }),
    [],
  );

  useEffect(() => () => stopTracking.current?.(), []);

  const onSelect = useCallback((id: NodeId, modifiers: { shift: boolean; toggle: boolean }) => {
    const store = editorStore.getState();
    if (modifiers.toggle) {
      anchor.current = id;
      store.setSelection(
        store.selection.includes(id)
          ? store.selection.filter((other) => other !== id)
          : [...store.selection, id],
      );
    } else if (modifiers.shift && anchor.current !== null) {
      store.setSelection(rangeBetween(rowsRef.current, anchor.current, id));
    } else {
      anchor.current = id;
      store.setSelection([id]);
    }
  }, []);

  const onToggleExpanded = useCallback((id: NodeId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /** 今のポインターの位置から落とし先を求め直す。 */
  const evaluate = useCallback(() => {
    const session = drag.current;
    const container = tree.current;
    if (!session || !container) return;
    const hit = hitRow(container, session.x, session.y);
    const list = rowsRef.current;
    const candidate = hit
      ? locateDrop(list, rowIndex(list, hit.id), hit.rect, { x: session.x, y: session.y })
      : null;
    const nextKey = candidate ? `${candidate.overId}|${candidate.zone}|${candidate.climb}` : "";
    if (nextKey === session.key) return;
    session.key = nextKey;
    const resolved = candidate ? resolveCandidate(list, session.ids, candidate) : null;
    session.candidate = resolved ? candidate : null;
    setDrop(
      resolved && candidate
        ? { overId: candidate.overId, zone: resolved.drop.zone, depth: resolved.depth }
        : null,
    );
  }, []);

  const onDragStart = (event: DragStartEvent) => {
    const start = event.activatorEvent as MouseEvent | null;
    const target = start?.target instanceof Element ? start.target : null;
    const id = target?.closest<HTMLElement>("[data-layer-id]")?.dataset.layerId;
    if (id === undefined) return;
    const store = editorStore.getState();
    let ids: readonly NodeId[] = [id];
    if (store.selection.includes(id)) ids = [...store.selection];
    else {
      anchor.current = id;
      store.setSelection([id]);
    }
    drag.current = {
      ids,
      x: start?.clientX ?? 0,
      y: start?.clientY ?? 0,
      key: "",
      candidate: null,
    };
    setDraggedIds(ids);

    // dnd-kit の delta はスクロール量を含むので、ポインターの位置は自分で追う
    const onMove = (move: PointerEvent) => {
      if (!drag.current) return;
      drag.current.x = move.clientX;
      drag.current.y = move.clientY;
      evaluate();
    };
    const onScroll = () => {
      if (drag.current) drag.current.key = "";
      evaluate();
    };
    const container = tree.current;
    window.addEventListener("pointermove", onMove, true);
    container?.addEventListener("scroll", onScroll);
    stopTracking.current = () => {
      window.removeEventListener("pointermove", onMove, true);
      container?.removeEventListener("scroll", onScroll);
      stopTracking.current = null;
    };
  };

  const finishDrag = (commit: boolean) => {
    const session = drag.current;
    drag.current = null;
    stopTracking.current?.();
    setDraggedIds(null);
    setDrop(null);
    const candidate = session?.candidate;
    if (!commit || !session || !candidate) return;
    const resolved = resolveCandidate(rowsRef.current, session.ids, candidate);
    if (!resolved) return;
    const store = editorStore.getState();
    store.apply((doc) => applyLayerDrop(doc, session.ids, resolved.drop));
    editorStore.getState().setSelection(session.ids);
    const target = resolved.drop.target;
    if (target.kind === "node")
      setCollapsed((current) => {
        if (!current.has(target.id)) return current;
        const next = new Set(current);
        next.delete(target.id);
        return next;
      });
  };

  const dragLabel = useEditorStore((s) => {
    const first = draggedIds?.[0];
    if (first === undefined || !draggedIds) return null;
    if (draggedIds.length > 1) return `${draggedIds.length} 個のレイヤー`;
    const node = getNode(s.doc, first);
    if (!node) return null;
    return node.name === "" ? DEFAULT_NODE_NAMES[node.type] : node.name;
  });
  const dragging = useMemo(() => new Set(draggedIds ?? []), [draggedIds]);

  // 行の要素は、行の並び・落とし先・ドラッグ中の行が変わったときだけ作り直す
  const rowElements = useMemo(
    () =>
      rows.map((row) => (
        <LayerRow
          key={row.id}
          id={row.id}
          depth={row.depth}
          hasChildren={row.hasChildren}
          expanded={row.expanded}
          dropZone={drop?.overId === row.id ? drop.zone : null}
          dropDepth={drop?.overId === row.id ? drop.depth : row.depth}
          dragging={dragging.has(row.id)}
          onSelect={onSelect}
          onToggleExpanded={onToggleExpanded}
        />
      )),
    [rows, drop, dragging, onSelect, onToggleExpanded],
  );

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
        onDragStart={onDragStart}
        onDragEnd={() => finishDrag(true)}
        onDragCancel={() => finishDrag(false)}
      >
        <div
          ref={tree}
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
            <DraggableList>{rowElements}</DraggableList>
          )}
        </div>
        <DragOverlay
          dropAnimation={null}
          modifiers={[besidePointer]}
          className="pointer-events-none"
        >
          {dragLabel !== null && (
            <div className="pointer-events-none inline-flex h-7 max-w-[200px] items-center truncate rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--fg)] shadow-[0_8px_24px_rgba(0,0,0,0.10)]">
              {dragLabel}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </aside>
  );
}
