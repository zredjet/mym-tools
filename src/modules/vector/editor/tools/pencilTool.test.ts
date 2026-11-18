import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyInput } from "../canvas/input";
import { CANVAS_SHORTCUTS, runShortcut } from "../canvas/shortcuts";
import { createBoolean, createRect, createStroke } from "../model/create";
import { checkSavable } from "../model/payload";
import { getParent } from "../model/tree";
import type { CanvasDocument, CanvasNode, PathNode, Point } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { pageGeometry } from "./pathEdit/ops";
import { pathEditDocument } from "./pathEdit/testing";
import { PENCIL_CLOSE_DISTANCE, pencilTool, resetPencilTool } from "./pencilTool";
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

/** 中心 (cx, cy)、半径 r の円弧の点 (角度 from〜to、ラジアン)。 */
function arc(n: number, r: number, from: number, to: number, cx = 200, cy = 200): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = from + ((to - from) * i) / (n - 1);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

function setup(doc: CanvasDocument = emptyDoc(), zoom = 1) {
  resetPencilTool();
  const store = createEditorStore(doc);
  store.getState().setViewport({ x: 0, y: 0, zoom });
  const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
  store.subscribe((state, previous) => {
    if (state.toolId !== previous.toolId) TOOLS[previous.toolId].onCancel?.(ctx);
  });
  store.getState().setTool("pencil");
  const event = (p: Point, mods: Mods = {}): CanvasPointerEvent => ({
    page: p,
    screen: { x: p.x * zoom, y: p.y * zoom },
    button: 0,
    clickCount: 1,
    shift: false,
    alt: false,
    mod: false,
    ...mods,
  });
  const down = (p: Point, mods: Mods = {}) => pencilTool.onPointerDown?.(event(p, mods), ctx);
  const move = (p: Point, mods: Mods = {}) => pencilTool.onPointerMove?.(event(p, mods), ctx);
  const up = (p: Point, mods: Mods = {}) => pencilTool.onPointerUp?.(event(p, mods), ctx);
  /** 点の列をなぞる (最初で押し、最後で離す) */
  const trace = (points: readonly Point[]) => {
    down(points[0]!);
    for (const p of points.slice(1)) move(p);
    up(points[points.length - 1]!);
  };
  const s = () => store.getState();
  const created = (): PathNode => {
    const id = s().selection[0];
    const node = id === undefined ? undefined : s().doc.nodes[id];
    expect(node?.type).toBe("path");
    return node as PathNode;
  };
  return { store, ctx, down, move, up, trace, s, created };
}

beforeEach(() => resetPencilTool());

