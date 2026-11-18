/**
 * 選択の重ね描き (§4.3 / §4.5)。現在のツールに関係なくキャンバスが重ね描き用 SVG の
 * ページ座標の `<g>` に置く。描くもの:
 *
 * - ホバーの枠 (選択していないノード。選択ツールのときだけ)
 * - 選択したノードの枠と、動かせる選択の枠・リサイズハンドル (選択ツールのとき)。
 *   線を 1 本だけ選んだときのハンドルは始点と終点の 2 個。本文の編集中のノードにはハンドルを出さない
 * - 範囲選択の矩形とスマートガイド (`overlayState.ts`)
 *
 * 回転 (§8.5.3): 1 個だけ選んだ、ページ上の角度が 0 でない箱を持つノードは、回転した箱に沿った枠とハンドル
 * (`selectionBox.ts`)。複数選択・group・ブーリアン・線は軸に平行な外接矩形。ノードの枠 (ホバーと選択) は
 * ページ上の見た目どおり (回転した箱、パスとブーリアンは形の輪郭、回転した frame の中も)。
 * 回転のドラッグの角度は、画面座標の層に `SelectionScreenLabels` が描く (`OverlayLayer` が置く)。
 *
 * 線の太さは `OVERLAY_LINE` で倍率に関係なく一定、ハンドルの大きさは `useScreenUnit()` で画面 px にする。
 */
import { memo, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { getBooleanResult } from "../../boolean/result";
import { OVERLAY_COLORS, OVERLAY_LINE, useScreenUnit } from "../../canvas/overlayKit";
import { pageToScreen } from "../../canvas/viewport";
import type { Matrix } from "../../geometry/matrix";
import {
  boxHandlePosition,
  boxVisibleHandles,
  HANDLE_SIZE,
  handlePosition,
  visibleHandles,
} from "../../hit/handles";
import {
  coordinateMatrix,
  getLocalBounds,
  getPageBounds,
  isTranslation,
  nodeOrigin,
  nodePageMatrix,
  type Rect,
} from "../../model/geometry";
import { getNode } from "../../model/tree";
import type { CanvasDocument, NodeId, Point } from "../../model/types";
import { subpathsToPathData } from "../../path/pathData";
import { useEditorStore } from "../../state/store";
import type { Viewport } from "../../state/types";
import { transformableIds } from "./actions";
import { formatAngle, useSelectOverlay } from "./overlayState";
import { lineEndsOnPage, selectionBoxOf } from "./selectionBox";

/**
 * 外枠の形。`matrix` があれば、形はその座標系の値で、ページ ← その座標系 の行列を掛けて描く
 * (回転したノードと、回転した frame の中のノード)。なければページ座標。
 */
type Outline =
  | { kind: "rect"; rect: Rect; matrix?: Matrix }
  | { kind: "ellipse"; rect: Rect; matrix?: Matrix }
  | { kind: "path"; d: string; matrix?: Matrix }
  | { kind: "line"; a: Point; b: Point };

function outlineOf(doc: CanvasDocument, id: NodeId): Outline | null {
  const node = getNode(doc, id);
  if (!node) return null;
  if (node.type === "line") {
    const ends = lineEndsOnPage(doc, id);
    return ends ? { kind: "line", a: ends[0], b: ends[1] } : null;
  }
  const space = coordinateMatrix(doc, id);
  // パスとブーリアンは形の輪郭 (ブーリアンの結果がなければ子の外接矩形)
  if (node.type === "path") {
    const d = subpathsToPathData(node.subpaths);
    return d === "" ? null : { kind: "path", d, matrix: nodePageMatrix(doc, id) };
  }
  if (node.type === "boolean") {
    const result = getBooleanResult(doc, id);
    const d = result ? subpathsToPathData(result.subpaths) : "";
    if (d !== "") return { kind: "path", d, matrix: space };
    const rect = getPageBounds(doc, id);
    return rect ? { kind: "rect", rect } : null;
  }
  if (node.type === "group") {
    const rect = getPageBounds(doc, id);
    return rect ? { kind: "rect", rect } : null;
  }
  const kind = node.type === "ellipse" ? "ellipse" : "rect";
  if (node.rotation !== 0 || !isTranslation(space))
    // 回転した箱 (ノードの座標系の箱にページへの行列を掛ける)
    return {
      kind,
      rect: { x: 0, y: 0, width: node.width, height: node.height },
      matrix: nodePageMatrix(doc, id),
    };
  // 回転していない (第 1 段階と同じ値)
  const origin = nodeOrigin(doc, id);
  const local = getLocalBounds(doc, id);
  if (!local) return null;
  return { kind, rect: { ...local, x: local.x + origin.x, y: local.y + origin.y } };
}

/** SVG の `transform` の値。平行移動だけでも `matrix(...)` で書く (値をそのまま渡す)。 */
function matrixAttr(m: Matrix | undefined): string | undefined {
  return m ? `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})` : undefined;
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
    case "path":
      return <path d={outline.d} transform={matrixAttr(outline.matrix)} {...stroke} />;
    case "ellipse": {
      const { x, y, width: w, height: h } = outline.rect;
      return (
        <ellipse
          cx={x + w / 2}
          cy={y + h / 2}
          rx={w / 2}
          ry={h / 2}
          transform={matrixAttr(outline.matrix)}
          {...stroke}
        />
      );
    }
    default: {
      const { x, y, width: w, height: h } = outline.rect;
      return (
        <rect x={x} y={y} width={w} height={h} transform={matrixAttr(outline.matrix)} {...stroke} />
      );
    }
  }
});

