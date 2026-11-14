import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImage, createLine, createRect, createText } from "../model/create";
import { getPageBounds } from "../model/geometry";
import { insertNode } from "../model/structure";
import { sampleDocument } from "../model/testing";
import { addGuide, updateNode } from "../model/transform";
import { getParent } from "../model/tree";
import type { CanvasDocument, CanvasNode } from "../model/types";
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

// ---------------------------------------------------------------------------
// レビューで足した規則 (設計文書 v0.5)
// ---------------------------------------------------------------------------

/** ページ直下にノードを足した文書。 */
function withNodes(...nodes: CanvasNode[]): CanvasDocument {
  return nodes.reduce<CanvasDocument>(
    (doc, node) => insertNode(doc, node, { kind: "page", id: "p1" }),
    sampleDocument(),
  );
}

describe("ドロップ先 (§4.6)", () => {
  it("ノードをつかんだら、ポインターの下の frame が今の親と違えば付け替える", () => {
    // ページ直下の矩形 (90..120, 100..130) は f (100..) に重なる。重なる点でつかんで f の中で離す
    const { click, drag, s } = setup(
      withNodes(createRect({ id: "p", x: 90, y: 100, width: 30, height: 30 })),
    );
    click(115, 115);
    expect(s().selection).toEqual(["p"]);
    drag([115, 115], [215, 215], { mod: true });
    expect(getParent(s().doc, "p")).toEqual({ kind: "node", id: "f" });
    expect(getPageBounds(s().doc, "p")).toEqual({ x: 190, y: 200, width: 30, height: 30 });
  });

  it("切り抜かない frame の子をはみ出した部分でつかんで外へ動かすと、ページ直下へ出る", () => {
    let doc = updateNode(sampleDocument(), "f", { clip: false });
    doc = updateNode(doc, "r1", { x: -50 }); // ページ座標 50..70 (f の外)
    const { click, drag, s } = setup(doc);
    click(60, 70);
    expect(s().selection).toEqual(["r1"]);
    drag([60, 70], [60, 600], { mod: true });
    expect(getParent(s().doc, "r1")).toEqual({ kind: "page", id: "p1" });
    expect(getPageBounds(s().doc, "r1")).toEqual({ x: 50, y: 590, width: 20, height: 20 });
  });

  it("ラベルや選択の中の何もない場所をつかんだときは、押した点の下と違う frame に入ったときだけ", () => {
    const { store, drag, s } = setup();
    store.getState().setSelection(["r1", "r0"]);
    // 何もない場所 (60, 40) はページ直下。ページ直下のまま動かしても r1 は f に残る
    drag([60, 40], [70, 300], { mod: true });
    expect(getParent(s().doc, "r1")).toEqual({ kind: "node", id: "f" });
    expect(getParent(s().doc, "r0")).toEqual({ kind: "page", id: "p1" });
    s().undo();
    // f2 の中へ入ったら、両方とも f2 の子になる
    drag([60, 40], [350, 200], { mod: true });
    expect(getParent(s().doc, "r1")).toEqual({ kind: "node", id: "f2" });
    expect(getParent(s().doc, "r0")).toEqual({ kind: "node", id: "f2" });
  });

  it("ドロップ先に合わせてスナップの候補を変える", () => {
    const { click, down, move, up, s } = setup();
    click(120, 70);
    // r1 の左を 306 へ。f2 の中では f2 の子 r3 の左 (305) へ吸着する
    // (f の子のままなら、兄弟の f2 の左 (300) が 6 px で候補になる)
    down(120, 70);
    move(200, 150);
    move(316, 230);
    up(316, 230);
    expect(getParent(s().doc, "r1")).toEqual({ kind: "node", id: "f2" });
    expect(getPageBounds(s().doc, "r1")?.x).toBe(305);
  });
});

