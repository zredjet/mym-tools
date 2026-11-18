/**
 * 点の節 (§5.3)。点の編集中に、選んだ点の X / Y と連動の種類 (`mirror`) を出す。
 *
 * - X / Y は親の座標系 (パスの回転と箱の位置を掛けた位置)。複数の点なら、そろっていればその値、違えば「混在」。
 *   入力すると選んだ点をすべてその位置へ置く (履歴 1 件)。小数第 2 位まで
 * - 連動の種類を変えると、反対のハンドルをそろえる (`setMirror`)
 * - 確定するのは、入力を始めた時点の点 (パスの形がそのときから変わっていたら当てない)
 * - §3.5 の範囲を超える結果は当てない
 */
import { useShallow } from "zustand/shallow";
import { CANVAS_LIMITS } from "../../model/limits";
import { getNode } from "../../model/tree";
import type { HandleMirror, NodeId, PathNode, Subpath } from "../../model/types";
import {
  selectedPoints,
  syncSelectedPoints,
  usePathEditSnapshot,
  type PointRef,
} from "../../path/editSession";
import { editorStore, useEditorStore } from "../../state/store";
import {
  localToParent,
  pathSpace,
  placePoints,
  round2,
  setMirror,
  withSubpaths,
} from "../../tools/pathEdit/ops";
import { NumberField } from "../fields/NumberField";
import { FieldGrid, Section } from "../fields/Section";
import { commonValue, MIXED } from "../fields/values";

const COORD = { min: -CANVAS_LIMITS.maxCoordinate, max: CANVAS_LIMITS.maxCoordinate };

const MIRROR_OPTIONS: readonly { value: HandleMirror; label: string }[] = [
  { value: "none", label: "連動なし" },
  { value: "angle", label: "角度をそろえる" },
  { value: "angle-length", label: "角度と長さをそろえる" },
];

/**
 * 入力を始めた時点の点に変更を当てる。パスの形がそのときから変わっていたら (Undo など) 当てない。
 * 当てたら同じ点を選んだまま覚え直す。
 */
function commitPoints(
  id: NodeId,
  subpaths: readonly Subpath[],
  refs: readonly PointRef[],
  change: (node: PathNode) => readonly Subpath[] | null,
): void {
  const state = editorStore.getState();
  const node = getNode(state.doc, id);
  if (node?.type !== "path" || node.subpaths !== subpaths) return;
  const next = change(node);
  if (!next) return;
  const doc = withSubpaths(state.doc, id, next);
  if (!doc || doc === state.doc) return;
  state.apply(() => doc);
  syncSelectedPoints(editorStore.getState().doc, id, refs);
}

export function PathPointSection() {
  const { doc, editingPathId } = useEditorStore(
    useShallow((s) => ({ doc: s.doc, editingPathId: s.editingPathId })),
  );
  const session = usePathEditSnapshot();
  const refs = selectedPoints(doc, editingPathId, session);
  if (editingPathId === null || refs.length === 0) return null;
  const node = getNode(doc, editingPathId);
  if (node?.type !== "path") return null;
  const space = pathSpace(doc, node);
  if (!space) return null;
  const id = node.id;
  const subpaths = node.subpaths;
  const points = refs.flatMap((ref) => {
    const point = subpaths[ref.subpath]?.points[ref.index];
    return point ? [point] : [];
  });
  const positions = points.map((point) => localToParent(space, point));
  const x = commonValue(positions.map((p) => round2(p.x)));
  const y = commonValue(positions.map((p) => round2(p.y)));
  const mirror = commonValue(points.map((p) => p.mirror));

  const place = (axis: "x" | "y", value: number) =>
    commitPoints(id, subpaths, refs, (current) => {
      const currentSpace = pathSpace(editorStore.getState().doc, current);
      return currentSpace ? placePoints(current.subpaths, refs, currentSpace, axis, value) : null;
    });

  return (
    <Section title={refs.length === 1 ? "点" : `点 (${refs.length} 個)`}>
      <FieldGrid>
        <NumberField
          label="X"
          ariaLabel="点の X 座標"
          value={x}
          precision={2}
          {...COORD}
          targets={[id]}
          onCommit={(value) => place("x", value)}
        />
        <NumberField
          label="Y"
          ariaLabel="点の Y 座標"
          value={y}
          precision={2}
          {...COORD}
          targets={[id]}
          onCommit={(value) => place("y", value)}
        />
      </FieldGrid>
      <select
        aria-label="ハンドルの連動"
        className="h-7 w-full rounded-[var(--radius-sm)] border border-transparent bg-[var(--bg-muted)] px-1.5 text-[12px] text-[var(--fg)] outline-none hover:border-[var(--border)] focus:border-[var(--accent)]"
        value={mirror === MIXED ? "" : mirror}
        onChange={(event) => {
          const value = event.target.value as HandleMirror;
          if (!MIRROR_OPTIONS.some((option) => option.value === value)) return;
          commitPoints(id, subpaths, refs, (current) => setMirror(current.subpaths, refs, value));
        }}
      >
        {mirror === MIXED && (
          <option value="" disabled>
            混在
          </option>
        )}
        {MIRROR_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Section>
  );
}
