/** 書き出しのテスト用の文書 (アプリの画面からは使わない)。 */
import { createEllipse, createFrame, createGroup, createRect, createStroke } from "../model/create";
import type { CanvasDocument, CanvasNode } from "../model/types";

/**
 * ```
 * page p1
 * ├─ fa  frame "表紙" (100, 50) 200×100
 * │  ├─ ra  rect (10, 10) 20×20
 * │  └─ fn  frame "中" (50, 20) 40×30
 * │     └─ rn rect (0, 0) 10×10
 * ├─ fb  frame "表紙" (400, 50) 100×100
 * ├─ g   group
 * │  ├─ e1 ellipse (0, 300) 50×40 線 4
 * │  └─ r2 rect (60, 300) 30×30
 * ├─ hid rect (900, 900) 10×10 非表示
 * └─ r0  rect (-10.5, -20.25) 10×10
 * ```
 */
export function exportDocument(): CanvasDocument {
  const nodes: CanvasNode[] = [
    createFrame({
      id: "fa",
      name: "表紙",
      x: 100,
      y: 50,
      width: 200,
      height: 100,
      children: ["ra", "fn"],
    }),
    createRect({ id: "ra", x: 10, y: 10, width: 20, height: 20 }),
    createFrame({ id: "fn", name: "中", x: 50, y: 20, width: 40, height: 30, children: ["rn"] }),
    createRect({ id: "rn", x: 0, y: 0, width: 10, height: 10 }),
    createFrame({ id: "fb", name: "表紙", x: 400, y: 50, width: 100, height: 100 }),
    createGroup(["e1", "r2"], { id: "g" }),
    createEllipse({
      id: "e1",
      x: 0,
      y: 300,
      width: 50,
      height: 40,
      stroke: createStroke("#000000", 4),
    }),
    createRect({ id: "r2", x: 60, y: 300, width: 30, height: 30 }),
    createRect({ id: "hid", x: 900, y: 900, width: 10, height: 10, visible: false }),
    createRect({ id: "r0", x: -10.5, y: -20.25, width: 10, height: 10 }),
  ];
  return {
    pages: [{ id: "p1", name: "ページ 1", children: ["fa", "fb", "g", "hid", "r0"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}