describe("group のスコープ (§4.5)", () => {
  // grp の外接矩形はページ座標 (140..180, 90..120)。(170, 105) は子のない場所
  it("外接矩形の中の何もない場所を押してもスコープを出ず、範囲選択できる", () => {
    const { store, click, down, move, up, s } = setup();
    store.getState().setScope("grp");
    store.getState().setSelection(["l1"]);
    click(170, 105);
    expect(s().scopeId).toBe("grp");
    expect(s().selection).toEqual([]);
    down(170, 105);
    move(145, 118);
    expect(s().selection).toEqual(["r2"]);
    up(145, 118);
    expect(s().scopeId).toBe("grp");
  });

  it("選択の中の何もない場所をつかんで動かしても、スコープを出ない", () => {
    const { store, drag, s } = setup();
    store.getState().setScope("grp");
    store.getState().setSelection(["r2", "l1"]);
    drag([170, 105], [180, 105], { mod: true });
    expect(s().scopeId).toBe("grp");
    expect(s().doc.nodes.r2).toMatchObject({ x: 60 });
    expect(s().doc.nodes.l1).toMatchObject({ x1: 50, x2: 90 });
  });

  it("外接矩形の外を押したらスコープを出る", () => {
    const { store, click, s } = setup();
    store.getState().setScope("grp");
    click(250, 300);
    expect(s().scopeId).toBeNull();
  });
});

describe("Shift のクリック (§4.5)", () => {
  it("選択中の frame の子を Shift+クリックすると、子を足して frame を外す", () => {
    const { store, click, s } = setup();
    store.getState().setSelection(["f"]);
    click(120, 70, { shift: true });
    expect(s().selection).toEqual(["r1"]);
  });

  it("選択中の group の子を Shift+クリックすると、子を足して group を外す", () => {
    const { store, click, s } = setup();
    store.getState().setSelection(["r0", "grp"]);
    click(155, 115, { shift: true });
    expect(s().selection).toEqual(["r0", "r2"]);
  });

  it("選ばれていないノードを足すとき、その子孫が選ばれていれば入れ替える", () => {
    const { store, click, s } = setup();
    store.getState().setSelection(["r2"]);
    click(160, 90, { shift: true }); // l1 → ふつうのクリックでは grp
    expect(s().selection).toEqual(["grp"]);
  });

  it("選択済みの葉は、動かさずに離したら外す。動かしたら選択ごと動かす", () => {
    const { store, click, drag, s } = setup();
    store.getState().setSelection(["r1", "r0"]);
    drag([120, 70], [130, 70], { shift: true, mod: true });
    expect(s().selection).toEqual(["r1", "r0"]);
    expect(getPageBounds(s().doc, "r0")?.x).toBe(10);
    click(130, 70, { shift: true });
    expect(s().selection).toEqual(["r0"]);
  });

  it("Shift+ダブルクリックでは中に入らない", () => {
    const { click, s } = setup();
    click(155, 115);
    click(155, 115, { clickCount: 2, shift: true });
    expect(s().scopeId).toBeNull();
  });
});

describe("取消とホバー (§4.4 / §4.5)", () => {
  it("ほかが開いたジェスチャーは onCancel で取り消さない", () => {
    const { ctx, down, s } = setup();
    s().beginGesture(); // 色の選択や本文の編集が開いたもの
    s().updateGesture((doc) => updateNode(doc, "r0", { opacity: 0.5 }));
    selectTool.onCancel?.(ctx);
    expect(s().gestureActive).toBe(true);
    down(5, 5);
    selectTool.onCancel?.(ctx);
    expect(s().gestureActive).toBe(true);
    expect(s().doc.nodes.r0).toMatchObject({ opacity: 0.5 });
  });

  it("何もない場所を押してすぐ取り消すと、選択とスコープは押す前に戻る", () => {
    const { store, ctx, down, s } = setup();
    store.getState().setScope("grp");
    store.getState().setSelection(["r2"]);
    down(250, 300); // grp の外、f の何もない場所 → 選択の解除とスコープの外
    expect(s()).toMatchObject({ selection: [], scopeId: null });
    selectTool.onCancel?.(ctx);
    expect(s()).toMatchObject({ selection: ["r2"], scopeId: "grp" });
  });

  it("ノードを押して動かしてから取り消しても、選択は押す前に戻る", () => {
    const { store, ctx, down, move, s } = setup();
    store.getState().setSelection(["r0"]);
    down(120, 70);
    move(150, 90);
    selectTool.onCancel?.(ctx);
    expect(s().selection).toEqual(["r0"]);
    expect(s().doc.nodes.r1).toMatchObject({ x: 10, y: 10 });
  });

  it("onCancel でホバーを消す", () => {
    const { ctx, move, s } = setup();
    move(120, 70, { clickCount: 0 });
    expect(s().hoveredId).toBe("r1");
    selectTool.onCancel?.(ctx);
    expect(s().hoveredId).toBeNull();
  });
});

