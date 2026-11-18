import { describe, expect, it } from "vitest";
import {
  createBoolean,
  createFrame,
  createPath,
  createRect,
  createStroke,
  solidPaint,
} from "../model/create";
import type { CanvasDocument, CanvasNode, Subpath } from "../model/types";
import { canEnter, hitTestPath, pickTarget } from "./hitTest";
import { dropFrames, dropTargetAt } from "./marquee";
import { roundedRectDistance } from "./shapes";

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

const hit = (doc: CanvasDocument, x: number, y: number, scope: string | null = null) =>
  hitTestPath(doc, "p1", { x, y }, 1, scope);

const triangle: Subpath[] = [
  {
    closed: true,
    points: [
      { x: 0, y: 0, in: null, out: null, mirror: "none" },
      { x: 100, y: 0, in: null, out: null, mirror: "none" },
      { x: 0, y: 100, in: null, out: null, mirror: "none" },
    ],
  },
];

describe("回転したノードの当たり (§8.5.8)", () => {
  it("1000×10 を 90° 回した矩形は、回した形の中で当たる", () => {
    const doc = docOf(
      [createRect({ id: "r", x: 0, y: 0, width: 1000, height: 10, rotation: 90, stroke: null })],
      ["r"],
    );
    expect(hit(doc, 500, 300)).toEqual(["r"]);
    expect(hit(doc, 100, 5)).toBeNull();
  });

  it("回転した frame の子は frame の座標系で当たる", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          rotation: 90,
          children: ["c"],
          stroke: null,
        }),
        createRect({ id: "c", x: 10, y: 10, width: 20, height: 20, stroke: null }),
      ],
      ["f"],
    );
    // c はページの x 220..240、y 60..80 (90° 回した frame の中)
    expect(hit(doc, 230, 70)).toEqual(["f", "c"]);
    // frame の箱 (回した後) の中の何もない場所
    expect(hit(doc, 200, 200)).toEqual(["f"]);
    // 回す前の frame の箱 (100..300, 100..200) だが、回した後の箱の外
    expect(hit(doc, 290, 110)).toBeNull();
  });

  it("角丸は描画と同じ角 (短い辺の半分を超えると楕円の角)", () => {
    const rect = { x: 0, y: 0, width: 100, height: 20 };
    // 描画: rx = min(30, 50) = 30、ry = min(30, 10) = 10 の楕円の角
    // 半径 10 の円の角 (これまでの判定) なら内側だが、描画の楕円の角の外
    expect(roundedRectDistance({ x: 5, y: 4 }, rect, 30)).toBeGreaterThan(0);
    expect(roundedRectDistance({ x: 2, y: 10 }, rect, 30)).toBeCloseTo(-2, 6);
    expect(roundedRectDistance({ x: 20, y: 10 }, rect, 30)).toBeLessThan(0);
    expect(roundedRectDistance({ x: 50, y: 10 }, rect, 30)).toBeCloseTo(-10, 6);
    // 等しい辺なら円の角の式のまま
    expect(roundedRectDistance({ x: 50, y: 25 }, { x: 0, y: 0, width: 100, height: 50 }, 10)).toBe(
      -25,
    );
  });
});

