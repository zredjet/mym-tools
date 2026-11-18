/**
 * 選択ツールの回転と変形 (§8.5.3〜§8.5.6、第 2 段階の E)。回転していない文書の操作は selectTool.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyToPoint } from "../geometry/matrix";
import { runShortcut } from "../canvas/shortcuts";
import type { KeyInput } from "../canvas/input";
import {
  createBoolean,
  createFrame,
  createLine,
  createRect,
  createText,
  solidPaint,
} from "../model/create";
import { getNodeCorners, nodePageMatrix } from "../model/geometry";
import { deepFreeze } from "../model/testing";
import type { CanvasDocument, CanvasNode, NodeId, Point } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { flipSelection, nudgeDocument, nudgeSelection } from "./select/actions";
import { getSelectOverlay } from "./select/overlayState";
import { resetSelectTool, selectTool, selectToolPhase } from "./selectTool";
import type { CanvasPointerEvent, ToolContext } from "./types";

type Mods = Partial<Pick<CanvasPointerEvent, "shift" | "alt" | "mod" | "clickCount" | "button">>;

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return deepFreeze({
    pages: [{ id: "p1", name: "", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  });
}

/**
 * - r: 30° 回した矩形 (100, 100, 100×50。中心 (150, 125))
 * - f: 90° 回した frame (400, 100, 200×200。中心 (500, 200))。子 c (20, 20, 40×20) と線 ln (10, 150)-(90, 150)
 * - a, b: 回転していない矩形 (0..50 と 100..150、y 400..450)
 * - tx: 45° 回したテキスト (auto-width)
 */
function rotatedDoc(): CanvasDocument {
  return docOf(
    [
      createRect({ id: "r", x: 100, y: 100, width: 100, height: 50, rotation: 30 }),
      createFrame({
        id: "f",
        x: 400,
        y: 100,
        width: 200,
        height: 200,
        rotation: 90,
        children: ["c", "ln"],
      }),
      createRect({ id: "c", x: 20, y: 20, width: 40, height: 20 }),
      createLine({ id: "ln", x1: 10, y1: 150, x2: 90, y2: 150 }),
      createRect({ id: "a", x: 0, y: 400, width: 50, height: 50 }),
      createRect({ id: "b", x: 100, y: 400, width: 50, height: 50 }),
      createText({
        id: "tx",
        x: 100,
        y: 600,
        width: 30,
        height: 20,
        rotation: 45,
        text: "abc",
        sizing: "auto-width",
      }),
    ],
    ["r", "f", "a", "b", "tx"],
  );
}

function setup(doc: CanvasDocument = rotatedDoc(), zoom = 1) {
  resetSelectTool();
  const store = createEditorStore(doc);
  store.getState().setViewport({ x: 0, y: 0, zoom });
  const setCursor = vi.fn();
  const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor };
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
  const down = (p: Point, mods: Mods = {}) => selectTool.onPointerDown?.(event(p, mods), ctx);
  const move = (p: Point, mods: Mods = {}) => selectTool.onPointerMove?.(event(p, mods), ctx);
  const up = (p: Point, mods: Mods = {}) => selectTool.onPointerUp?.(event(p, mods), ctx);
  /** 直線で動かす (しきい値を越えるよう途中を 4 回) */
  const drag = (from: Point, to: Point, mods: Mods = {}) => {
    down(from, mods);
    for (let i = 1; i <= 4; i++)
      move({ x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, mods);
    up(to, mods);
  };
  const s = () => store.getState();
  return { store, ctx, setCursor, event, down, move, up, drag, s };
}

beforeEach(() => resetSelectTool());

/** ノードの座標系の点 (ページ座標へ写す)。 */
function onNode(doc: CanvasDocument, id: NodeId, local: Point): Point {
  return applyToPoint(nodePageMatrix(doc, id), local);
}

/** `center` のまわりに `point` を `degrees` 回した点。 */
function turn(point: Point, center: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * Math.cos(r) - dy * Math.sin(r),
    y: center.y + dx * Math.sin(r) + dy * Math.cos(r),
  };
}

