import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoolean, createRect } from "../model/create";
import { CANVAS_LIMITS } from "../model/limits";
import { getNode, getParent } from "../model/tree";
import type { CanvasDocument, PathNode } from "../model/types";
import { getPathEditSnapshot, resetPathEditSession, selectedPoints } from "../path/editSession";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { pageGeometry } from "./pathEdit/ops";
import { PAGE_ID, pathEditDocument } from "./pathEdit/testing";
import { pathEditTool, resetPathEditTool } from "./pathEditTool";
import { penTool, resetPenTool } from "./penTool";
import type { CanvasKeyEvent, CanvasPointerEvent, ToolContext } from "./types";

type Mods = Partial<Pick<CanvasPointerEvent, "shift" | "alt" | "mod" | "clickCount" | "button">>;

function setup(doc: CanvasDocument = pathEditDocument(), editing: string | null = null) {
  resetPenTool();
  resetPathEditTool();
  resetPathEditSession();
  const store = createEditorStore(doc);
  store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
  if (editing) store.getState().startPathEdit(editing);
  store.getState().setTool("pen");
  const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
  // ツールの切替で、前のツールの onCancel を呼ぶ (キャンバスと同じ)
  store.subscribe((state, previous) => {
    if (state.toolId === previous.toolId) return;
    if (previous.toolId === "pen") penTool.onCancel?.(ctx);
    if (previous.toolId === "pathEdit") pathEditTool.onCancel?.(ctx);
  });
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
    penTool.onPointerDown?.(event(x, y, mods), ctx);
  const move = (x: number, y: number, mods: Mods = {}) =>
    penTool.onPointerMove?.(event(x, y, mods), ctx);
  const hover = (x: number, y: number, mods: Mods = {}) =>
    penTool.onPointerMove?.(event(x, y, { ...mods, clickCount: 0 }), ctx);
  const up = (x: number, y: number, mods: Mods = {}) =>
    penTool.onPointerUp?.(event(x, y, mods), ctx);
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
    penTool.onKeyDown?.(
      { key: k, shift: false, alt: false, mod: false, repeat: false, ...mods },
      ctx,
    );
  const s = () => store.getState();
  const paths = () =>
    Object.values(s().doc.nodes).filter(
      (n): n is PathNode => n.type === "path" && !["sq", "rot", "open", "inner"].includes(n.id),
    );
  /** 点のページ座標 */
  const pagePoints = (id: string, subpath = 0) =>
    pageGeometry(s().doc, id)!.points[subpath]!.map((p) => p.at);
  return { store, ctx, down, move, hover, up, click, drag, key, s, paths, pagePoints };
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};

beforeEach(() => {
  resetPenTool();
  resetPathEditTool();
  resetPathEditSession();
});