describe("鉛筆", () => {
  it("なぞった点を曲線に当てはめた開いたパスを作る。塗りなし、線は既定、名前は「鉛筆」。履歴 1 件", () => {
    const { trace, s, created, store } = setup();
    const before = s().doc;
    const pts = arc(60, 100, 0, Math.PI);
    trace(pts);
    const node = created();
    expect(node).toMatchObject({ name: "鉛筆", fill: null, stroke: createStroke(), rotation: 0 });
    expect(node.subpaths).toHaveLength(1);
    const sub = node.subpaths[0]!;
    expect(sub.closed).toBe(false);
    // 曲線なので、なぞった点よりずっと少ない
    expect(sub.points.length).toBeGreaterThanOrEqual(2);
    expect(sub.points.length).toBeLessThan(10);
    // 始点と終点はなぞった点のまま (ページ座標)
    const geometry = pageGeometry(s().doc, node.id)!;
    const ends = geometry.points[0]!;
    expect(ends[0]!.at.x).toBeCloseTo(300, 6);
    expect(ends[0]!.at.y).toBeCloseTo(200, 6);
    expect(ends[ends.length - 1]!.at.x).toBeCloseTo(100, 6);
    expect(ends[ends.length - 1]!.at.y).toBeCloseTo(200, 6);
    // 箱は曲線の範囲 (円弧の下半分: y は 200〜300)
    expect(node.y).toBeCloseTo(200, 1);
    expect(node.height).toBeCloseTo(100, 0);
    expect(getParent(s().doc, node.id)).toEqual({ kind: "page", id: "p1" });
    expect(s().toolId).toBe("select");
    expect(s().gestureActive).toBe(false);
    expect(s().revision).toBe(1);
    expect(checkSavable(s().doc)).toBeNull();
    store.getState().undo();
    expect(s().doc).toBe(before);
  });

  it("なぞっている間は折れ線をそのまま描く", () => {
    const { down, move, s } = setup();
    down({ x: 0, y: 0 });
    move({ x: 10, y: 5 });
    move({ x: 20, y: 0 });
    const nodes = Object.values(s().doc.nodes) as PathNode[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.subpaths[0]!.points).toHaveLength(3);
    expect(s().gestureActive).toBe(true);
  });

  it("終点が始点から 8 画面 px 以内なら閉じる。倍率に合わせる", () => {
    const closing = arc(120, 100, 0, Math.PI * 2 - 0.05); // 終点は始点から約 5
    const a = setup();
    a.trace(closing);
    expect(a.created().subpaths[0]!.closed).toBe(true);
    expect(checkSavable(a.s().doc)).toBeNull();

    // 倍率 0.5 では、ページ座標の 16 まで閉じる
    const gap12 = arc(120, 100, 0, Math.PI * 2 - 0.12);
    const b = setup(emptyDoc(), 0.5);
    b.trace(gap12);
    expect(b.created().subpaths[0]!.closed).toBe(true);
    // 倍率 1 では閉じない
    const c = setup();
    c.trace(gap12);
    expect(c.created().subpaths[0]!.closed).toBe(false);
    expect(PENCIL_CLOSE_DISTANCE).toBe(8);
  });

  it("誤差は 2 画面 px: 倍率を上げると細かく当てはめる", () => {
    const wobble = Array.from({ length: 200 }, (_, i) => ({
      x: 100 + i,
      y: 100 + 3 * Math.sin(i / 4),
    }));
    const far = setup(emptyDoc(), 0.25);
    far.trace(wobble);
    const near = setup(emptyDoc(), 4);
    near.trace(wobble);
    expect(near.created().subpaths[0]!.points.length).toBeGreaterThan(
      far.created().subpaths[0]!.points.length,
    );
  });

  it("クリックだけ (動かさない・しきい値未満) なら何も作らず、ツールも選択も変えない", () => {
    const { down, move, up, s } = setup(booleanDoc());
    s().setSelection(["bo"]);
    const before = s().doc;
    down({ x: 300, y: 300 });
    up({ x: 300, y: 300 });
    down({ x: 300, y: 300 });
    move({ x: 301, y: 301 });
    up({ x: 301, y: 301 });
    expect(s().doc).toBe(before);
    expect(s().revision).toBe(0);
    expect(s().toolId).toBe("pencil");
    expect(s().selection).toEqual(["bo"]);
  });

  it("回転した frame の中では、点を frame の座標系に直す", () => {
    // f: (0, 400) の 300 × 300 を 90° 回したもの。frame の (x, y) はページの (300 − y, 400 + x)
    const { trace, created, s } = setup(pathEditDocument());
    const pts = [
      { x: 250, y: 450 },
      { x: 240, y: 470 },
      { x: 230, y: 490 },
      { x: 220, y: 510 },
    ];
    trace(pts);
    const node = created();
    expect(getParent(s().doc, node.id)).toEqual({ kind: "node", id: "f" });
    const geometry = pageGeometry(s().doc, node.id)!;
    const ends = geometry.points[0]!;
    expect(ends[0]!.at.x).toBeCloseTo(250, 6);
    expect(ends[0]!.at.y).toBeCloseTo(450, 6);
    expect(ends[ends.length - 1]!.at.x).toBeCloseTo(220, 6);
    expect(ends[ends.length - 1]!.at.y).toBeCloseTo(510, 6);
    // 点は frame の座標系 (x はページの y − 400)
    expect(node.x).toBeCloseTo(50, 6);
    expect(node.width).toBeCloseTo(60, 6);
    expect(checkSavable(s().doc)).toBeNull();
  });

  it("ブーリアンのスコープの中では、ブーリアンの親に置く", () => {
    const { store, trace, created, s } = setup(booleanDoc());
    store.getState().setScope("bo");
    trace(arc(30, 30, 0, Math.PI, 60, 60));
    const node = created();
    expect(getParent(s().doc, node.id)).toEqual({ kind: "page", id: "p1" });
    expect((s().doc.nodes.bo as { children: string[] }).children).toEqual(["a", "b"]);
  });

  it("なぞっている途中の取消 (Esc・フォーカス喪失) で何も残さず、選択も押す前に戻る", () => {
    const { down, move, up, ctx, s } = setup(booleanDoc());
    s().setSelection(["bo"]);
    const before = s().doc;
    down({ x: 300, y: 300 });
    move({ x: 320, y: 310 });
    move({ x: 340, y: 330 });
    expect(Object.keys(s().doc.nodes)).toHaveLength(4);
    pencilTool.onCancel?.(ctx);
    expect(s().doc).toBe(before);
    expect(s().selection).toEqual(["bo"]);
    expect(s().gestureActive).toBe(false);
    expect(s().revision).toBe(0);
    // 取り消した後に離しても何も作らない
    up({ x: 340, y: 330 });
    expect(s().doc).toBe(before);
    expect(s().toolId).toBe("pencil");
  });

  it("ほかが開いたジェスチャーは取り消さない", () => {
    const { ctx, s } = setup();
    s().beginGesture();
    pencilTool.onCancel?.(ctx);
    expect(s().gestureActive).toBe(true);
  });

  it("なぞり始める前に文書が変わったら何も作らない", () => {
    const { down, move, up, s } = setup(booleanDoc());
    down({ x: 300, y: 300 });
    s().apply((doc) => ({ ...doc }));
    const after = s().doc;
    move({ x: 320, y: 300 });
    move({ x: 340, y: 320 });
    up({ x: 340, y: 320 });
    expect(s().doc).toBe(after);
    expect(s().toolId).toBe("pencil");
  });

  it("Undo でジェスチャーが閉じられたら、それ以上描かない", () => {
    const { down, move, up, s } = setup();
    down({ x: 0, y: 0 });
    move({ x: 20, y: 0 });
    s().undo();
    const after = s().doc;
    move({ x: 40, y: 10 });
    up({ x: 40, y: 10 });
    expect(s().doc).toBe(after);
    expect(Object.keys(s().doc.nodes)).toHaveLength(0);
  });

  it("座標の範囲を超えるなら作らない", () => {
    const { trace, s } = setup();
    const before = s().doc;
    trace([
      { x: 0, y: 0 },
      { x: 2e9, y: 0 },
      { x: 4e9, y: 10 },
    ]);
    expect(s().doc).toBe(before);
    expect(s().toolId).toBe("pencil");
  });

  it("主ボタンでなければ何もしない", () => {
    const { down, move, up, s } = setup();
    down({ x: 0, y: 0 }, { button: 2 });
    move({ x: 50, y: 50 }, { button: 2 });
    up({ x: 50, y: 50 }, { button: 2 });
    expect(Object.keys(s().doc.nodes)).toHaveLength(0);
  });
});

