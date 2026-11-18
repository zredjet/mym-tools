import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoolean, createPath, createRect } from "../model/create";
import { CANVAS_LIMITS } from "../model/limits";
import { checkSavable } from "../model/payload";
import { insertNode } from "../model/structure";
import { getParent } from "../model/tree";
import type { CanvasDocument, CanvasNode, PathNode } from "../model/types";
import { pathBounds } from "../path/measure";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { pathEditDocument } from "./pathEdit/testing";
import {
  createRegularShapeTool,
  DEFAULT_SHAPE_TOOL_SETTINGS,
  getShapeToolSettings,
  regularShapeSubpath,
  resetShapeToolSettings,
  setShapeToolSettings,
  type RegularShapeKind,
} from "./polygonTool";
import { TOOLS } from "./registry";
import type { CanvasPointerEvent, ToolContext } from "./types";

type Mods = Partial<Pick<CanvasPointerEvent, "shift" | "alt" | "mod" | "clickCount" | "button">>;

function emptyDoc(): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children: [], guides: [] }],
    nodes: {},
    assets: {},
  };
}

/** ブーリアン `bo` (合体、子は矩形 `a` (0,0 100×100) と `b` (50,50 100×100))。 */
function booleanDoc(): CanvasDocument {
  const nodes: CanvasNode[] = [
    createBoolean("union", ["a", "b"], { id: "bo" }),
    createRect({ id: "a", x: 0, y: 0, width: 100, height: 100 }),
    createRect({ id: "b", x: 50, y: 50, width: 100, height: 100 }),
  ];
  return {
    pages: [{ id: "p1", name: "ページ 1", children: ["bo"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

function setup(kind: RegularShapeKind, doc: CanvasDocument = emptyDoc()) {
  const store = createEditorStore(doc);
  store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
  const tool = createRegularShapeTool(kind);
  const tools = { ...TOOLS, [kind]: tool };
  const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
  store.subscribe((state, previous) => {
    if (state.toolId !== previous.toolId) tools[previous.toolId].onCancel?.(ctx);
  });
  store.getState().setTool(kind);
  const event = (x: number, y: number, mods: Mods = {}): CanvasPointerEvent => ({
    page: { x, y },
    screen: { x, y },
    button: 0,
    clickCount: 1,
    shift: false,
    alt: false,
    mod: false,
    ...mods,
  });
  const down = (x: number, y: number, mods: Mods = {}) =>
    tool.onPointerDown?.(event(x, y, mods), ctx);
  const move = (x: number, y: number, mods: Mods = {}) =>
    tool.onPointerMove?.(event(x, y, mods), ctx);
  const up = (x: number, y: number, mods: Mods = {}) => tool.onPointerUp?.(event(x, y, mods), ctx);
  const drag = (from: [number, number], to: [number, number], mods: Mods = {}) => {
    down(from[0], from[1], mods);
    move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, mods);
    move(to[0], to[1], mods);
    up(to[0], to[1], mods);
  };
  const s = () => store.getState();
  const created = (): PathNode => {
    const id = s().selection[0];
    const node = id === undefined ? undefined : s().doc.nodes[id];
    expect(node?.type).toBe("path");
    return node as PathNode;
  };
  return { store, tool, ctx, down, move, up, drag, s, created };
}

beforeEach(() => resetShapeToolSettings());

describe("多角形と星を作る", () => {
  it("多角形: ドラッグした矩形にぴったり収まる、角の点だけの閉じたパス。名前と見た目は矩形の既定", () => {
    const { drag, s, created, store } = setup("polygon");
    const before = s().doc;
    drag([100, 50], [220, 150]);
    const node = created();
    expect(node).toMatchObject({
      name: "多角形",
      x: 100,
      y: 50,
      width: 120,
      height: 100,
      rotation: 0,
      fill: createRect().fill,
      stroke: null,
      shadow: null,
    });
    expect(node.subpaths).toHaveLength(1);
    const sub = node.subpaths[0]!;
    expect(sub.closed).toBe(true);
    expect(sub.points).toHaveLength(3);
    expect(sub.points[0]).toEqual({ x: 60, y: 0, in: null, out: null, mirror: "none" });
    for (const p of sub.points) expect(p.in === null && p.out === null).toBe(true);
    expect(pathBounds(node.subpaths)).toEqual({ minX: 0, minY: 0, maxX: 120, maxY: 100 });
    expect(getParent(s().doc, node.id)).toEqual({ kind: "page", id: "p1" });
    expect(s().toolId).toBe("select");
    expect(s().gestureActive).toBe(false);
    expect(s().revision).toBe(1);
    expect(checkSavable(s().doc)).toBeNull();
    store.getState().undo();
    expect(s().doc).toBe(before);
  });

  it("星: 外側と内側の頂点が交互 (既定 5 個、凹み 0.382)", () => {
    const { drag, created, s } = setup("star");
    drag([0, 0], [100, 100]);
    const node = created();
    expect(node.name).toBe("星");
    const sub = node.subpaths[0]!;
    expect(sub.points).toHaveLength(10);
    expect(sub.points[0]).toMatchObject({ x: 50, y: 0 });
    expect(pathBounds(node.subpaths)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    // 内側の頂点は外側より中心に近い
    const center = { x: 50, y: 50 };
    const r = (i: number) =>
      Math.hypot(sub.points[i]!.x - center.x, (sub.points[i]!.y - center.y) * 1);
    expect(r(1)).toBeLessThan(r(0) * 0.6);
    expect(checkSavable(s().doc)).toBeNull();
  });

  it("ツールの設定の頂点の数と凹みを使う", () => {
    setShapeToolSettings({ polygonSides: 6, starPoints: 8, starRatio: 0.5 });
    const polygon = setup("polygon");
    polygon.drag([0, 0], [100, 100]);
    expect(polygon.created().subpaths[0]!.points).toHaveLength(6);
    const star = setup("star");
    star.drag([0, 0], [100, 100]);
    const points = star.created().subpaths[0]!.points;
    expect(points).toHaveLength(16);
    expect(points).toEqual(regularShapeSubpath("star", 100, 100).points);
  });

  it("点は小数第 2 位に丸める", () => {
    setShapeToolSettings({ polygonSides: 7 });
    const { drag, created } = setup("polygon");
    drag([0, 0], [133, 77]);
    for (const p of created().subpaths[0]!.points) {
      expect(Math.round(p.x * 100) / 100).toBe(p.x);
      expect(Math.round(p.y * 100) / 100).toBe(p.y);
    }
  });

  it("Shift で正方形、Alt で中心から", () => {
    const a = setup("polygon");
    a.drag([100, 100], [180, 140], { shift: true });
    expect(a.created()).toMatchObject({ x: 100, y: 100, width: 80, height: 80 });
    const b = setup("star");
    b.drag([100, 100], [150, 130], { alt: true });
    expect(b.created()).toMatchObject({ x: 50, y: 70, width: 100, height: 60 });
  });

  it("作っている途中から文書に入れて描く (矩形にはならない)", () => {
    const { down, move, s } = setup("polygon");
    down(0, 0);
    move(40, 40);
    move(80, 60);
    const nodes = Object.values(s().doc.nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "path", name: "多角形", width: 80, height: 60 });
    expect(s().gestureActive).toBe(true);
  });

  it("クリックだけなら矩形ツールと同じく 100 × 100 で、押した点を左上にする", () => {
    const { down, up, created, s } = setup("star");
    down(30, 40);
    up(30, 40);
    expect(created()).toMatchObject({
      type: "path",
      name: "星",
      x: 30,
      y: 40,
      width: 100,
      height: 100,
    });
    expect(s().revision).toBe(1);
    expect(s().toolId).toBe("select");
  });

  it("回転した frame の中では frame の座標系の箱 (回転 0)", () => {
    // f: (0, 400) の 300 × 300 を 90° 回したもの。frame の (x, y) はページの (300 − y, 400 + x)
    const { drag, created, s } = setup("polygon", pathEditDocument());
    drag([250, 450], [200, 500]);
    const node = created();
    expect(getParent(s().doc, node.id)).toEqual({ kind: "node", id: "f" });
    expect(node).toMatchObject({ x: 50, y: 50, width: 50, height: 50, rotation: 0 });
    expect(checkSavable(s().doc)).toBeNull();
  });

  it("ブーリアンのスコープの中では、ブーリアンの親に置く", () => {
    const { store, drag, created, s } = setup("polygon", booleanDoc());
    store.getState().setScope("bo");
    drag([20, 20], [60, 60]);
    const node = created();
    expect(getParent(s().doc, node.id)).toEqual({ kind: "page", id: "p1" });
    expect((s().doc.nodes.bo as { children: string[] }).children).toEqual(["a", "b"]);
    expect(checkSavable(s().doc)).toBeNull();
  });

  it("ドラッグの途中の取消 (Esc・フォーカス喪失) で何も残さず、選択も押す前に戻る", () => {
    const { down, move, tool, ctx, s } = setup("polygon", booleanDoc());
    s().setSelection(["bo"]);
    const before = s().doc;
    down(200, 200);
    move(260, 260);
    expect(Object.keys(s().doc.nodes)).toHaveLength(4);
    tool.onCancel?.(ctx);
    expect(s().doc).toBe(before);
    expect(s().selection).toEqual(["bo"]);
    expect(s().gestureActive).toBe(false);
    expect(s().revision).toBe(0);
    expect(s().toolId).toBe("polygon");
  });

  it("文書の点の合計の上限を超えるなら作らない", () => {
    setShapeToolSettings({ starPoints: 60 });
    // 文書の点の合計を上限の 100 手前にしておく (星 60 個は 120 点)。1 つのパスは 9,990 点 × 10 本
    const perPath = (CANVAS_LIMITS.maxTotalPathPoints - 100) / 10;
    let doc = emptyDoc();
    for (let n = 0; n < 10; n++) {
      const points = Array.from({ length: perPath }, (_, i) => ({
        x: i % 10,
        y: n,
        in: null,
        out: null,
        mirror: "none" as const,
      }));
      doc = insertNode(doc, createPath([{ closed: false, points }], { id: `fill${n}` }), {
        kind: "page",
        id: "p1",
      });
    }
    const before = doc;
    const { drag, s } = setup("star", doc);
    drag([0, 0], [100, 100]);
    expect(s().doc).toBe(before);
    expect(s().toolId).toBe("star");
    expect(s().revision).toBe(0);
  });
});

describe("ツールの設定", () => {
  it("既定は多角形 3、星 5・0.382。範囲に収め、頂点の数は整数", () => {
    expect(getShapeToolSettings()).toEqual(DEFAULT_SHAPE_TOOL_SETTINGS);
    expect(DEFAULT_SHAPE_TOOL_SETTINGS).toEqual({
      polygonSides: 3,
      starPoints: 5,
      starRatio: 0.382,
    });
    setShapeToolSettings({ polygonSides: 100, starPoints: 2.7, starRatio: 0 });
    expect(getShapeToolSettings()).toEqual({ polygonSides: 60, starPoints: 3, starRatio: 0.01 });
    setShapeToolSettings({ starRatio: 5 });
    expect(getShapeToolSettings().starRatio).toBe(1);
    resetShapeToolSettings();
    expect(getShapeToolSettings()).toEqual(DEFAULT_SHAPE_TOOL_SETTINGS);
  });
});
