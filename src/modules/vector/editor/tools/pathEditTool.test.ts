import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPath } from "../model/create";
import { CANVAS_LIMITS } from "../model/limits";
import { insertNode } from "../model/structure";
import { getNode } from "../model/tree";
import type { CanvasDocument, PathNode } from "../model/types";
import {
  getPathEditSnapshot,
  resetPathEditSession,
  selectedPoints,
  setSelectedPoints,
} from "../path/editSession";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { enterSelection, escapeSelection } from "./select/actions";
import { getSelectOverlay } from "./select/overlayState";
import { resetSelectTool, selectTool } from "./selectTool";
import { pathEditTool, pathEditToolPhase, resetPathEditTool } from "./pathEditTool";
import { pageGeometry } from "./pathEdit/ops";
import { corner, PAGE_ID, pathEditDocument } from "./pathEdit/testing";
import type { CanvasKeyEvent, CanvasPointerEvent, Tool, ToolContext } from "./types";

type Mods = Partial<Pick<CanvasPointerEvent, "shift" | "alt" | "mod" | "clickCount" | "button">>;

function setup(doc: CanvasDocument = pathEditDocument(), editing: string | null = "sq") {
  resetPathEditTool();
  resetSelectTool();
  resetPathEditSession();
  const store = createEditorStore(doc);
  store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
  if (editing) store.getState().startPathEdit(editing);
  const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
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
  const tool = (): Tool => (store.getState().toolId === "select" ? selectTool : pathEditTool);
  const down = (x: number, y: number, mods: Mods = {}) =>
    tool().onPointerDown?.(event(x, y, mods), ctx);
  const move = (x: number, y: number, mods: Mods = {}) =>
    tool().onPointerMove?.(event(x, y, mods), ctx);
  const up = (x: number, y: number, mods: Mods = {}) =>
    tool().onPointerUp?.(event(x, y, mods), ctx);
  const click = (x: number, y: number, mods: Mods = {}) => {
    down(x, y, mods);
    up(x, y, mods);
  };
  const drag = (from: [number, number], to: [number, number], mods: Mods = {}) => {
    down(from[0], from[1], mods);
    for (let i = 1; i <= 4; i++)
      move(from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4, mods);
    up(to[0], to[1], mods);
  };
  const key = (k: string, mods: Partial<CanvasKeyEvent> = {}) =>
    pathEditTool.onKeyDown?.(
      { key: k, shift: false, alt: false, mod: false, repeat: false, ...mods },
      ctx,
    );
  const s = () => store.getState();
  const node = (id = "sq") => getNode(s().doc, id) as PathNode;
  const points = () => selectedPoints(s().doc, s().editingPathId);
  /** ノードの点のページ座標 */
  const pageOf = (id: string, subpath: number, index: number) => {
    const g = pageGeometry(s().doc, id)!;
    return g.points[subpath]![index]!.at;
  };
  return { store, ctx, down, move, up, click, drag, key, s, node, points, pageOf };
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};

beforeEach(() => {
  resetPathEditTool();
  resetSelectTool();
  resetPathEditSession();
});

describe("入る・出る (§8.7.2)", () => {
  it("パスを選んで Enter で入り、Enter と Esc で出る", () => {
    const { s, store, key } = setup(pathEditDocument(), null);
    s().setSelection(["sq"]);
    expect(enterSelection(store)).toBe(true);
    expect(s()).toMatchObject({ toolId: "pathEdit", editingPathId: "sq" });
    expect(key("Enter")).toBe(true);
    expect(s()).toMatchObject({ toolId: "select", editingPathId: null, selection: ["sq"] });
    enterSelection(store);
    expect(key("Escape")).toBe(true);
    expect(s().editingPathId).toBeNull();
  });

  it("矩形の Enter は点の編集に入らない", () => {
    const { s, store } = setup(pathEditDocument(), null);
    s().setSelection(["r"]);
    expect(enterSelection(store)).toBe(false);
    expect(s().editingPathId).toBeNull();
  });

  it("選択ツールでパスをダブルクリックすると入る。前の編集で選んだ点は残さない", () => {
    const { s, down, up, store } = setup(pathEditDocument(), null);
    setSelectedPoints(s().doc, "sq", [{ subpath: 0, index: 0 }]);
    down(150, 150);
    up(150, 150);
    down(150, 150, { clickCount: 2 });
    expect(s()).toMatchObject({ toolId: "pathEdit", editingPathId: "sq" });
    expect(selectedPoints(store.getState().doc, "sq")).toEqual([]);
  });

  it("Esc の順: 点の編集の終了 → スコープ → 選択の解除", () => {
    const { s, store } = setup();
    expect(escapeSelection(store)).toBe(true);
    expect(s()).toMatchObject({ editingPathId: null, selection: ["sq"] });
    expect(escapeSelection(store)).toBe(true);
    expect(s().selection).toEqual([]);
  });

  it("パスの外の何もない場所をクリックすると出て、選択を外す。別のノードなら選ぶ", () => {
    const { s, click } = setup();
    click(150, 150); // パスの塗りの上: 出ない
    expect(s().editingPathId).toBe("sq");
    click(900, 900);
    expect(s()).toMatchObject({ editingPathId: null, toolId: "select", selection: [] });
    const other = setup();
    other.click(720, 420);
    expect(other.s()).toMatchObject({ editingPathId: null, selection: ["r"] });
  });
});

