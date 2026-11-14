import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImage, createLine, createText } from "../model/create";
import { getPageBounds } from "../model/geometry";
import { insertNode } from "../model/structure";
import { sampleDocument } from "../model/testing";
import { addGuide, updateNode } from "../model/transform";
import { getParent } from "../model/tree";
import type { CanvasDocument } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { getSelectOverlay } from "./select/overlayState";
import { DRAG_THRESHOLD, resetSelectTool, selectTool, selectToolPhase } from "./selectTool";
import type { CanvasPointerEvent, ToolContext } from "./types";

// 座標は hit/hitTest.test.ts の sampleDocument の説明を参照

type Mods = Partial<Pick<CanvasPointerEvent, "shift" | "alt" | "mod" | "clickCount" | "button">>;

function setup(doc: CanvasDocument = sampleDocument(), zoom = 1) {
  resetSelectTool();
  const store = createEditorStore(doc);
  store.getState().setViewport({ x: 0, y: 0, zoom });
  const setCursor = vi.fn();
  const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor };
  const event = (x: number, y: number, mods: Mods = {}): CanvasPointerEvent => ({
    page: { x, y },
    screen: { x: x * zoom, y: y * zoom },
    button: 0,
    clickCount: 1,
    shift: false,
    alt: false,
    mod: false,
    ...mods,
  });
  const down = (x: number, y: number, mods: Mods = {}) =>
    selectTool.onPointerDown?.(event(x, y, mods), ctx);
  const move = (x: number, y: number, mods: Mods = {}) =>
    selectTool.onPointerMove?.(event(x, y, mods), ctx);
  const up = (x: number, y: number, mods: Mods = {}) =>
    selectTool.onPointerUp?.(event(x, y, mods), ctx);
  const click = (x: number, y: number, mods: Mods = {}) => {
    down(x, y, mods);
    up(x, y, mods);
  };
  const drag = (from: [number, number], to: [number, number], mods: Mods = {}, steps = 4) => {
    down(from[0], from[1], mods);
    for (let i = 1; i <= steps; i++)
      move(
        from[0] + ((to[0] - from[0]) * i) / steps,
        from[1] + ((to[1] - from[1]) * i) / steps,
        mods,
      );
    up(to[0], to[1], mods);
  };
  const s = () => store.getState();
  return { store, ctx, setCursor, event, down, move, up, click, drag, s };
}

beforeEach(() => resetSelectTool());

describe("クリックでの選択", () => {
  it("クリックで選び、何もない場所で解除する。履歴も revision も増えない", () => {
    const { click, s } = setup();
    click(120, 70);
    expect(s().selection).toEqual(["r1"]);
    click(400, 300); // ページ直下の frame の中の何もない場所
    expect(s().selection).toEqual([]);
    click(155, 115);
    expect(s().selection).toEqual(["grp"]);
    expect(s().revision).toBe(0);
    expect(s().canUndo).toBe(false);
  });

  it("frame のラベルを押すと frame を選ぶ", () => {
    const { click, s } = setup();
    click(105, 40);
    expect(s().selection).toEqual(["f"]);
  });

  it("Shift で足し、選択済みなら外す", () => {
    const { click, s } = setup();
    click(120, 70);
    click(5, 5, { shift: true });
    expect(s().selection).toEqual(["r1", "r0"]);
    click(120, 70, { shift: true });
    expect(s().selection).toEqual(["r0"]);
  });

  it("Cmd/Ctrl はいちばん深いノード", () => {
    const { click, s } = setup();
    click(155, 115, { mod: true });
    expect(s().selection).toEqual(["r2"]);
  });

  it("選択済みを押して動かさずに離すと、それだけを選び直す", () => {
    const { click, s, store } = setup();
    store.getState().setSelection(["r1", "r0"]);
    click(120, 70);
    expect(s().selection).toEqual(["r1"]);
    // frame を選んだまま子をクリックすると子を選ぶ
    store.getState().setSelection(["f"]);
    click(120, 70);
    expect(s().selection).toEqual(["r1"]);
  });

  it("ダブルクリックで group / 入れ子の frame の中へ入り、下の子を選ぶ", () => {
    const { click, s } = setup();
    click(160, 90);
    click(160, 90, { clickCount: 2 });
    expect(s().scopeId).toBe("grp");
    expect(s().selection).toEqual(["l1"]);
    click(310, 160);
    click(310, 160, { clickCount: 2 });
    expect(s().scopeId).toBe("f2");
    expect(s().selection).toEqual(["r3"]);
  });

  it("テキストのダブルクリックは本文の編集を始める", () => {
    const doc = insertNode(
      sampleDocument(),
      createText({ id: "t", x: 20, y: 200, width: 60, height: 20, text: "abc" }),
      { kind: "node", id: "f" },
    );
    const { click, s } = setup(doc);
    click(140, 260);
    click(140, 260, { clickCount: 2 });
    expect(s().editingTextId).toBe("t");
  });

  it("スコープの外を押すとスコープから出る", () => {
    const { click, s, store } = setup();
    store.getState().setScope("grp");
    click(120, 70);
    expect(s().scopeId).toBeNull();
    expect(s().selection).toEqual(["r1"]);
  });

  it("主ボタン以外は何もしない", () => {
    const { click, s } = setup();
    click(120, 70, { button: 2 });
    expect(s().selection).toEqual([]);
  });
});

