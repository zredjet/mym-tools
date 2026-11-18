/**
 * 点の編集とペンの重ね描き (§8.7)。重ね描き用 SVG のページ座標の `<g>` に置く (ツールの `Overlay`)。
 *
 * - 編集中 (または描いている) パスの輪郭、すべての点、選んだ点とその前後のハンドル
 * - ホバーしている点・ハンドル・線分の強調
 * - ペン: 最初の点だけの状態の点とハンドル、最後の点からポインターまでの予定の線
 *
 * 線の太さは `OVERLAY_LINE` で倍率に関係なく一定、点とハンドルの大きさは `useScreenUnit()` で画面 px にする。
 */
import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { OVERLAY_COLORS, OVERLAY_LINE, useScreenUnit } from "../../canvas/overlayKit";
import { applyToVector } from "../../geometry/matrix";
import type { Point } from "../../model/types";
import {
  selectedPoints,
  usePathEditSnapshot,
  type PathEditHover,
  type PointRef,
} from "../../path/editSession";
import { subpathsToPathData } from "../../path/pathData";
import { subpathToSegments } from "../../path/segments";
import { transformSubpaths } from "../../path/transform";
import { useEditorStore } from "../../state/store";
import { transformSegment } from "../../geometry/bezier";
import { pageGeometry, pagePointOf, visibleHandles } from "./ops";
import { drawingOut, endIndex, resolvePen } from "./pen";

/** 点の半径 (画面 px)。 */
const POINT_RADIUS = 3.5;
/** ハンドルの先の半径 (画面 px)。 */
const HANDLE_RADIUS = 2.5;

const fmt = (v: number) => (Math.round(v * 1e4) / 1e4).toString();

function segmentPathData(seg: ReturnType<typeof transformSegment>): string {
  if (seg.kind === "line")
    return `M${fmt(seg.from.x)} ${fmt(seg.from.y)}L${fmt(seg.to.x)} ${fmt(seg.to.y)}`;
  return (
    `M${fmt(seg.from.x)} ${fmt(seg.from.y)}` +
    `C${fmt(seg.c1.x)} ${fmt(seg.c1.y)} ${fmt(seg.c2.x)} ${fmt(seg.c2.y)} ${fmt(seg.to.x)} ${fmt(seg.to.y)}`
  );
}

function sameRef(a: PointRef, b: PointRef): boolean {
  return a.subpath === b.subpath && a.index === b.index;
}

function hoveredPoint(hover: PathEditHover, ref: PointRef): boolean {
  return hover?.kind === "point" && sameRef(hover.ref, ref);
}

function PointMarker({
  at,
  unit,
  selected,
  hovered,
}: {
  at: Point;
  unit: number;
  selected: boolean;
  hovered: boolean;
}) {
  return (
    <circle
      cx={at.x}
      cy={at.y}
      r={(hovered ? POINT_RADIUS + 1 : POINT_RADIUS) * unit}
      {...OVERLAY_LINE}
      fill={selected ? OVERLAY_COLORS.selection : "#FFFFFF"}
      stroke={OVERLAY_COLORS.selection}
      data-path-edit-point={selected ? "selected" : ""}
    />
  );
}

function HandleMarker({
  from,
  tip,
  unit,
  hovered,
}: {
  from: Point;
  tip: Point;
  unit: number;
  hovered: boolean;
}) {
  return (
    <g data-path-edit-handle="">
      <line
        x1={from.x}
        y1={from.y}
        x2={tip.x}
        y2={tip.y}
        {...OVERLAY_LINE}
        stroke={OVERLAY_COLORS.selection}
      />
      <circle
        cx={tip.x}
        cy={tip.y}
        r={(hovered ? HANDLE_RADIUS + 1 : HANDLE_RADIUS) * unit}
        {...OVERLAY_LINE}
        fill="#FFFFFF"
        stroke={OVERLAY_COLORS.selection}
      />
    </g>
  );
}