/** 円弧に沿って回すドラッグ (途中を 6 回)。 */
function rotateDrag(
  t: ReturnType<typeof setup>,
  from: Point,
  center: Point,
  degrees: number,
  mods: Mods = {},
) {
  t.down(from, mods);
  for (let i = 1; i <= 6; i++) t.move(turn(from, center, (degrees * i) / 6), mods);
  t.up(turn(from, center, degrees), mods);
}

const close = (value: Point, expected: Point, digits = 9) => {
  expect(value.x).toBeCloseTo(expected.x, digits);
  expect(value.y).toBeCloseTo(expected.y, digits);
};

describe("回転のハンドル (§8.5.3)", () => {
  it("回転した枠の 4 隅のすぐ外で回転のカーソル、角のハンドルは向きに合わせたカーソル", () => {
    const t = setup();
    t.s().setSelection(["r"]);
    const doc = t.s().doc;
    // 右下の角の外 (枠の座標系で (107, 57)。角から約 10 px)
    t.move(onNode(doc, "r", { x: 107, y: 57 }), { clickCount: 0 });
    expect(t.setCursor).toHaveBeenLastCalledWith(
      expect.stringMatching(/^url\("data:image\/svg\+xml/),
    );
    // 角のハンドルの上: 左上のハンドル (-135°) に 30° を足すと -105° → 上下のカーソルに近い
    t.move(onNode(doc, "r", { x: 2, y: 2 }), { clickCount: 0 });
    expect(t.setCursor).toHaveBeenLastCalledWith("ns-resize");
    // 角から 16 画面 px より遠い所は回転のハンドルではない
    t.move(onNode(doc, "r", { x: 115, y: 65 }), { clickCount: 0 });
    expect(t.setCursor).toHaveBeenLastCalledWith(null);
  });

  it("ドラッグで中心のまわりに回し、角度を重ね描きする。1 回のドラッグが履歴 1 件", () => {
    const t = setup();
    t.s().setSelection(["r"]);
    const center = { x: 150, y: 125 };
    const from = onNode(t.s().doc, "r", { x: 107, y: 57 });
    t.down(from);
    t.move(turn(from, center, 20));
    t.move(turn(from, center, 45));
    expect(getSelectOverlay().angle?.value).toBeCloseTo(75, 6);
    expect(getSelectOverlay().guides).toEqual([]);
    t.up(turn(from, center, 45));
    const r = t.s().doc.nodes.r;
    expect(r).toMatchObject({ width: 100, height: 50 });
    if (r?.type !== "rect") throw new Error("rect でない");
    expect(r.rotation).toBe(75);
    // 中心は動かない (x / y は丸めない)
    close({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, center);
    expect(getSelectOverlay().angle).toBeNull();
    expect(t.s().revision).toBe(1);
    t.s().undo();
    expect(t.s().doc.nodes.r).toMatchObject({ rotation: 30, x: 100, y: 100 });
    expect(t.s().canUndo).toBe(false);
  });

  it("Shift で、1 個は結果の角度を 15° の倍数にする", () => {
    const t = setup();
    t.s().setSelection(["r"]);
    const from = onNode(t.s().doc, "r", { x: 107, y: 57 });
    rotateDrag(t, from, { x: 150, y: 125 }, 20, { shift: true }); // 30 + 20 = 50 → 45
    expect(t.s().doc.nodes.r).toMatchObject({ rotation: 45 });
  });

  it("複数選択は外接矩形の中心のまわりに回し、Shift で回した量を 15° 刻みにする", () => {
    const t = setup();
    t.s().setSelection(["a", "b"]);
    // 外接矩形 (0, 400, 150×50) の右下の外
    const from = { x: 157, y: 457 };
    const center = { x: 75, y: 425 };
    rotateDrag(t, from, center, 37, { shift: true }); // 37 → 30
    const a = t.s().doc.nodes.a;
    if (a?.type !== "rect") throw new Error("rect でない");
    expect(a.rotation).toBe(30);
    close({ x: a.x + 25, y: a.y + 25 }, turn({ x: 25, y: 425 }, center, 30));
    expect(t.s().doc.nodes.b).toMatchObject({ rotation: 30 });
    expect(t.s().revision).toBe(1);
  });

  it("回転した frame の中のノードも、ページ上で同じ量だけ回る", () => {
    const t = setup();
    t.s().setScope("f");
    t.s().setSelection(["c"]);
    const doc = t.s().doc;
    const center = onNode(doc, "c", { x: 20, y: 10 });
    const from = onNode(doc, "c", { x: 47, y: 27 });
    rotateDrag(t, from, center, 30);
    const c = t.s().doc.nodes.c;
    if (c?.type !== "rect") throw new Error("rect でない");
    expect(c.rotation).toBe(30);
    close(onNode(t.s().doc, "c", { x: 20, y: 10 }), center);
  });

  it("onCancel で開始時点に戻し、動かさずに離したら下のものをクリックしたことにする", () => {
    const t = setup();
    t.s().setSelection(["r"]);
    const from = onNode(t.s().doc, "r", { x: 107, y: 57 });
    t.down(from);
    t.move(turn(from, { x: 150, y: 125 }, 30));
    expect(t.s().gestureActive).toBe(true);
    selectTool.onCancel?.(t.ctx);
    expect(t.s().doc.nodes.r).toMatchObject({ rotation: 30 });
    expect(t.s().revision).toBe(0);
    expect(selectToolPhase()).toBe("idle");
    expect(getSelectOverlay().angle).toBeNull();
    // 何もない場所のクリックとして選択を解除する
    t.down(from);
    t.up(from);
    expect(t.s().selection).toEqual([]);
    expect(t.s().revision).toBe(0);
  });

  it("線を 1 本だけ選んだときは回転のハンドルを出さない", () => {
    const t = setup(docOf([createLine({ id: "l", x1: 0, y1: 0, x2: 100, y2: 0 })], ["l"]));
    t.s().setSelection(["l"]);
    t.move({ x: 108, y: 8 }, { clickCount: 0 });
    expect(t.setCursor).not.toHaveBeenCalled();
  });

  it("frame の名前のラベルは、回転のハンドルより先 (左上の角の外にある)", () => {
    const t = setup(
      docOf([createFrame({ id: "g", x: 100, y: 100, width: 200, height: 100 })], ["g"]),
    );
    t.s().setSelection(["g"]);
    // ラベル (frame の左上の上) を押してドラッグすると frame を動かす
    t.drag({ x: 104, y: 92 }, { x: 124, y: 112 }, { mod: true });
    expect(t.s().doc.nodes.g).toMatchObject({ x: 120, y: 120, rotation: 0 });
  });
});

describe("回転した枠のリサイズ (§8.5.4)", () => {
  it("辺のハンドルは自分の向きに伸ばし、反対の辺は動かない。幅と高さだけを丸める", () => {
    const t = setup();
    t.s().setSelection(["r"]);
    const doc = t.s().doc;
    const before = getNodeCorners(doc, "r")!;
    // 右の辺の中央を、自分の x の向きに 20.4 引く
    t.drag(onNode(doc, "r", { x: 100, y: 25 }), onNode(doc, "r", { x: 120.4, y: 25 }));
    const r = t.s().doc.nodes.r;
    expect(r).toMatchObject({ width: 120, height: 50, rotation: 30 });
    const after = getNodeCorners(t.s().doc, "r")!;
    close(after[0]!, before[0]!);
    close(after[3]!, before[3]!);
    expect(t.s().revision).toBe(1);
  });

  it("左の辺を引くと右の辺が動かない。Alt なら中心が動かない", () => {
    const t = setup();
    t.s().setSelection(["r"]);
    const doc = t.s().doc;
    const before = getNodeCorners(doc, "r")!;
    t.drag(onNode(doc, "r", { x: 0, y: 25 }), onNode(doc, "r", { x: -10, y: 25 }));
    expect(t.s().doc.nodes.r).toMatchObject({ width: 110, height: 50 });
    const after = getNodeCorners(t.s().doc, "r")!;
    close(after[1]!, before[1]!);
    close(after[2]!, before[2]!);

    const u = setup();
    u.s().setSelection(["r"]);
    u.drag(onNode(doc, "r", { x: 50, y: 50 }), onNode(doc, "r", { x: 50, y: 60 }), { alt: true });
    const r = u.s().doc.nodes.r;
    if (r?.type !== "rect") throw new Error("rect でない");
    expect(r).toMatchObject({ width: 100, height: 70 });
    close({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, { x: 150, y: 125 });
  });

  it("回転した frame の中の回転していないノードも、frame の向きでリサイズする", () => {
    const t = setup();
    t.s().setScope("f");
    t.s().setSelection(["c"]);
    const doc = t.s().doc;
    // 下の辺を frame の y の向きに 10 引く (ページでは左へ 10)
    t.drag(onNode(doc, "c", { x: 20, y: 20 }), onNode(doc, "c", { x: 20, y: 30 }));
    expect(t.s().doc.nodes.c).toMatchObject({ x: 20, y: 20, width: 40, height: 30, rotation: 0 });
  });

  it("テキストは自分の向きで判定する (横に引くと auto-height)", () => {
    const t = setup();
    t.s().setSelection(["tx"]);
    const doc = t.s().doc;
    t.drag(onNode(doc, "tx", { x: 30, y: 10 }), onNode(doc, "tx", { x: 60, y: 10 }));
    expect(t.s().doc.nodes.tx).toMatchObject({ width: 60, sizing: "auto-height", rotation: 45 });
  });

  it("回転した 1 個のリサイズはスナップしない", () => {
    const doc = docOf(
      [
        createRect({ id: "r", x: 100, y: 100, width: 100, height: 50, rotation: 30 }),
        createRect({ id: "q", x: 0, y: 0, width: 10, height: 10 }),
      ],
      ["r", "q"],
    );
    const t = setup(doc);
    t.s().setSelection(["r"]);
    t.down(onNode(doc, "r", { x: 100, y: 25 }));
    t.move(onNode(doc, "r", { x: 110, y: 25 }));
    expect(getSelectOverlay().guides).toEqual([]);
    t.up(onNode(doc, "r", { x: 110, y: 25 }));
    expect(t.s().doc.nodes.r).toMatchObject({ width: 110 });
  });

  it("複数選択は外接矩形の比例 (回転した子は角度を変えない)", () => {
    const t = setup();
    t.s().setSelection(["a", "b"]);
    // 外接矩形 (0, 400, 150×50) の右の辺を 150 引く (倍率 2)
    t.drag({ x: 150, y: 425 }, { x: 300, y: 425 });
    expect(t.s().doc.nodes.a).toMatchObject({ x: 0, width: 100 });
    expect(t.s().doc.nodes.b).toMatchObject({ x: 200, width: 100 });
  });
});

describe("回転した選択の移動と当たり", () => {
  it("回転した枠の外接矩形の中でも、回転した箱の外の何もない場所は選択を解除する", () => {
    const t = setup();
    t.s().setSelection(["r"]);
    // 外接矩形の左上の隅 (回転した箱の外)
    const bounds = getNodeCorners(t.s().doc, "r")!;
    const minX = Math.min(...bounds.map((p) => p.x));
    const minY = Math.min(...bounds.map((p) => p.y));
    t.down({ x: minX + 1, y: minY + 1 });
    t.up({ x: minX + 1, y: minY + 1 });
    expect(t.s().selection).toEqual([]);
  });

  it("回転した frame の中の線の端点は、frame の座標系で動かす", () => {
    const t = setup();
    t.s().setScope("f");
    t.s().setSelection(["ln"]);
    // 終点 (90, 150) を、ページで下へ 10 (frame の座標系では x の向きに 10)
    const end = applyToPoint(nodePageMatrix(t.s().doc, "f"), { x: 90, y: 150 });
    t.drag(end, { x: end.x, y: end.y + 10 }, { mod: true });
    expect(t.s().doc.nodes.ln).toMatchObject({ x1: 10, y1: 150, x2: 100, y2: 150 });
  });

  it("線の端点を動かしても、動かさない端点は丸めない (Alt なら両方を動かして丸める)", () => {
    const lineDoc = () =>
      docOf([createLine({ id: "l", x1: 35.298, y1: -19.165, x2: 135.4, y2: 40.6 })], ["l"]);
    const t = setup(lineDoc());
    t.s().setSelection(["l"]);
    t.drag({ x: 135.4, y: 40.6 }, { x: 155.4, y: 40.6 }, { mod: true });
    expect(t.s().doc.nodes.l).toMatchObject({ x1: 35.298, y1: -19.165, x2: 155, y2: 41 });

    const u = setup(lineDoc());
    u.s().setSelection(["l"]);
    u.drag({ x: 135.4, y: 40.6 }, { x: 155.4, y: 40.6 }, { mod: true, alt: true });
    // 中点 (85.349, 10.7175) を保って反対の端点も動かし、両方を丸める
    expect(u.s().doc.nodes.l).toMatchObject({ x1: 15, y1: -19, x2: 155, y2: 41 });
  });

  it("ブーリアンの中 (スコープ) では、結果の形の外にある子もクリックで選べる", () => {
    const doc = docOf(
      [
        createBoolean("subtract", ["a", "b"], { id: "s", fill: solidPaint("#000000") }),
        createRect({ id: "a", x: 0, y: 0, width: 100, height: 100 }),
        createRect({ id: "b", x: 25, y: 25, width: 50, height: 50 }),
      ],
      ["s"],
    );
    const t = setup(doc);
    t.s().setScope("s");
    t.down({ x: 50, y: 50 });
    t.up({ x: 50, y: 50 });
    expect(t.s().selection).toEqual(["b"]);
    expect(t.s().scopeId).toBe("s");
  });
});

describe("矢印キー (§8.5.2)", () => {
  it("回転した frame の中では frame の軸に沿って動き、x と y の両方を丸める", () => {
    const store = createEditorStore(rotatedDoc());
    store.getState().setSelection(["c"]);
    nudgeSelection(store, 1, 0);
    expect(store.getState().doc.nodes.c).toMatchObject({ x: 21, y: 20 });
    nudgeSelection(store, 0, 10);
    expect(store.getState().doc.nodes.c).toMatchObject({ x: 21, y: 30 });
  });

  it("回転していない座標系のノードは第 1 段階と同じ。混ざっていればそれぞれの座標系で動かす", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 30,
          children: ["c"],
        }),
        createRect({ id: "c", x: 10.4, y: 10.6, width: 10, height: 10 }),
        createRect({ id: "p", x: 200.4, y: 200.6, width: 10, height: 10 }),
      ],
      ["f", "p"],
    );
    const next = nudgeDocument(doc, "p1", ["c", "p"], 1, 0)!;
    expect(next.nodes.c).toMatchObject({ x: 11, y: 11 });
    // 回転していない座標系は動かした向きだけを丸める
    expect(next.nodes.p).toMatchObject({ x: 201, y: 200.6 });
  });
});