describe("移動", () => {
  it(`${DRAG_THRESHOLD} 画面 px 未満の動きはクリック`, () => {
    const { down, move, up, s } = setup(sampleDocument(), 2);
    down(120, 70);
    move(120.5, 70.5); // 画面では 1.4 px
    up(120.5, 70.5);
    expect(s().doc.nodes.r1).toMatchObject({ x: 10, y: 10 });
    expect(s().revision).toBe(0);
  });

  it("ドラッグで動かし、結果は整数。履歴は 1 件", () => {
    const { drag, s } = setup();
    drag([120, 70], [150.4, 129.6], { mod: true });
    expect(s().doc.nodes.r1).toMatchObject({ x: 40, y: 70 });
    expect(s().revision).toBe(1);
    s().undo();
    expect(s().doc.nodes.r1).toMatchObject({ x: 10, y: 10 });
    expect(s().canUndo).toBe(false);
  });

  it("Shift で水平・垂直に固定", () => {
    const { drag, s } = setup();
    drag([120, 70], [160, 80], { shift: true, mod: true });
    expect(s().doc.nodes.r1).toMatchObject({ x: 50, y: 10 });
  });

  it("Alt で開始時に 1 回だけ複製し、複製を動かす", () => {
    const { drag, s } = setup();
    const before = Object.keys(s().doc.nodes).length;
    drag([120, 70], [170, 70], { alt: true, mod: true }, 6);
    expect(Object.keys(s().doc.nodes)).toHaveLength(before + 1);
    const [copy] = s().selection;
    expect(copy).not.toBe("r1");
    expect(s().doc.nodes[copy!]).toMatchObject({ x: 60, y: 10 });
    expect(s().doc.nodes.r1).toMatchObject({ x: 10, y: 10 });
    expect(s().doc.nodes.f).toMatchObject({ children: ["r1", copy, "grp", "f2"] });
    expect(s().revision).toBe(1);
  });

  it("onCancel (Esc・フォーカス喪失) で開始時点に戻す", () => {
    const { down, move, ctx, s } = setup();
    down(120, 70);
    move(150, 90);
    expect(s().gestureActive).toBe(true);
    selectTool.onCancel?.(ctx);
    expect(s().doc.nodes.r1).toMatchObject({ x: 10, y: 10 });
    expect(s().gestureActive).toBe(false);
    expect(s().revision).toBe(0);
    expect(selectToolPhase()).toBe("idle");
  });

  it("途中で Undo によりジェスチャーが取り消されたら、それ以上動かさない", () => {
    const { down, move, up, s } = setup();
    down(120, 70);
    move(150, 90);
    s().undo();
    move(200, 120);
    up(200, 120);
    expect(s().doc.nodes.r1).toMatchObject({ x: 10, y: 10 });
    expect(s().revision).toBe(0);
  });

  it("別の frame の上で離すと、見た目の位置を変えずにその子にする", () => {
    const { drag, s } = setup();
    drag([120, 70], [330, 180], { mod: true });
    expect(getParent(s().doc, "r1")).toEqual({ kind: "node", id: "f2" });
    expect(getPageBounds(s().doc, "r1")).toEqual({ x: 320, y: 170, width: 20, height: 20 });
    drag([330, 180], [-100, 0], { mod: true });
    expect(getParent(s().doc, "r1")).toEqual({ kind: "page", id: "p1" });
    expect(getPageBounds(s().doc, "r1")).toEqual({ x: -110, y: -10, width: 20, height: 20 });
  });

  it("同じ frame の中なら group から出さない", () => {
    const { click, drag, s } = setup();
    click(155, 115, { mod: true });
    drag([155, 115], [255, 215], { mod: true });
    expect(getParent(s().doc, "r2")).toEqual({ kind: "node", id: "grp" });
  });

  it("選択範囲の中の何もない場所からも、選択を動かせる", () => {
    const { store, drag, s } = setup();
    store.getState().setSelection(["r1", "r0"]);
    drag([60, 40], [80, 40], { mod: true });
    expect(s().doc.nodes.r0).toMatchObject({ x: 20, y: 0 });
    expect(s().doc.nodes.r1).toMatchObject({ x: 30, y: 10 });
  });

  it("ロック中・非表示のノードは動かさない", () => {
    const doc = updateNode(sampleDocument(), "r0", { locked: true });
    const { store, drag, s } = setup(doc);
    store.getState().setSelection(["r0"]);
    drag([5, 5], [50, 50]);
    expect(s().doc.nodes.r0).toMatchObject({ x: 0, y: 0 });
    expect(s().revision).toBe(0);
  });

  it("兄弟と親 frame の辺・中心に吸着し、スマートガイドを出す。Cmd/Ctrl で吸着しない", () => {
    const { down, move, up, s } = setup();
    down(120, 70);
    // r1 の上端を 88 にする → grp の上端 90 (2 px 以内) に吸着
    move(120, 98);
    expect(s().doc.nodes.r1).toMatchObject({ y: 40 });
    expect(getSelectOverlay().guides.some((g) => g.axis === "y" && g.pos === 90)).toBe(true);
    move(120, 98, { mod: true });
    expect(s().doc.nodes.r1).toMatchObject({ y: 38 });
    expect(getSelectOverlay().guides).toEqual([]);
    up(120, 98);
    expect(getSelectOverlay().guides).toEqual([]);
  });

  it("グリッドに吸着する (snapToGrid のとき)", () => {
    const { down, move, up, s } = setup();
    s().setView({ snapToGrid: true, gridSize: 10 });
    down(5, 5);
    move(-38, -41); // r0 (10×10) を (-43, -46) へ → グリッド (-40, -50)
    up(-38, -41);
    expect(s().doc.nodes.r0).toMatchObject({ x: -40, y: -50 });
    s().setView({ snapToGrid: false });
    down(-35, -45);
    move(-38, -49);
    up(-38, -49);
    expect(s().doc.nodes.r0).toMatchObject({ x: -43, y: -54 });
  });

  it("押した位置の frame から出ないかぎり親を変えない", () => {
    const { store, drag, s } = setup();
    // 選択範囲 (r1 と r0) の、frame の外の何もない場所をつかんで、frame の外へ動かす
    store.getState().setSelection(["r1", "r0"]);
    drag([60, 40], [40, 40], { mod: true });
    expect(getParent(s().doc, "r1")).toEqual({ kind: "node", id: "f" });
  });
});