describe("点の選択", () => {
  it("点を押すと選び、Shift で足す・外す", () => {
    const { click, points } = setup();
    click(100, 100);
    expect(points()).toEqual([{ subpath: 0, index: 0 }]);
    click(200, 100, { shift: true });
    expect(points()).toEqual([
      { subpath: 0, index: 0 },
      { subpath: 0, index: 1 },
    ]);
    click(100, 100, { shift: true });
    expect(points()).toEqual([{ subpath: 0, index: 1 }]);
  });

  it("線分を押すと両端の点を選ぶ。塗りの上をクリックすると外す", () => {
    const { click, points } = setup();
    click(200, 150);
    expect(points()).toEqual([
      { subpath: 0, index: 1 },
      { subpath: 0, index: 2 },
    ]);
    click(150, 150);
    expect(points()).toEqual([]);
  });

  it("範囲選択と Cmd/Ctrl+A。範囲選択は文書を変えず、矩形は離したら消える", () => {
    const { drag, points, key, s } = setup();
    drag([90, 90], [210, 150]);
    expect(points()).toEqual([
      { subpath: 0, index: 0 },
      { subpath: 0, index: 1 },
    ]);
    expect(s()).toMatchObject({ editingPathId: "sq", revision: 0 });
    expect(getSelectOverlay().marquee).toBeNull();
    expect(key("a", { mod: true })).toBe(true);
    expect(points()).toHaveLength(4);
  });
});

describe("点のドラッグ", () => {
  it("選んだ点をハンドルと一緒に動かす。履歴 1 件で、箱を合わせ直す", () => {
    const { drag, node, s, points } = setup();
    drag([200, 200], [230.123, 215]);
    expect(s().revision).toBe(1);
    expect(node()).toMatchObject({ x: 100, y: 100, width: 130.12, height: 115 });
    expect(node().subpaths[0]!.points[2]).toMatchObject({ x: 130.12, y: 115 });
    expect(points()).toEqual([{ subpath: 0, index: 2 }]);
    expect(pathEditToolPhase()).toBe("idle");
  });

  it("回転したパスと回転した frame の中のパスも、点がポインターに付いていく", () => {
    const rot = setup(pathEditDocument(), "rot");
    rot.drag([400, 200], [420, 230]);
    near(rot.pageOf("rot", 0, 1), { x: 420, y: 230 }, 2);
    near(rot.pageOf("rot", 0, 0), { x: 400, y: 100 });
    const inner = setup(pathEditDocument(), "inner");
    inner.drag([250, 450], [260, 440]);
    near(inner.pageOf("inner", 0, 0), { x: 260, y: 440 }, 2);
    near(inner.pageOf("inner", 0, 2), { x: 150, y: 550 });
  });

  it("同じパスのほかの点に吸着する。Cmd/Ctrl では吸着しない", () => {
    const { drag, pageOf } = setup();
    drag([200, 200], [203, 104]);
    near(pageOf("sq", 0, 2), { x: 200, y: 100 });
    const free = setup();
    free.down(200, 200);
    free.move(203, 104, { mod: true });
    free.up(203, 104, { mod: true });
    near(free.pageOf("sq", 0, 2), { x: 203, y: 104 });
  });

  it("Shift で水平・垂直に固定する", () => {
    const free = setup();
    free.drag([200, 200], [240, 210]);
    near(free.pageOf("sq", 0, 2), { x: 240, y: 210 });
    const fixed = setup();
    fixed.drag([200, 200], [240, 210], { shift: true });
    near(fixed.pageOf("sq", 0, 2), { x: 240, y: 200 });
  });

  it("Esc (onCancel) でドラッグを取り消し、文書と点の選択を戻す", () => {
    const { down, move, ctx, s, node, points } = setup();
    const before = node();
    down(200, 200);
    move(250, 260);
    pathEditTool.onCancel?.(ctx);
    expect(node()).toBe(before);
    expect(s()).toMatchObject({ revision: 0, gestureActive: false });
    expect(points()).toEqual([]);
  });

  it("上限を超える位置へは動かさない", () => {
    const { down, move, up, node } = setup();
    down(200, 200);
    move(210, 200);
    move(CANVAS_LIMITS.maxCoordinate + 500, 200);
    up(CANVAS_LIMITS.maxCoordinate + 500, 200);
    expect(node().x + node().width).toBeLessThanOrEqual(CANVAS_LIMITS.maxCoordinate);
    expect(node().width).toBe(110);
  });
});