describe("移動の細則 (§4.6)", () => {
  it("動かしていない向きの小数の座標は変えない。元の位置へ戻したら文書を変えない", () => {
    const doc = withNodes(createRect({ id: "q", x: 0, y: 400.5, width: 20, height: 20 }));
    const { down, move, up, drag, s } = setup(doc);
    drag([10, 410], [40.4, 412], { shift: true, mod: true });
    expect(s().doc.nodes.q).toMatchObject({ x: 30, y: 400.5 });
    s().undo();
    down(10, 410);
    move(30, 430);
    move(10, 410);
    up(10, 410);
    expect(s().doc.nodes.q).toMatchObject({ x: 0, y: 400.5 });
    expect(s().canRedo).toBe(true); // 戻したまま離したので履歴は積まない (redo が残る)
  });

  it("ノード数が上限のときの Alt+ドラッグは、元も動かさずに何もしない", () => {
    const nodes: CanvasNode[] = [];
    for (let i = 0; i < 20_000; i++)
      nodes.push(
        createRect({ id: `n${i}`, x: i % 100, y: Math.floor(i / 100), width: 1, height: 1 }),
      );
    const doc: CanvasDocument = {
      pages: [{ id: "p1", name: "", children: nodes.map((n) => n.id), guides: [] }],
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      assets: {},
    };
    const { store, drag, s } = setup(doc);
    store.getState().setSelection(["n0"]);
    drag([0.5, 0.5], [50.5, 300.5], { alt: true, mod: true });
    expect(Object.keys(s().doc.nodes)).toHaveLength(20_000);
    expect(s().doc.nodes.n0).toMatchObject({ x: 0, y: 0 });
    expect(s().revision).toBe(0);
  });

  it("吸着のしきい値は画面 px (倍率 2 では 3 ページ px)", () => {
    // r0 (10×10) の左を 86 にする → 右 96 から f の左 100 まで 4 ページ px (中心と左は遠い)
    const one = setup(sampleDocument(), 1);
    one.drag([5, 5], [91, 5]);
    expect(one.s().doc.nodes.r0).toMatchObject({ x: 90 }); // 倍率 1 では 4 画面 px なので吸着
    const two = setup(sampleDocument(), 2);
    two.drag([5, 5], [91, 5]);
    expect(two.s().doc.nodes.r0).toMatchObject({ x: 86 }); // 倍率 2 では 8 画面 px なので吸着しない
  });

  it("Shift で固定した向きには吸着しない", () => {
    const { drag, s } = setup();
    // 縦に 2 だけずらす (f の上端 50 まで 8 → 吸着の範囲外になるよう x を大きく動かす)
    drag([120, 70], [170, 62], { shift: true });
    expect(s().doc.nodes.r1).toMatchObject({ y: 10 });
  });
});