describe("新しいパス", () => {
  it("クリックで角の点を置き、Enter で開いたまま終える。2 点目から 1 点が履歴 1 件", () => {
    const t = setup();
    t.click(700, 100);
    expect(t.paths()).toHaveLength(0);
    expect(t.s().revision).toBe(0);
    t.click(800.123, 150.456);
    expect(t.paths()).toHaveLength(1);
    expect(t.s().revision).toBe(1);
    t.click(750, 250);
    expect(t.s().revision).toBe(2);
    expect(t.key("Enter")).toBe(true);
    const [path] = t.paths();
    expect(path).toMatchObject({
      name: "パス",
      fill: null,
      stroke: { color: "#000000", width: 1 },
      rotation: 0,
    });
    expect(path!.subpaths).toEqual([
      {
        closed: false,
        points: [
          { x: 0, y: 0, in: null, out: null, mirror: "none" },
          {
            x: expect.closeTo(100.12, 9),
            y: expect.closeTo(50.46, 9),
            in: null,
            out: null,
            mirror: "none",
          },
          { x: 50, y: 150, in: null, out: null, mirror: "none" },
        ],
      },
    ]);
    expect(path).toMatchObject({ x: 700, y: 100 });
    expect(t.s()).toMatchObject({ toolId: "select", selection: [path!.id], revision: 2 });
    expect(getPathEditSnapshot().pen).toBeNull();
  });

  it("点を 1 個しか置かずに終えたら何も残さない", () => {
    const t = setup();
    t.click(700, 100);
    expect(t.key("Escape")).toBe(true);
    expect(t.paths()).toHaveLength(0);
    expect(t.s()).toMatchObject({ toolId: "select", revision: 0, canUndo: false });
  });

  it("ドラッグで滑らかな点 (ドラッグが out、反対が in、angle-length)", () => {
    const t = setup();
    t.drag([700, 100], [700, 130]);
    t.drag([800, 100], [830, 100]);
    t.key("Enter");
    const [path] = t.paths();
    const [a, b] = path!.subpaths[0]!.points;
    expect(a).toMatchObject({ out: { x: 0, y: 30 }, in: { x: 0, y: -30 }, mirror: "angle-length" });
    expect(b).toMatchObject({ out: { x: 30, y: 0 }, in: { x: -30, y: 0 }, mirror: "angle-length" });
    expect(t.s().revision).toBe(1);
  });

  it("Shift で前の点から 45° 刻みに固定する", () => {
    const t = setup();
    t.click(700, 100);
    t.click(790, 110, { shift: true });
    t.click(850, 170, { shift: true });
    t.key("Enter");
    const id = t.paths()[0]!.id;
    const [, b, c] = t.pagePoints(id);
    near(b!, { x: 790, y: 100 });
    // (60, 70) を 45° の向きへ射影: 長さ 130 / √2、各成分 65
    near(c!, { x: 855, y: 165 });
  });

  it("描き始めの点をクリックすると閉じて終える (履歴 1 件)", () => {
    const t = setup();
    t.click(700, 100);
    t.click(800, 100);
    t.click(800, 200);
    t.click(701, 101);
    const [path] = t.paths();
    expect(path!.subpaths[0]).toMatchObject({ closed: true });
    expect(path!.subpaths[0]!.points).toHaveLength(3);
    expect(t.s()).toMatchObject({ toolId: "select", selection: [path!.id], revision: 3 });
  });

  it("閉じるときのドラッグで描き始めの点を滑らかにする", () => {
    const t = setup();
    t.click(700, 100);
    t.click(800, 100);
    t.click(800, 200);
    t.drag([700, 100], [700, 80]);
    const first = t.paths()[0]!.subpaths[0]!.points[0]!;
    expect(first).toMatchObject({
      out: { x: 0, y: -20 },
      in: { x: 0, y: 20 },
      mirror: "angle-length",
    });
  });

  it("最後の点をもう一度クリックすると開いたまま終える (重なった点を足さない)", () => {
    const t = setup();
    t.click(700, 100);
    t.click(800, 100);
    t.click(800, 100);
    expect(t.paths()[0]!.subpaths[0]!.points).toHaveLength(2);
    expect(t.s().toolId).toBe("select");
  });

  it("予定の線のためのポインターを覚える (Shift で固定)", () => {
    const t = setup();
    t.click(700, 100);
    t.hover(790, 110, { shift: true });
    expect(getPathEditSnapshot().pen?.pointer).toEqual({ x: 790, y: 100 });
  });

  it("Backspace は最後の点を消す。2 点のパスは消して最初の点だけに戻る", () => {
    const t = setup();
    t.click(700, 100);
    t.click(800, 100);
    t.click(800, 200);
    expect(t.key("Backspace")).toBe(true);
    expect(t.paths()[0]!.subpaths[0]!.points).toHaveLength(2);
    expect(t.key("Backspace")).toBe(true);
    expect(t.paths()).toHaveLength(0);
    expect(getPathEditSnapshot().pen).toMatchObject({ pathId: null, origin: { x: 700, y: 100 } });
    // 最初の点から描き直せる
    t.click(700, 200);
    expect(t.paths()).toHaveLength(1);
    expect(t.key("Backspace")).toBe(true);
    expect(t.key("Backspace")).toBe(true);
    expect(getPathEditSnapshot().pen).toBeNull();
  });

  it("Undo で消えた点は描きかけから外れ、作ったパスが消えたら最初の点に戻る", () => {
    const t = setup();
    t.click(700, 100);
    t.click(800, 100);
    t.click(800, 200);
    expect(t.key("z", { mod: true })).toBe(false);
    t.s().undo();
    expect(t.paths()[0]!.subpaths[0]!.points).toHaveLength(2);
    t.click(750, 250);
    expect(t.paths()[0]!.subpaths[0]!.points).toHaveLength(3);
    t.s().undo();
    t.s().undo();
    expect(t.paths()).toHaveLength(0);
    // 最初の点だけのときの Cmd/Ctrl+Z はその点を取り消し、文書の Undo には回さない
    expect(t.key("z", { mod: true })).toBe(true);
    expect(getPathEditSnapshot().pen).toBeNull();
    expect(t.s().canUndo).toBe(false);
  });

  it("ドラッグの途中の取消 (onCancel) は今の点だけを取り消して描くのを終える", () => {
    const t = setup();
    t.click(700, 100);
    t.click(800, 100);
    t.down(800, 200);
    t.move(820, 220);
    penTool.onCancel?.(t.ctx);
    expect(t.paths()[0]!.subpaths[0]!.points).toHaveLength(2);
    expect(t.s()).toMatchObject({ gestureActive: false, revision: 1 });
    expect(getPathEditSnapshot().pen).toBeNull();
  });

  it("回転した frame の中では frame の子になり、点は frame の座標系で丸める", () => {
    const t = setup();
    t.click(250.004, 450.006);
    t.drag([200, 450], [210, 450]);
    t.key("Enter");
    const [path] = t.paths();
    expect(getParent(t.s().doc, path!.id)).toEqual({ kind: "node", id: "f" });
    const points = t.pagePoints(path!.id);
    // frame の座標系で (50.006, 49.996) → (50.01, 50) に丸める
    near(points[0]!, { x: 250, y: 450.01 });
    near(points[1]!, { x: 200, y: 450 }, 6);
    // ページの右向きのドラッグは、90° 回した frame の座標系では上向き
    const smooth = path!.subpaths[0]!.points[1]!;
    expect(smooth.out!.x).toBeCloseTo(0, 9);
    expect(smooth.out!.y).toBeCloseTo(-10, 9);
  });

  it("ブーリアンのスコープの中では、ブーリアンの親に作る", () => {
    const base = pathEditDocument();
    const page = base.pages[0]!;
    const doc: CanvasDocument = {
      ...base,
      pages: [{ ...page, children: [...page.children, "u"] }],
      nodes: {
        ...base.nodes,
        u: createBoolean("union", ["a", "b"], { id: "u" }),
        a: createRect({ id: "a", x: 700, y: 600, width: 50, height: 50 }),
        b: createRect({ id: "b", x: 720, y: 620, width: 50, height: 50 }),
      },
    };
    const t = setup(doc);
    t.s().setScope("u");
    t.click(710, 610);
    t.click(760, 640);
    t.key("Enter");
    const [path] = t.paths();
    expect(getParent(t.s().doc, path!.id)).toEqual({ kind: "page", id: PAGE_ID });
  });

  it("ノード数の上限で作れないなら何もしない", () => {
    const base = pathEditDocument();
    const nodes = { ...base.nodes };
    const children = [...base.pages[0]!.children];
    for (let i = Object.keys(nodes).length; i < CANVAS_LIMITS.maxNodes; i++) {
      const id = `x${i}`;
      nodes[id] = createRect({ id, x: 2000, y: 2000 });
      children.push(id);
    }
    const doc = { ...base, nodes, pages: [{ ...base.pages[0]!, children }] };
    const t = setup(doc);
    t.click(700, 100);
    expect(getPathEditSnapshot().pen).toBeNull();
  });
});