describe("ハンドル", () => {
  const smoothDoc = () =>
    insertNode(
      pathEditDocument(),
      createPath(
        [
          {
            closed: false,
            points: [
              corner(0, 0),
              { x: 50, y: 0, in: { x: -20, y: 0 }, out: { x: 20, y: 0 }, mirror: "angle-length" },
              corner(100, 50),
            ],
          },
        ],
        { id: "sm", x: 100, y: 300 },
      ),
      { kind: "page", id: PAGE_ID },
    );

  it("ハンドルのドラッグで反対もそろえる。Alt は連動を切る", () => {
    const t = setup(smoothDoc(), "sm");
    t.click(150, 300);
    t.drag([170, 300], [170, 320]);
    expect(t.node("sm").subpaths[0]!.points[1]).toMatchObject({
      out: { x: 20, y: 20 },
      in: { x: -20, y: -20 },
      mirror: "angle-length",
    });
    expect(t.s().revision).toBe(1);
    t.drag([130, 280], [130, 300], { alt: true });
    expect(t.node("sm").subpaths[0]!.points[1]).toMatchObject({
      in: { x: -20, y: 0 },
      out: { x: 20, y: 20 },
      mirror: "none",
    });
  });

  it("Cmd/Ctrl を押しながら点をドラッグするとハンドルを引き出す", () => {
    const t = setup();
    t.drag([100, 200], [100, 230], { mod: true });
    expect(t.node().subpaths[0]!.points[3]).toMatchObject({
      out: { x: 0, y: 30 },
      in: { x: 0, y: -30 },
      mirror: "angle-length",
    });
  });
});

describe("ダブルクリック", () => {
  it("点のダブルクリックで角と滑らかを切り替える", () => {
    const t = setup();
    t.click(200, 100);
    t.down(200, 100, { clickCount: 2 });
    t.up(200, 100, { clickCount: 2 });
    const p = t.node().subpaths[0]!.points[1]!;
    expect(p.mirror).toBe("angle-length");
    expect(p.out).not.toBeNull();
    expect(t.s().revision).toBe(1);
    t.down(t.pageOf("sq", 0, 1).x, t.pageOf("sq", 0, 1).y, { clickCount: 2 });
    expect(t.node().subpaths[0]!.points[1]).toMatchObject({ in: null, out: null, mirror: "none" });
  });

  it("線分のダブルクリックで点を足し、その点を選ぶ", () => {
    const t = setup();
    t.click(150, 200);
    t.down(150, 200, { clickCount: 2 });
    t.up(150, 200, { clickCount: 2 });
    expect(t.node().subpaths[0]!.points).toHaveLength(5);
    expect(t.node().subpaths[0]!.points[3]).toMatchObject({ x: 50, y: 100 });
    expect(t.points()).toEqual([{ subpath: 0, index: 3 }]);
    expect(t.s().revision).toBe(1);
  });
});

describe("キー", () => {
  it("Delete で選んだ点を消す。点がなくなればノードごと消して編集を終える", () => {
    const t = setup();
    t.click(100, 100);
    expect(t.key("Backspace")).toBe(true);
    expect(t.node().subpaths[0]!.points).toHaveLength(3);
    expect(t.s().revision).toBe(1);
    expect(t.key("a", { mod: true })).toBe(true);
    expect(t.key("Delete")).toBe(true);
    expect(getNode(t.s().doc, "sq")).toBeUndefined();
    expect(t.s()).toMatchObject({ editingPathId: null, toolId: "select" });
  });

  it("点を選んでいない Delete はノードを消さない", () => {
    const t = setup();
    expect(t.key("Delete")).toBe(true);
    expect(getNode(t.s().doc, "sq")).toBeDefined();
  });

  it("矢印で 1 px、Shift で 10 px。回転した frame の中でもページの向き", () => {
    const t = setup(pathEditDocument(), "inner");
    t.click(250, 450);
    t.key("ArrowRight");
    near(t.pageOf("inner", 0, 0), { x: 251, y: 450 });
    t.key("ArrowDown", { shift: true });
    near(t.pageOf("inner", 0, 0), { x: 251, y: 460 });
    expect(t.s().revision).toBe(2);
    expect(t.points()).toEqual([{ subpath: 0, index: 0 }]);
  });

  it("ノードの編集のショートカットは受けて何もしない。Undo は点の選択を外して store へ回す", () => {
    const t = setup();
    for (const [k, mods] of [
      ["c", { mod: true }],
      ["d", { mod: true }],
      ["g", { mod: true, shift: true }],
      ["]", {}],
      ["H", { shift: true }],
      ["e", { mod: true }],
      ["o", { mod: true, shift: true }],
      ["Ú", { alt: true, shift: true }],
    ] as const)
      expect(t.key(k, mods)).toBe(true);
    expect(t.key("s", { mod: true })).toBe(false);
    t.drag([200, 200], [220, 200]);
    expect(t.points()).toHaveLength(1);
    expect(t.key("z", { mod: true })).toBe(false);
    expect(getPathEditSnapshot().selected).toEqual([]);
    t.s().undo();
    expect(t.s()).toMatchObject({ editingPathId: "sq", toolId: "pathEdit", revision: 2 });
    expect(t.points()).toEqual([]);
  });

  it("Undo で形が変わったら、選んでいた点は無効になる", () => {
    const t = setup();
    t.drag([200, 200], [220, 200]);
    expect(t.points()).toHaveLength(1);
    t.s().undo();
    expect(t.points()).toEqual([]);
  });
});
