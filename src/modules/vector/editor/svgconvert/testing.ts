/**
 * `svgconvert/` のテストの部品 (配布物には入らない。テストだけが読み込む)。
 */
import { expect } from "vitest";

import { applyToPoint, type Matrix, nodeMatrix } from "../geometry/matrix";
import type { CanvasNode, NodeId, Paint, PathNode, Point, Subpath } from "../model/types";
import { translateSubpaths } from "../path/transform";
import { fixedWidthMeasurer } from "../render/testing";
import { convertSvg, type SvgConvertOptions } from "./convert";
import type { DroppedItem } from "./dropped";

export const measurer = fixedWidthMeasurer();

export function svgOf(inner: string, attrs = 'viewBox="0 0 100 100"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`;
}

export interface Converted {
  nodes: Record<NodeId, CanvasNode>;
  root: CanvasNode;
  /** group を除いたノード (重なり順) */
  leaves: CanvasNode[];
  dropped: DroppedItem[];
}

/** 変換し、成功していることを確かめる。箱は既定で 100 × 100 (viewBox と同じ)。 */
export function convertOk(svg: string, options: Partial<SvgConvertOptions> = {}): Converted {
  const result = convertSvg(svg, {
    width: 100,
    height: 100,
    assetWidth: 100,
    assetHeight: 100,
    measurer,
    ...options,
  });
  if (!result.ok) throw new Error(`変換できない: ${result.reason} ${result.detail ?? ""}`);
  const { nodes, roots } = result.fragment;
  const root = nodes[roots[0] as NodeId] as CanvasNode;
  const leaves: CanvasNode[] = [];
  const walk = (id: NodeId) => {
    const node = nodes[id] as CanvasNode;
    if (node.type === "group") node.children.forEach(walk);
    else leaves.push(node);
  };
  walk(root.id);
  return { nodes, root, leaves, dropped: result.dropped };
}

export function droppedCounts(items: readonly DroppedItem[]): Record<string, number> {
  return Object.fromEntries(items.map((item) => [item.kind, item.count]));
}

/** パスの点を、親の座標系 (箱の位置を足したもの) で。 */
export function absoluteSubpaths(path: PathNode): Subpath[] {
  return translateSubpaths(path.subpaths, path.x, path.y);
}

export function expectPointClose(actual: Point, expected: Point, eps = 1e-9): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(eps);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(eps);
}

/** 点の形 (点とハンドル) が同じか。 */
export function expectSubpathsClose(actual: Subpath[], expected: Subpath[], eps = 1e-9): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((sub, i) => {
    const want = expected[i] as Subpath;
    expect(sub.closed).toBe(want.closed);
    expect(sub.points.length).toBe(want.points.length);
    sub.points.forEach((p, j) => {
      const q = want.points[j] as Subpath["points"][number];
      expectPointClose(p, q, eps);
      for (const key of ["in", "out"] as const) {
        const h = p[key];
        const g = q[key];
        if (h === null || g === null) {
          // 長さ 0 のハンドルと null は同じ形
          const v = h ?? g;
          if (v) expectPointClose(v, { x: 0, y: 0 }, eps);
        } else expectPointClose(h, g, eps);
      }
    });
  });
}

/** 箱を持つノードの 4 隅 (親の座標系)。 */
export function boxCorners(node: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}): Point[] {
  const m = nodeMatrix(node.x, node.y, node.width, node.height, node.rotation);
  return [
    { x: 0, y: 0 },
    { x: node.width, y: 0 },
    { x: node.width, y: node.height },
    { x: 0, y: node.height },
  ].map((p) => applyToPoint(m, p));
}

/** 矩形 (x, y, w, h) の 4 隅を行列で写したもの。 */
export function mappedRectCorners(m: Matrix, x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ].map((p) => applyToPoint(m, p));
}

/** 点の集まりが (順を問わず) 同じか。 */
export function expectSamePointSet(actual: Point[], expected: Point[], eps = 1e-9): void {
  const key = (p: Point) => [Math.round(p.x / eps / 1000), Math.round(p.y / eps / 1000)];
  const sort = (ps: Point[]) =>
    [...ps].sort((a, b) => key(a)[0]! - key(b)[0]! || key(a)[1]! - key(b)[1]!);
  const a = sort(actual);
  const b = sort(expected);
  expect(a.length).toBe(b.length);
  a.forEach((p, i) => expectPointClose(p, b[i] as Point, eps));
}

/**
 * §3 のグラデーションの、親の座標系の点 p での色の位置 t (線形は射影、放射は中心からの距離 / 半径)。
 * 描画と同じく、箱 (回転の前) を 0〜1 に正規化した座標で求める。
 */
export function paintPosition(
  paint: Paint,
  box: { x: number; y: number; width: number; height: number; rotation: number },
  p: Point,
): number {
  const m = nodeMatrix(box.x, box.y, box.width, box.height, box.rotation);
  // 親 → ノード → 正規化
  const det = m.a * m.d - m.b * m.c;
  const dx = p.x - m.e;
  const dy = p.y - m.f;
  const local = { x: (m.d * dx - m.c * dy) / det, y: (-m.b * dx + m.a * dy) / det };
  const u = { x: local.x / box.width, y: local.y / box.height };
  if (paint.type === "linear") {
    const d = { x: paint.to.x - paint.from.x, y: paint.to.y - paint.from.y };
    return ((u.x - paint.from.x) * d.x + (u.y - paint.from.y) * d.y) / (d.x * d.x + d.y * d.y);
  }
  if (paint.type === "radial")
    return Math.hypot(u.x - paint.center.x, u.y - paint.center.y) / paint.radius;
  return 0;
}