describe("パスの当たり", () => {
  it("塗りは内側、線は太さの半分 + 余裕、どちらもなければ輪郭の近く", () => {
    const doc = docOf(
      [
        createPath(triangle, { id: "fill", x: 0, y: 0, fill: solidPaint("#000000"), stroke: null }),
        createPath(triangle, {
          id: "line",
          x: 200,
          y: 0,
          fill: null,
          stroke: createStroke("#000000", 2),
        }),
        createPath(triangle, { id: "none", x: 400, y: 0, fill: null, stroke: null }),
      ],
      ["fill", "line", "none"],
    );
    expect(hit(doc, 20, 20)).toEqual(["fill"]);
    expect(hit(doc, 80, 80)).toBeNull();
    // 線だけのパスは輪郭の近くだけ (太さの半分 1 + 余裕 4)
    expect(hit(doc, 250, 4)).toEqual(["line"]);
    expect(hit(doc, 250, 6)).toBeNull();
    expect(hit(doc, 220, 20)).toBeNull();
    expect(hit(doc, 450, 3)).toEqual(["none"]);
    expect(hit(doc, 420, 20)).toBeNull();
  });

  it("回転したパスは自分の座標系で判定する", () => {
    const doc = docOf(
      [
        {
          ...createPath(triangle, { id: "p", fill: solidPaint("#000000"), stroke: null }),
          rotation: 180,
        },
      ],
      ["p"],
    );
    // 180° 回すと三角形は右下の半分になる
    expect(hit(doc, 80, 80)).toEqual(["p"]);
    expect(hit(doc, 20, 20)).toBeNull();
  });
});

describe("ブーリアンの当たり", () => {
  const doc = docOf(
    [
      createBoolean("subtract", ["a", "b"], { id: "s", fill: solidPaint("#000000") }),
      createRect({ id: "a", x: 0, y: 0, width: 100, height: 100 }),
      createRect({ id: "b", x: 25, y: 25, width: 50, height: 50 }),
    ],
    ["s"],
  );

  it("スコープの外では結果の形で当たり、道の末尾に点の下の子を足す", () => {
    expect(hit(doc, 10, 10)).toEqual(["s", "a"]);
    // 型抜きの穴は当たらない
    expect(hit(doc, 50, 50)).toBeNull();
    expect(pickTarget(doc, hit(doc, 10, 10), null).id).toBe("s");
    expect(pickTarget(doc, hit(doc, 10, 10), null, { deep: true }).id).toBe("a");
  });

  it("スコープの中では子を個別に (輪郭の上と内側で) 当てる", () => {
    expect(hit(doc, 50, 50, "s")).toEqual(["s", "b"]);
    expect(pickTarget(doc, hit(doc, 50, 50, "s"), "s").id).toBe("b");
    expect(pickTarget(doc, hit(doc, 10, 10, "s"), "s").id).toBe("a");
  });

  it("ブーリアンは Enter とダブルクリックで中に入れる。外接矩形の中の何もない場所もスコープの中", () => {
    expect(canEnter(doc, "s")).toBe(true);
    const empty = pickTarget(doc, null, "s", { point: { x: 99, y: 99 } });
    expect(empty).toEqual({ id: null, scopeId: "s" });
    expect(pickTarget(doc, null, "s", { point: { x: 200, y: 200 } }).scopeId).toBeNull();
  });

  it("非表示の子は当たらない", () => {
    const hidden = {
      ...doc,
      nodes: { ...doc.nodes, b: { ...doc.nodes.b!, visible: false } },
    } as CanvasDocument;
    expect(hit(hidden, 50, 50)).toEqual(["s", "a"]);
  });
});

describe("ドロップ先の frame (§8.5.2)", () => {
  it("回転した frame は点を frame の座標系に直して判定する", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 45,
          children: ["g"],
        }),
        createFrame({ id: "g", x: 0, y: 0, width: 20, height: 20, children: [], clip: true }),
      ],
      ["f"],
    );
    const frames = dropFrames(doc, "p1", new Set());
    // 45° 回した正方形の外接矩形の角は、frame の外
    expect(dropTargetAt(frames, { x: -18, y: 2 })).toBeNull();
    expect(dropTargetAt(frames, { x: 50, y: 50 })).toBe("f");
    // g は f の座標系の (0,0)..(20,20)。ページでは f の上の角 (50, -20.7) の近く
    expect(dropTargetAt(frames, { x: 50, y: -30 })).toBeNull();
    expect(dropTargetAt(frames, { x: 50, y: -6.5 })).toBe("g");
    expect(dropTargetAt(frames, { x: 50, y: 10 })).toBe("f");
  });
});