describe("範囲選択", () => {
  it("何もない場所からのドラッグで選び、矩形を出す", () => {
    const { down, move, up, s } = setup();
    down(60, 40);
    move(140, 100);
    expect(s().selection).toEqual(["r1", "grp", "r0"].filter((id) => id !== "r0"));
    expect(getSelectOverlay().marquee).toEqual({ x: 60, y: 40, width: 80, height: 60 });
    up(140, 100);
    expect(getSelectOverlay().marquee).toBeNull();
    expect(s().revision).toBe(0);
  });

  it("Shift なら今の選択に足す。onCancel で押す前の選択に戻す", () => {
    const { store, down, move, up, ctx, s } = setup();
    store.getState().setSelection(["r0"]);
    down(60, 40, { shift: true });
    move(140, 100, { shift: true });
    expect(s().selection).toEqual(["r0", "r1", "grp"]);
    up(140, 100, { shift: true });
    down(60, 40);
    move(140, 100);
    selectTool.onCancel?.(ctx);
    expect(s().selection).toEqual(["r0", "r1", "grp"]);
  });
});

describe("リサイズ", () => {
  it("右下のハンドルで大きさを変える。結果は整数で履歴 1 件", () => {
    const { click, drag, s } = setup();
    click(120, 70);
    drag([130, 80], [150.4, 90.2], { mod: true });
    expect(s().doc.nodes.r1).toMatchObject({ x: 10, y: 10, width: 40, height: 30 });
    expect(s().revision).toBe(1);
  });

  it("Shift で縦横比を固定、Alt で中心から", () => {
    const { click, drag, s } = setup();
    click(120, 70);
    drag([130, 80], [170, 85], { shift: true, mod: true });
    expect(s().doc.nodes.r1).toMatchObject({ x: 10, y: 10, width: 60, height: 60 });
    s().undo();
    drag([130, 80], [140, 90], { alt: true, mod: true });
    expect(s().doc.nodes.r1).toMatchObject({ x: 0, y: 0, width: 40, height: 40 });
  });

  it("画像は既定で縦横比を固定し、Shift で解除する", () => {
    const doc = insertNode(
      sampleDocument(),
      createImage("a1", { id: "img", x: 0, y: 200, width: 100, height: 50 }),
      { kind: "page", id: "p1" },
    );
    const { click, drag, s } = setup(doc);
    click(50, 225);
    drag([100, 250], [200, 260], { mod: true });
    expect(s().doc.nodes.img).toMatchObject({ width: 200, height: 100 });
    s().undo();
    drag([100, 250], [200, 260], { shift: true, mod: true });
    expect(s().doc.nodes.img).toMatchObject({ width: 200, height: 60 });
  });

  it("テキストを含むリサイズは fitTextNodes で高さを求め直す", () => {
    const doc = insertNode(
      sampleDocument(),
      createText({ id: "t", x: 0, y: 400, width: 30, height: 50, text: "abc", fontSize: 10 }),
      { kind: "page", id: "p1" },
    );
    const { click, drag, s } = setup(doc);
    click(15, 420);
    drag([30, 425], [60, 425], { mod: true });
    // 横に引いたので auto-height。高さは行分割の結果 (1 行 × 10 × 1.4 = 14)
    expect(s().doc.nodes.t).toMatchObject({ sizing: "auto-height", width: 60, height: 14 });
    expect(s().revision).toBe(1);
  });

  it("§3.5 の範囲を超えるリサイズは当てない", () => {
    const { click, down, move, up, s } = setup();
    click(120, 70);
    down(130, 80);
    move(200, 100, { mod: true });
    move(500_000, 100, { mod: true });
    up(500_000, 100, { mod: true });
    expect(s().doc.nodes.r1).toMatchObject({ width: 90 });
  });

  it("ハンドルの上でカーソルを変え、離れたら戻す", () => {
    const { click, move, setCursor, s } = setup();
    click(120, 70);
    move(130, 80, { clickCount: 0 });
    expect(setCursor).toHaveBeenLastCalledWith("nwse-resize");
    move(300, 300, { clickCount: 0 });
    expect(setCursor).toHaveBeenLastCalledWith(null);
    expect(s().hoveredId).toBeNull();
  });

  it("本文の編集中のテキストにはハンドルを出さない (押してもリサイズしない)", () => {
    const doc = insertNode(
      sampleDocument(),
      createText({ id: "t", x: 0, y: 400, width: 30, height: 20, text: "abc" }),
      { kind: "page", id: "p1" },
    );
    const { drag, s } = setup(doc);
    s().startTextEdit("t");
    drag([30, 420], [60, 420], { mod: true });
    expect(s().doc.nodes.t).toMatchObject({ width: 30 });
  });
});

