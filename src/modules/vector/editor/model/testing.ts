/**
 * テスト用の文書と補助 (アプリの画面からは使わない)。
 * 後続のセッションのテストでも使えるように、契約データの読み込みもここに置く。
 */
import fixtures from "./fixtures/payload-v2.json";
import { createFrame, createGroup, createLine, createRect } from "./create";
import { fromPayload } from "./payload";
import type { CanvasDocument, CanvasNode, VectorPayloadV2 } from "./types";

/** 契約データ `valid` の payload を名前で引く (`"empty"` / `"full"`)。 */
export function fixturePayload(name: string): VectorPayloadV2 {
  const entry = fixtures.valid.find((item) => item.name === name);
  if (!entry) throw new Error(`fixture not found: ${name}`);
  return structuredClone(entry.payload) as unknown as VectorPayloadV2;
}

/** 契約データ `valid` の文書を名前で引く。 */
export function fixtureDocument(name: string): CanvasDocument {
  return fromPayload(fixturePayload(name));
}

/** 書き換えると例外になるように、オブジェクトを深く凍結する。 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * 座標の検査に使う小さな文書。
 *
 * ```
 * page p1
 * ├─ f   frame (100, 50) 400×300
 * │  ├─ r1  rect (10, 10) 20×20
 * │  ├─ grp group
 * │  │  ├─ r2 rect (50, 60) 10×10
 * │  │  └─ l1 line (40, 40)–(80, 40)
 * │  └─ f2  frame (200, 100) 100×100
 * │     └─ r3 rect (5, 5) 10×10
 * └─ r0  rect (0, 0) 10×10
 * ```
 */
export function sampleDocument(): CanvasDocument {
  const nodes: CanvasNode[] = [
    createFrame({ id: "f", x: 100, y: 50, width: 400, height: 300, children: ["r1", "grp", "f2"] }),
    createRect({ id: "r1", x: 10, y: 10, width: 20, height: 20, radius: 4 }),
    createGroup(["r2", "l1"], { id: "grp" }),
    createRect({ id: "r2", x: 50, y: 60, width: 10, height: 10 }),
    createLine({ id: "l1", x1: 40, y1: 40, x2: 80, y2: 40 }),
    createFrame({ id: "f2", x: 200, y: 100, width: 100, height: 100, children: ["r3"] }),
    createRect({ id: "r3", x: 5, y: 5, width: 10, height: 10 }),
    createRect({ id: "r0", x: 0, y: 0, width: 10, height: 10 }),
  ];
  return {
    pages: [{ id: "p1", name: "ページ 1", children: ["f", "r0"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}