function Handle({ at, unit, rotation = 0 }: { at: Point; unit: number; rotation?: number }) {
  const size = HANDLE_SIZE * unit;
  return (
    <rect
      x={at.x - size / 2}
      y={at.y - size / 2}
      width={size}
      height={size}
      // 回転した枠では、ハンドルの四角も枠の向きに回す
      transform={rotation === 0 ? undefined : `rotate(${rotation} ${at.x} ${at.y})`}
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
      const ends = lineEndsOnPage(doc, first);
      return { outlines, box: null, handles: ends ? [ends[0], ends[1]] : [] };
    }
    return { outlines, box: selectionBoxOf(doc, movable), handles: null };
  }, [doc, selection, editingTextId]);

  if (view.outlines.length === 0) return null;
  const showHandles = toolId === "select";
  // 線の端点か、枠のハンドル (小さいときは辺の中央を省く)
  const selectionBox = view.box;
  let handles: Point[] = view.handles ?? [];
  let rotation = 0;
  if (!view.handles && selectionBox) {
    if (selectionBox.kind === "rect") {
      const rect = selectionBox.rect;
      handles = visibleHandles(rect, 1 / unit).map((handle) => handlePosition(rect, handle));
    } else {
      const box = selectionBox.box;
      // ノードのページ上の角度 (行列から求めると小数の誤差が出る)
      rotation = selectionBox.rotation;
      handles = boxVisibleHandles(box, 1 / unit).map((handle) => boxHandlePosition(box, handle));
    }
  }
  return (
    <g data-canvas-selection="">
      {view.outlines.map((outline, i) => (
        <OutlineShape key={selection[i] ?? i} outline={outline} width={1} />
      ))}
      {selectionBox?.kind === "rect" && (
        <rect
          x={selectionBox.rect.x}
          y={selectionBox.rect.y}
          width={selectionBox.rect.width}
          height={selectionBox.rect.height}
          {...OVERLAY_LINE}
          stroke={OVERLAY_COLORS.selection}
          data-canvas-selection-box=""
        />
      )}
      {selectionBox?.kind === "oriented" && (
        <rect
          x={0}
          y={0}
          width={selectionBox.box.width}
          height={selectionBox.box.height}
          transform={matrixAttr(selectionBox.box.matrix)}
          {...OVERLAY_LINE}
          stroke={OVERLAY_COLORS.selection}
          data-canvas-selection-box="rotated"
        />
      )}
      {showHandles &&
        handles.map((at, i) => <Handle key={i} at={at} unit={unit} rotation={rotation} />)}
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

/** 角度のラベルの、ポインターからのずれ (画面 px)。 */
const ANGLE_LABEL_OFFSET = { x: 14, y: 18 };
const ANGLE_LABEL_HEIGHT = 18;

/**
 * 画面座標の重ね描き (`OverlayLayer` が、ページ座標の `<g>` の外に置く)。回転のドラッグの角度を、ポインターの
 * 右下に数値で出す (§8.5.3)。文字を倍率で拡大・縮小しないよう画面座標で描く。
 */
export function SelectionScreenLabels({ viewport }: { viewport: Viewport }) {
  const { angle } = useSelectOverlay();
  if (!angle) return null;
  const at = pageToScreen(viewport, angle.at);
  const text = formatAngle(angle.value);
  // 数字は等幅 (tabular-nums) で 1 文字 7 px 前後。左右に 6 px の余白
  const width = text.length * 7 + 12;
  const x = at.x + ANGLE_LABEL_OFFSET.x;
  const y = at.y + ANGLE_LABEL_OFFSET.y;
  return (
    <g data-canvas-rotation-label="">
      <rect
        x={x}
        y={y}
        width={width}
        height={ANGLE_LABEL_HEIGHT}
        rx={4}
        fill={OVERLAY_COLORS.selection}
      />
      <text
        x={x + width / 2}
        y={y + 13}
        textAnchor="middle"
        fill="#FFFFFF"
        style={{
          fontFamily: "system-ui",
          fontSize: 11,
          fontWeight: 500,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {text}
      </text>
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