describe("線の端点", () => {
  it("線を 1 本だけ選ぶと、端点を動かせる", () => {
    const doc = insertNode(
      sampleDocument(),
      createLine({ id: "ln", x1: 0, y1: 500, x2: 100, y2: 500 }),
      {
        kind: "page",
        id: "p1",
      },
    );
    const { click, drag, s } = setup(doc);
    click(50, 500);
    expect(s().selection).toEqual(["ln"]);
    drag([100, 500], [150.4, 540.2], { mod: true });
    expect(s().doc.nodes.ln).toMatchObject({ x1: 0, y1: 500, x2: 150, y2: 540 });
    s().undo();
    drag([0, 500], [10, 480], { mod: true });
    expect(s().doc.nodes.ln).toMatchObject({ x1: 10, y1: 480, x2: 100, y2: 500 });
  });
});

describe("ガイド線", () => {
  it("つかんで動かし、ルーラーの上で離すと消える。それぞれ履歴 1 件", () => {
    const doc = addGuide(sampleDocument(), "p1", { axis: "x", position: 600 });
    const { drag, s, move, setCursor } = setup(doc);
    move(601, 400, { clickCount: 0 });
    expect(setCursor).toHaveBeenLastCalledWith("ew-resize");
    drag([601, 400], [650.3, 400]);
    expect(s().doc.pages[0]!.guides).toEqual([{ axis: "x", position: 649 }]);
    expect(s().revision).toBe(1);
    drag([649, 400], [10, 400]); // 画面 x < 20 = 左のルーラーの上
    expect(s().doc.pages[0]!.guides).toEqual([]);
    expect(s().revision).toBe(2);
  });

  it("動かさずにクリックしたら、下にあるものを選ぶ", () => {
    const doc = addGuide(sampleDocument(), "p1", { axis: "x", position: 120 });
    const { click, s } = setup(doc);
    click(120, 70);
    expect(s().selection).toEqual(["r1"]);
    expect(s().revision).toBe(0);
  });
});

describe("ホバー", () => {
  it("ボタンを押していない移動でホバーを決める (Cmd/Ctrl はいちばん深いノード)", () => {
    const { move, s } = setup();
    move(155, 115, { clickCount: 0 });
    expect(s().hoveredId).toBe("grp");
    move(155, 115, { clickCount: 0, mod: true });
    expect(s().hoveredId).toBe("r2");
    move(105, 40, { clickCount: 0 });
    expect(s().hoveredId).toBe("f");
    move(400, 300, { clickCount: 0 });
    expect(s().hoveredId).toBeNull();
  });
});
