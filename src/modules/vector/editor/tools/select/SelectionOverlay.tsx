/**
 * 選択の重ね描き (§4.3 / §4.5)。現在のツールに関係なくキャンバスが重ね描き用 SVG の
 * ページ座標の `<g>` に置く。描くもの:
 *
 * - ホバーの枠 (選択していないノード。選択ツールのときだけ)
 * - 選択したノードの枠と、動かせる選択の外接矩形・リサイズハンドル (選択ツールのとき)。
 *   線を 1 本だけ選んだときのハンドルは始点と終点の 2 個。本文の編集中のノードにはハンドルを出さない
 * - 範囲選択の矩形とスマートガイド (`overlayState.ts`)
 *
 * 線の太さは `OVERLAY_LINE` で倍率に関係なく一定、ハンドルの大きさは `useScreenUnit()` で画面 px にする。
 */
import { memo, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { OVERLAY_COLORS, OVERLAY_LINE, useScreenUnit } from "../../canvas/overlayKit";
import { HANDLE_SIZE, handlePosition, visibleHandles } from "../../hit/handles";
import { getLocalBounds, getSelectionBounds, nodeOrigin, type Rect } from "../../model/geometry";
import { getNode } from "../../model/tree";
import type { CanvasDocument, NodeId, Point } from "../../model/types";
import { useEditorStore } from "../../state/store";
import { transformableIds } from "./actions";
import { useSelectOverlay } from "./overlayState";

/** 外枠の形 (ページ座標)。 */
type Outline =
  | { kind: "rect"; rect: Rect }
  | { kind: "ellipse"; rect: Rect }
  | { kind: "line"; a: Point; b: Point };

function outlineOf(doc: CanvasDocument, id: NodeId): Outline | null {
  const node = getNode(doc, id);
  if (!node) return null;
  const origin = nodeOrigin(doc, id);
  if (node.type === "line")
    return {
      kind: "line",
      a: { x: origin.x + node.x1, y: origin.y + node.y1 },
      b: { x: origin.x + node.x2, y: origin.y + node.y2 },
    };
  const local = getLocalBounds(doc, id);
  if (!local) return null;
  const rect = { ...local, x: local.x + origin.x, y: local.y + origin.y };
  return { kind: node.type === "ellipse" ? "ellipse" : "rect", rect };
}

const OutlineShape = memo(function OutlineShape({
  outline,
  width,
}: {
  outline: Outline;
  width: number;
}) {
  const stroke = { ...OVERLAY_LINE, stroke: OVERLAY_COLORS.selection, strokeWidth: width };
  switch (outline.kind) {
    case "line":
      return (
        <line x1={outline.a.x} y1={outline.a.y} x2={outline.b.x} y2={outline.b.y} {...stroke} />
      );
    case "ellipse": {
      const { x, y, width: w, height: h } = outline.rect;
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...stroke} />;
    }
    default: {
      const { x, y, width: w, height: h } = outline.rect;
      return <rect x={x} y={y} width={w} height={h} {...stroke} />;
    }
  }
});

function Handle({ at, unit }: { at: Point; unit: number }) {
  const size = HANDLE_SIZE * unit;
  return (
    <rect
      x={at.x - size / 2}
      y={at.y - size / 2}
      width={size}
      height={size}
      {...OVERLAY_LINE}
      fill="#FFFFFF"
      stroke={OVERLAY_COLORS.selection}
      data-canvas-handle=""
    />
  );
}

function HoverOutline() {
  // ホバーの枠は選択ツールのときだけ (§4.5)
  const hoveredId = useEditorStore((state) =>
    state.toolId === "select" &&
    state.hoveredId !== null &&
    !state.selection.includes(state.hoveredId)
      ? state.hoveredId
      : null,
  );
  const doc = useEditorStore((state) => state.doc);
  const outline = useMemo(
    () => (hoveredId === null ? null : outlineOf(doc, hoveredId)),
    [doc, hoveredId],
  );
  if (!outline) return null;
  return (
    <g data-canvas-hover="">
      <OutlineShape outline={outline} width={2} />
    </g>
  );
}

function SelectionFrame() {
  const unit = useScreenUnit();
  const { doc, selection, editingTextId, toolId } = useEditorStore(
    useShallow((state) => ({
      doc: state.doc,
      selection: state.selection,
      editingTextId: state.editingTextId,
      toolId: state.toolId,
    })),
  );

  const view = useMemo(() => {
    const outlines = selection
      .map((id) => outlineOf(doc, id))
      .filter((outline): outline is Outline => outline !== null);
    const movable = transformableIds(doc, selection);
    const editing = editingTextId !== null && movable.includes(editingTextId);
    if (movable.length === 0 || editing)
      return { outlines, box: null, handles: [] as Point[] | null };
    const first = movable[0] as NodeId;
    const only = movable.length === 1 ? getNode(doc, first) : undefined;
    if (only?.type === "line") {
      const origin = nodeOrigin(doc, first);
      return {
        outlines,
        box: null,
        handles: [
          { x: origin.x + only.x1, y: origin.y + only.y1 },
          { x: origin.x + only.x2, y: origin.y + only.y2 },
        ],
      };
    }
    const box = getSelectionBounds(doc, movable);
    return {
      outlines,
      box,
      handles: null,
    };
  }, [doc, selection, editingTextId]);

  if (view.outlines.length === 0) return null;
  const showHandles = toolId === "select";
  // 線の端点か、外接矩形のハンドル (小さいときは辺の中央を省く)
  const box = view.box;
  const handles =
    view.handles ??
    (box ? visibleHandles(box, 1 / unit).map((handle) => handlePosition(box, handle)) : []);
  return (
    <g data-canvas-selection="">
      {view.outlines.map((outline, i) => (
        <OutlineShape key={selection[i] ?? i} outline={outline} width={1} />
      ))}
      {view.box && (
        <rect
          x={view.box.x}
          y={view.box.y}
          width={view.box.width}
          height={view.box.height}
          {...OVERLAY_LINE}
          stroke={OVERLAY_COLORS.selection}
          data-canvas-selection-box=""
        />
      )}
      {showHandles && handles.map((at, i) => <Handle key={i} at={at} unit={unit} />)}
    </g>
  );
}

function DragFeedback() {
  const { marquee, guides } = useSelectOverlay();
  if (!marquee && guides.length === 0) return null;
  return (
    <g data-canvas-drag-feedback="">
      {marquee && (
        <rect
          x={marquee.x}
          y={marquee.y}
          width={marquee.width}
          height={marquee.height}
          {...OVERLAY_LINE}
          fill={OVERLAY_COLORS.selection}
          fillOpacity={0.08}
          stroke={OVERLAY_COLORS.selection}
          data-canvas-marquee=""
        />
      )}
      {guides.map((guide) =>
        guide.axis === "x" ? (
          <line
            key={`x${guide.pos}`}
            x1={guide.pos}
            x2={guide.pos}
            y1={guide.start}
            y2={guide.end}
            {...OVERLAY_LINE}
            stroke={OVERLAY_COLORS.guide}
            data-canvas-smart-guide="x"
          />
        ) : (
          <line
            key={`y${guide.pos}`}
            y1={guide.pos}
            y2={guide.pos}
            x1={guide.start}
            x2={guide.end}
            {...OVERLAY_LINE}
            stroke={OVERLAY_COLORS.guide}
            data-canvas-smart-guide="y"
          />
        ),
      )}
    </g>
  );
}

export function SelectionOverlay() {
  return (
    <>
      <HoverOutline />
      <SelectionFrame />
      <DragFeedback />
    </>
  );
}