describe("点の編集の中のペン", () => {
  it("同じパスに輪郭を足し、終えたら点の編集へ戻る", () => {
    const t = setup(pathEditDocument(), "sq");
    expect(t.s()).toMatchObject({ toolId: "pen", editingPathId: "sq" });
    t.click(300, 300);
    t.click(350, 300);
    t.key("Escape");
    expect(t.s()).toMatchObject({ toolId: "pathEdit", editingPathId: "sq", revision: 1 });
    const sq = getNode(t.s().doc, "sq") as PathNode;
    expect(sq.subpaths).toHaveLength(2);
    expect(selectedPoints(t.s().doc, "sq")).toEqual([{ subpath: 1, index: 1 }]);
  });

  it("開いた輪郭の終点から続ける", () => {
    const t = setup(pathEditDocument(), "open");
    t.click(600, 200);
    t.click(500, 200);
    t.key("Enter");
    const open = getNode(t.s().doc, "open") as PathNode;
    expect(open.subpaths).toHaveLength(1);
    expect(t.pagePoints("open").map((p) => [p.x, p.y])).toEqual([
      [500, 100],
      [600, 100],
      [600, 200],
      [500, 200],
    ]);
  });

  it("開いた輪郭の始点から続けると先頭の前へ足す。描き始めの点で閉じる", () => {
    const t = setup(pathEditDocument(), "open");
    t.click(500, 100);
    t.drag([500, 200], [480, 200]);
    const open = getNode(t.s().doc, "open") as PathNode;
    // 先頭の前に足した点: 描く向きの out (左向きのドラッグ) は保存の in
    expect(open.subpaths[0]!.points[0]).toMatchObject({
      in: { x: -20, y: 0 },
      out: { x: 20, y: 0 },
      mirror: "angle-length",
    });
    expect(t.pagePoints("open")[0]).toEqual({ x: 500, y: 200 });
    t.click(600, 200);
    expect((getNode(t.s().doc, "open") as PathNode).subpaths[0]!.closed).toBe(true);
    expect(t.s()).toMatchObject({ toolId: "pathEdit", editingPathId: "open" });
  });

  it("続けた輪郭の Backspace は、描き始めた後に足した点だけを消す", () => {
    const t = setup(pathEditDocument(), "open");
    t.click(600, 200);
    t.click(500, 200);
    t.key("Backspace");
    expect((getNode(t.s().doc, "open") as PathNode).subpaths[0]!.points).toHaveLength(3);
    t.key("Backspace");
    expect((getNode(t.s().doc, "open") as PathNode).subpaths[0]!.points).toHaveLength(3);
    expect(getPathEditSnapshot().pen).toBeNull();
    expect(t.s().toolId).toBe("pen");
  });

  it("線分をクリックすると点を足す", () => {
    const t = setup(pathEditDocument(), "sq");
    t.click(150, 100);
    const sq = getNode(t.s().doc, "sq") as PathNode;
    expect(sq.subpaths[0]!.points).toHaveLength(5);
    expect(selectedPoints(t.s().doc, "sq")).toEqual([{ subpath: 0, index: 1 }]);
    expect(getPathEditSnapshot().pen).toBeNull();
  });

  it("描いていないときの Esc は点の編集へ戻る。キーは点の編集と同じに受ける", () => {
    const t = setup(pathEditDocument(), "sq");
    expect(t.key("c", { mod: true })).toBe(true);
    expect(t.key("Escape")).toBe(true);
    expect(t.s()).toMatchObject({ toolId: "pathEdit", editingPathId: "sq" });
  });
});