export function PathEditOverlay() {
  const unit = useScreenUnit();
  const { doc, editingPathId } = useEditorStore(
    useShallow((state) => ({ doc: state.doc, editingPathId: state.editingPathId })),
  );
  const session = usePathEditSnapshot();
  const pen = session.pen;
  const target = useMemo(() => (pen ? resolvePen(doc, pen) : null), [doc, pen]);
  const pathId = editingPathId ?? (target?.kind === "drawing" ? target.node.id : null);
  const geometry = useMemo(
    () => (pathId === null ? null : pageGeometry(doc, pathId)),
    [doc, pathId],
  );
  const selected = selectedPoints(doc, editingPathId, session);

  const view = useMemo(() => {
    if (!geometry) return null;
    const { node, space } = geometry;
    const outline = subpathsToPathData(transformSubpaths(node.subpaths, space.localToPage));
    // ペンで描いている輪郭の端の点のハンドルも出す
    const refs: PointRef[] = [...selected];
    if (target?.kind === "drawing" && target.node.id === node.id) {
      const sub = node.subpaths[target.subpath];
      if (sub) refs.push({ subpath: target.subpath, index: endIndex(sub, target.end) });
    }
    const handles = visibleHandles(node.subpaths, refs).flatMap((handle) => {
      const p = pagePointOf(geometry, handle.ref);
      const tip = handle.side === "in" ? p?.inTip : p?.outTip;
      return p && tip ? [{ ...handle, from: p.at, tip }] : [];
    });
    return { outline, handles };
  }, [geometry, selected, target]);

  const hoveredSegment = useMemo(() => {
    const hover = session.hover;
    if (!geometry || hover?.kind !== "segment") return null;
    const sub = geometry.node.subpaths[hover.subpath];
    const seg = sub ? subpathToSegments(sub)[hover.segment] : undefined;
    return seg ? segmentPathData(transformSegment(seg, geometry.space.localToPage)) : null;
  }, [geometry, session.hover]);

  // ペンの予定の線 (最後の点からポインターまで) と最初の点
  const preview = useMemo(() => {
    if (!pen || !target) return null;
    const pointer = pen.pointer;
    if (target.kind === "pending") {
      const origin = target.origin;
      const out = origin.out;
      return {
        origin,
        originHandles: out
          ? [
              { x: origin.x + out.x, y: origin.y + out.y },
              { x: origin.x - out.x, y: origin.y - out.y },
            ]
          : [],
        line: pointer
          ? out
            ? `M${fmt(origin.x)} ${fmt(origin.y)}C${fmt(origin.x + out.x)} ${fmt(origin.y + out.y)} ${fmt(pointer.x)} ${fmt(pointer.y)} ${fmt(pointer.x)} ${fmt(pointer.y)}`
            : `M${fmt(origin.x)} ${fmt(origin.y)}L${fmt(pointer.x)} ${fmt(pointer.y)}`
          : null,
      };
    }
    if (!geometry || !pointer) return null;
    const sub = target.node.subpaths[target.subpath];
    if (!sub) return null;
    const index = endIndex(sub, target.end);
    const page = pagePointOf(geometry, { subpath: target.subpath, index });
    const point = sub.points[index];
    if (!page || !point) return null;
    const outLocal = drawingOut(point, target.end);
    const out = outLocal ? applyToVector(geometry.space.localToPage, outLocal) : null;
    const from = page.at;
    return {
      origin: null,
      originHandles: [],
      line: out
        ? `M${fmt(from.x)} ${fmt(from.y)}C${fmt(from.x + out.x)} ${fmt(from.y + out.y)} ${fmt(pointer.x)} ${fmt(pointer.y)} ${fmt(pointer.x)} ${fmt(pointer.y)}`
        : `M${fmt(from.x)} ${fmt(from.y)}L${fmt(pointer.x)} ${fmt(pointer.y)}`,
    };
  }, [pen, target, geometry]);

  if (!geometry && !preview) return null;
  const hover = session.hover;
  return (
    <g data-path-edit-overlay="">
      {view && view.outline !== "" && (
        <path d={view.outline} {...OVERLAY_LINE} stroke={OVERLAY_COLORS.selection} />
      )}
      {hoveredSegment && (
        <path
          d={hoveredSegment}
          {...OVERLAY_LINE}
          strokeWidth={2}
          stroke={OVERLAY_COLORS.selection}
          data-path-edit-hover-segment=""
        />
      )}
      {preview?.line && (
        <path
          d={preview.line}
          {...OVERLAY_LINE}
          stroke={OVERLAY_COLORS.selection}
          data-pen-preview=""
        />
      )}
      {view?.handles.map((handle) => (
        <HandleMarker
          key={`${handle.ref.subpath}:${handle.ref.index}:${handle.side}`}
          from={handle.from}
          tip={handle.tip}
          unit={unit}
          hovered={
            hover?.kind === "handle" && sameRef(hover.ref, handle.ref) && hover.side === handle.side
          }
        />
      ))}
      {geometry?.points.flatMap((sub) =>
        sub.map((p) => (
          <PointMarker
            key={`${p.ref.subpath}:${p.ref.index}`}
            at={p.at}
            unit={unit}
            selected={selected.some((ref) => sameRef(ref, p.ref))}
            hovered={hoveredPoint(hover, p.ref)}
          />
        )),
      )}
      {preview?.originHandles.map((tip, i) => (
        <HandleMarker key={`o${i}`} from={preview.origin!} tip={tip} unit={unit} hovered={false} />
      ))}
      {preview?.origin && (
        <PointMarker at={preview.origin} unit={unit} selected={false} hovered={false} />
      )}
    </g>
  );
}
