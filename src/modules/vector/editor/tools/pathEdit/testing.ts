/**
 * 点の編集とペンのテストに使う文書。座標はページ座標で:
 *
 * - `sq`: (100, 100) から 100 × 100 の閉じた正方形。塗りあり、線なし。点 0 = 左上、時計回り
 * - `rot`: (300, 100) の正方形を 90° 回したもの。ノードの座標系の (0, 0) はページの (400, 100)、
 *   (100, 0) は (400, 200)、(100, 100) は (300, 200)、(0, 100) は (300, 100)
 * - `open`: (500, 100) から (600, 100)、(600, 200) への開いた線 (線あり、塗りなし)
 * - `f`: (0, 400) の 300 × 300 の frame を 90° 回したもの。frame の座標系の (x, y) はページの
 *   (300 − y, 400 + x)。子の `inner` は frame の (50, 50) から 100 × 100 の正方形
 *   (ノードの座標系の (0, 0) はページの (250, 450))
 * - `r`: (700, 400) の矩形 (パスの外のノード)
 */
import {
  createEmptyDocument,
  createFrame,
  createPath,
  createRect,
  solidPaint,
} from "../../model/create";
import { insertNode } from "../../model/structure";
import type { CanvasDocument, PathPoint, Subpath } from "../../model/types";

export const PAGE_ID = createEmptyDocument().pages[0]!.id;

export function corner(x: number, y: number): PathPoint {
  return { x, y, in: null, out: null, mirror: "none" };
}

export function square(size = 100): Subpath {
  return {
    closed: true,
    points: [corner(0, 0), corner(size, 0), corner(size, size), corner(0, size)],
  };
}

export function pathEditDocument(): CanvasDocument {
  let doc = createEmptyDocument();
  const page = { kind: "page", id: PAGE_ID } as const;
  doc = insertNode(
    doc,
    createPath([square()], { id: "sq", x: 100, y: 100, fill: solidPaint("#888888"), stroke: null }),
    page,
  );
  doc = insertNode(
    doc,
    createPath([square()], {
      id: "rot",
      x: 300,
      y: 100,
      rotation: 90,
      fill: solidPaint("#888888"),
      stroke: null,
    }),
    page,
  );
  doc = insertNode(
    doc,
    createPath([{ closed: false, points: [corner(0, 0), corner(100, 0), corner(100, 100)] }], {
      id: "open",
      x: 500,
      y: 100,
    }),
    page,
  );
  doc = insertNode(
    doc,
    createFrame({ id: "f", x: 0, y: 400, width: 300, height: 300, rotation: 90 }),
    page,
  );
  doc = insertNode(
    doc,
    createPath([square()], { id: "inner", x: 50, y: 50, fill: solidPaint("#888888") }),
    { kind: "node", id: "f" },
  );
  doc = insertNode(doc, createRect({ id: "r", x: 700, y: 400, width: 50, height: 50 }), page);
  return doc;
}