describe("ショートカット", () => {
  const input = (patch: Partial<KeyInput>): KeyInput => ({
    key: "",
    code: "",
    repeat: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...patch,
  });
  const run = (patch: Partial<KeyInput>, mac = true) => {
    const store = createEditorStore(emptyDoc());
    const env = { store, size: { width: 800, height: 600 }, measurer: fixedWidthMeasurer() };
    const hit = runShortcut(input(patch), env, CANVAS_SHORTCUTS, mac);
    return { id: hit?.id ?? null, tool: store.getState().toolId };
  };

  it("Shift+P で鉛筆、P はペンのまま", () => {
    expect(run({ key: "P", code: "KeyP", shiftKey: true })).toEqual({
      id: "tool.pencil",
      tool: "pencil",
    });
    expect(run({ key: "p", code: "KeyP" })).toEqual({ id: "tool.pen", tool: "pen" });
  });

  it("Cmd/Ctrl+Shift+P (アプリ全体のプロジェクト切替) は取らない", () => {
    expect(run({ key: "P", code: "KeyP", shiftKey: true, metaKey: true })).toEqual({
      id: null,
      tool: "select",
    });
    expect(run({ key: "P", code: "KeyP", shiftKey: true, ctrlKey: true }, false)).toEqual({
      id: null,
      tool: "select",
    });
  });
});