describe("反転 (§8.5.6)", () => {
  const key = (k: string): KeyInput => ({
    key: k,
    code: `Key${k.toUpperCase()}`,
    repeat: false,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
  });

  it("Shift+H は左右、Shift+V は上下に反転する。履歴は 1 件ずつ", () => {
    const store = createEditorStore(rotatedDoc());
    const env = { store, size: { width: 800, height: 600 }, measurer: fixedWidthMeasurer() };
    store.getState().setSelection(["r"]);
    expect(runShortcut(key("H"), env, undefined, true)?.id).toBe("edit.flipHorizontal");
    expect(store.getState().doc.nodes.r).toMatchObject({ rotation: -30 });
    expect(runShortcut(key("V"), env, undefined, true)?.id).toBe("edit.flipVertical");
    expect(store.getState().doc.nodes.r).toMatchObject({ rotation: 30 });
    expect(store.getState().revision).toBe(2);
  });

  it("テキスト・frame を含む選択では何もしない", () => {
    const store = createEditorStore(rotatedDoc());
    store.getState().setSelection(["tx"]);
    expect(flipSelection(store, "horizontal")).toBe(false);
    store.getState().setSelection(["f"]);
    expect(flipSelection(store, "vertical")).toBe(false);
    expect(store.getState().revision).toBe(0);
  });
});