describe("リサイズの細則", () => {
  it("動かす辺を吸着し、そろった線を出す。Cmd/Ctrl で吸着しない", () => {
    const { click, down, move, up, s } = setup();
    click(120, 70);
    down(130, 80);
    move(138, 88); // 右 138 → grp の左 140、下 88 → grp の上 90
    expect(s().doc.nodes.r1).toMatchObject({ width: 30, height: 30 });
    const guides = getSelectOverlay().guides;
    expect(guides.some((g) => g.axis === "x" && g.pos === 140)).toBe(true);
    expect(guides.some((g) => g.axis === "y" && g.pos === 90)).toBe(true);
    move(138, 88, { mod: true });
    expect(s().doc.nodes.r1).toMatchObject({ width: 28, height: 28 });
    expect(getSelectOverlay().guides).toEqual([]);
    up(138, 88, { mod: true });
  });

  it("画像の縦横比の固定は、選択が画像と埋め込み SVG だけのとき (混ざったら固定しない)", () => {
    const doc = withNodes(createImage("a1", { id: "img", x: 0, y: 200, width: 100, height: 50 }));
    const { store, drag, s } = setup(doc);
    store.getState().setSelection(["img", "r0"]); // 外接矩形 (0..100, 0..250)
    drag([100, 250], [200, 260], { mod: true });
    const img = s().doc.nodes.img!;
    expect(img.type === "image" && img.width / img.height).not.toBeCloseTo(2);
  });

  it("小さい選択 (画面で 32 px 未満) は辺の内側をハンドルにしない", () => {
    const { click, drag, s } = setup();
    click(120, 70); // r1 は 20×20
    drag([127, 70], [137, 70], { mod: true }); // 右辺の 3 px 内側
    expect(s().doc.nodes.r1).toMatchObject({ x: 20, width: 20 });
  });

  it("ハンドルを動かさずに押して離すと、下にあるものをクリックしたことにする", () => {
    const { click, s } = setup(sampleDocument(), 2);
    click(120, 70);
    click(131, 81); // r1 の右下の角のハンドル (外側)。下は f の何もない場所
    expect(s().selection).toEqual([]);
    expect(s().revision).toBe(0);
  });
});

describe("線の端点の細則", () => {
  const lineDoc = () => withNodes(createLine({ id: "ln", x1: 0, y1: 500, x2: 100, y2: 500 }));

  it("Shift で 45° 刻み、Alt で中点を固定", () => {
    const { click, drag, s } = setup(lineDoc());
    click(50, 500);
    drag([100, 500], [150, 640], { shift: true, mod: true }); // 43° → 45°
    const ln = s().doc.nodes.ln!;
    expect(ln.type === "line" && ln.x2 - ln.x1).toBe(ln.type === "line" ? ln.y2 - ln.y1 : NaN);
    s().undo();
    drag([100, 500], [110, 510], { alt: true, mod: true });
    expect(s().doc.nodes.ln).toMatchObject({ x1: -10, y1: 490, x2: 110, y2: 510 });
  });

  it("端点を吸着する。§3.5 の範囲を超える位置へは動かさない", () => {
    const { click, down, move, up, s } = setup(lineDoc());
    click(50, 500);
    down(100, 500);
    move(103, 498); // f の左 100 へ
    expect(s().doc.nodes.ln).toMatchObject({ x2: 100, y2: 498 });
    move(2_000_000, 498);
    up(2_000_000, 498);
    expect(s().doc.nodes.ln).toMatchObject({ x2: 100, y2: 498 });
  });
});

describe("スコープの frame の範囲選択", () => {
  it("切り抜かれて見えない子は選ばない。見えている部分が重なれば選ぶ", () => {
    const partly = updateNode(sampleDocument(), "r3", { x: 95 }); // 395..405 (見えるのは 400 まで)
    const a = setup(partly);
    a.store.getState().setScope("f2");
    a.drag([398, 240], [420, 160]);
    expect(a.s().selection).toEqual(["r3"]);
    const hidden = updateNode(sampleDocument(), "r3", { x: 150 }); // 450..460 (すべて外)
    const b = setup(hidden);
    b.store.getState().setScope("f2");
    b.drag([398, 240], [470, 150]);
    expect(b.s().selection).toEqual([]);
    expect(b.s().scopeId).toBe("f2");
  });
});
