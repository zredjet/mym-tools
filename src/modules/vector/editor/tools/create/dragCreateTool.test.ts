import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFrame } from "../../model/create";
import { CANVAS_LIMITS } from "../../model/limits";
import { insertNode } from "../../model/structure";
import { sampleDocument } from "../../model/testing";
import { getParent } from "../../model/tree";
import type { CanvasDocument, CanvasNode } from "../../model/types";
import { fixedWidthMeasurer } from "../../render/testing";
import { createEditorStore } from "../../state/store";
import { TOOLS } from "../registry";
import { getSelectOverlay } from "../select/overlayState";
import type { CanvasPointerEvent, ToolContext } from "../types";
import { createDragTool, type DragCreateTool, type ShapeKind } from "./dragCreateTool";
import { getLastFrameSize, rememberFrameSize, resetLastFrameSize } from "./frameSize";

type Mods = Partial<Pick<CanvasPointerEvent, "shift" | "alt" | "mod" | "clickCount" | "button">>;

/**
 * キャンバス (`useCanvasInput`) と同じく、ツールが変わったら前のツールの `onCancel` を呼ぶ。
 * 作成ツールが自分のハンドラの中で `setTool("select")` を呼んでも、作ったものが残ることを確かめる。
 */
function setup(kind: ShapeKind, doc: CanvasDocument = sampleDocument(), zoom = 1) {
  const store = createEditorStore(doc);
  store.getState().setViewport({ x: 0, y: 0, zoom });
  const tool: DragCreateTool = createDragTool(kind);
  const tools = { ...TOOLS, [kind]: tool };
  const ctx: ToolContext = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
  const cancelSpy = vi.fn();
  store.subscribe((state, previous) => {
    if (state.toolId === previous.toolId) return;
    if (previous.toolId === kind) cancelSpy();
    tools[previous.toolId].onCancel?.(ctx);
  });
  store.getState().setTool(kind);
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
  /** 作ったノード (選択中の 1 個) */
  const created = (): CanvasNode | undefined => {
    const id = s().selection[0];
    return id === undefined ? undefined : s().doc.nodes[id];
  };
  return { store, tool, ctx, down, move, up, drag, s, created, cancelSpy };
}

beforeEach(() => resetLastFrameSize());

describe("ドラッグで作る", () => {
  it("ページ直下に矩形を作り、選んで選択ツールへ戻る。履歴 1 件", () => {
    const { drag, s, created, cancelSpy, store } = setup("rect");
    const before = s().doc;
    drag([600, 400], [680, 460]);
    const node = created();
    expect(node).toMatchObject({ type: "rect", x: 600, y: 400, width: 80, height: 60 });
    expect(getParent(s().doc, node?.id ?? "")).toEqual({ kind: "page", id: "p1" });
    expect(s().toolId).toBe("select");
    expect(cancelSpy).toHaveBeenCalledTimes(1); // setTool で自分の onCancel が呼ばれても残る
    expect(s().gestureActive).toBe(false);
    expect(s().revision).toBe(1);
    store.getState().undo();
    expect(s().doc).toBe(before);
    expect(s().canUndo).toBe(false);
  });

  it("作っている途中から文書に入れて描き、選んでおく", () => {
    const { down, move, s } = setup("ellipse");
    down(600, 400);
    move(601, 401); // しきい値の手前
    expect(s().gestureActive).toBe(false);
    move(650, 450);
    expect(s().gestureActive).toBe(true);
    const id = s().selection[0] ?? "";
    expect(s().doc.nodes[id]).toMatchObject({ type: "ellipse", width: 50, height: 50 });
    expect(s().revision).toBe(0);
  });

  it("frame の上なら frame の子にし、座標は frame の座標系", () => {
    const { drag, s, created } = setup("rect");
    drag([150, 300], [190, 330]);
    const node = created();
    expect(getParent(s().doc, node?.id ?? "")).toEqual({ kind: "node", id: "f" });
    expect(node).toMatchObject({ x: 50, y: 250, width: 40, height: 30 });
    expect(s().scopeId).toBeNull();
  });

  it("入れ子の frame の中なら、その frame の子にしてスコープに入る", () => {
    const { drag, s, created } = setup("frame");
    drag([320, 170], [340, 190]);
    expect(getParent(s().doc, created()?.id ?? "")).toEqual({ kind: "node", id: "f2" });
    expect(s().scopeId).toBe("f2");
  });

  it("frame の外へはみ出しても親は変えず、見た目の位置のまま", () => {
    const { drag, created, s } = setup("rect");
    drag([480, 300], [560, 400]); // f は 100〜500, 50〜350
    const node = created();
    expect(getParent(s().doc, node?.id ?? "")).toEqual({ kind: "node", id: "f" });
    expect(node).toMatchObject({ x: 380, y: 250, width: 80, height: 100 });
  });

  it("スコープの中ならスコープ (group)", () => {
    const { drag, created, s, store } = setup("rect");
    store.getState().setScope("grp");
    drag([150, 95], [170, 115]);
    expect(getParent(s().doc, created()?.id ?? "")).toEqual({ kind: "node", id: "grp" });
    expect(s().scopeId).toBe("grp");
  });

  it("Shift で正方形、Alt で中心から", () => {
    const a = setup("rect");
    a.drag([600, 400], [650, 420], { shift: true });
    expect(a.created()).toMatchObject({ x: 600, y: 400, width: 50, height: 50 });
    const b = setup("ellipse");
    b.drag([600, 400], [630, 420], { alt: true });
    expect(b.created()).toMatchObject({ x: 570, y: 380, width: 60, height: 40 });
  });

  it("線: 押した点から離した点へ。Shift で 45° 刻み", () => {
    const a = setup("line");
    a.drag([600, 400], [700, 410]);
    expect(a.created()).toMatchObject({ type: "line", x1: 600, y1: 400, x2: 700, y2: 410 });
    expect(a.s().toolId).toBe("select");
    const b = setup("line");
    b.drag([600, 400], [700, 410], { shift: true });
    expect(b.created()).toMatchObject({ x1: 600, y1: 400, x2: 700, y2: 400 });
  });

  it("線の長さが 0 なら作らず、ツールも選択も変えない", () => {
    const { down, move, up, s, store } = setup("line");
    store.getState().setSelection(["r0"]);
    down(600, 400);
    move(640, 400);
    move(600.2, 400.1);
    up(600.2, 400.1);
    expect(s().revision).toBe(0);
    expect(s().canUndo).toBe(false);
    expect(s().toolId).toBe("line");
    expect(s().selection).toEqual(["r0"]);
  });
});

describe("スナップ", () => {
  it("兄弟と親の辺に吸着し、スマートガイドを出す。終わったら消す", () => {
    const { down, move, up, created } = setup("rect");
    down(600, 400);
    move(503, 352);
    expect(getSelectOverlay().guides.length).toBeGreaterThan(0);
    up(503, 352);
    expect(created()).toMatchObject({ x: 500, y: 350, width: 100, height: 50 });
    expect(getSelectOverlay().guides).toEqual([]);
  });

  it("Cmd/Ctrl を押している間は吸着しない", () => {
    const { drag, created } = setup("rect");
    drag([600, 400], [503, 352], { mod: true });
    expect(created()).toMatchObject({ x: 503, y: 352, width: 97, height: 48 });
  });

  it("押した点も吸着する", () => {
    const { drag, created } = setup("rect");
    drag([502, 600], [560, 640]);
    expect(created()).toMatchObject({ x: 500, y: 600 });
  });
});

describe("小数の押下点 (100% 以外の倍率)", () => {
  it("吸着した辺がそのまま辺になり、スマートガイドも出る", () => {
    const { down, move, up, created } = setup("rect", sampleDocument(), 2);
    down(540.5, 400.5); // 近くに候補のない所。押した点は整数に丸める
    move(560, 420);
    up(560, 420);
    expect(created()).toMatchObject({ x: 541, y: 401 });
    // 左上へ引いて f の右下 (500, 350) に吸着
    const b = setup("rect", sampleDocument(), 2);
    b.down(540.5, 400.5);
    b.move(520, 380);
    b.move(501.5, 351.5);
    expect(getSelectOverlay().guides.length).toBeGreaterThan(0);
    b.up(501.5, 351.5);
    expect(b.created()).toMatchObject({ x: 500, y: 350, width: 41, height: 51 });
    // 右下へ引いて吸着 (押した点 (40.5, 400.5)、x = 100 は f の左辺)
    const c = setup("rect", sampleDocument(), 2);
    c.down(40.5, 400.5);
    c.move(70, 420);
    c.move(98.5, 420);
    expect(getSelectOverlay().guides.some((g) => g.axis === "x" && g.pos === 100)).toBe(true);
    c.up(98.5, 420);
    const node = c.created();
    expect(node?.type === "rect" && node.x + node.width).toBe(100);
  });

  it("Shift の線は丸めても 45°", () => {
    const { drag, created } = setup("line", sampleDocument(), 2);
    drag([600.5, 600], [606.1, 605.6], { shift: true });
    const line = created();
    expect(line?.type).toBe("line");
    if (line?.type === "line")
      expect(Math.abs(line.x2 - line.x1)).toBe(Math.abs(line.y2 - line.y1));
  });
});

describe("吸着の規則", () => {
  it("Cmd/Ctrl で押したら、押した点も吸着しない", () => {
    const a = setup("rect");
    a.drag([502, 600], [560, 640], { mod: true });
    expect(a.created()).toMatchObject({ x: 502, y: 600 });
  });

  it("Shift の線は吸着しない (近くに候補があっても)", () => {
    // 終点の近くに f の右辺 (x = 500) と下辺 (y = 350)
    const a = setup("line");
    a.drag([600, 450], [503, 353], { shift: true });
    const line = a.created();
    expect(line).toMatchObject({ x1: 600, y1: 450 });
    if (line?.type === "line") {
      expect(line.x2).not.toBe(500);
      expect(Math.abs(line.x2 - 600)).toBe(Math.abs(line.y2 - 450));
    }
    // Shift なしなら吸着する
    const b = setup("line");
    b.drag([600, 450], [503, 353]);
    expect(b.created()).toMatchObject({ x2: 500, y2: 350 });
  });
});

describe("押してから文書が変わったとき", () => {
  it("ドラッグを始める前に Undo されたら、何も作らない", () => {
    const { down, move, up, s, store } = setup("rect");
    // f を 300 px 右へ動かしてから、その f の上で押す
    store.getState().apply((doc) => ({
      ...doc,
      nodes: { ...doc.nodes, f: { ...doc.nodes.f!, x: 400 } as CanvasNode },
    }));
    down(450, 300);
    store.getState().undo();
    const afterUndo = s().doc;
    move(480, 330);
    up(480, 330);
    expect(s().doc).toBe(afterUndo);
    expect(s().gestureActive).toBe(false);
  });

  it("クリックを確定する前に文書が変わったら、何も作らない", () => {
    const { down, up, s, store } = setup("rect");
    store.getState().apply((doc) => ({ ...doc }));
    down(600, 400);
    store.getState().undo();
    const afterUndo = s().doc;
    up(600, 400);
    expect(s().doc).toBe(afterUndo);
    expect(s().toolId).toBe("rect");
  });
});

describe("クリックで作る", () => {
  it("矩形と楕円は 100 × 100 で、押した点を左上にする。履歴 1 件", () => {
    const { down, up, s, created } = setup("rect");
    down(600, 400);
    up(601, 401);
    expect(created()).toMatchObject({ type: "rect", x: 600, y: 400, width: 100, height: 100 });
    expect(s().revision).toBe(1);
    expect(s().toolId).toBe("select");
  });

  it("フレームはプリセットで直前に選んだ大きさ (初回は iPhone)。ドラッグで作った大きさは覚えない", () => {
    const a = setup("frame");
    a.down(600, 400);
    a.up(600, 400);
    expect(a.created()).toMatchObject({ type: "frame", width: 393, height: 852 });
    const b = setup("frame");
    b.drag([2000, 0], [2004, 3]);
    expect(getLastFrameSize()).toEqual({ width: 393, height: 852 });
    rememberFrameSize({ width: 1200, height: 630 });
    const c = setup("frame");
    c.down(600, 400);
    c.up(600, 400);
    expect(c.created()).toMatchObject({ width: 1200, height: 630 });
  });

  it("線はクリックでは作らない (履歴も revision も増えない)", () => {
    const { down, up, s } = setup("line");
    down(600, 400);
    up(600, 400);
    expect(s().revision).toBe(0);
    expect(s().canUndo).toBe(false);
    expect(s().toolId).toBe("line");
  });
});

describe("取消", () => {
  it("ドラッグの途中の onCancel で何も残さない。選択も押す前に戻る", () => {
    const { down, move, tool, ctx, s, store } = setup("rect");
    store.getState().setSelection(["r0"]);
    const before = s().doc;
    down(600, 400);
    move(650, 450);
    expect(s().selection).not.toEqual(["r0"]);
    tool.onCancel?.(ctx);
    expect(s().doc).toBe(before);
    expect(s().selection).toEqual(["r0"]);
    expect(s().gestureActive).toBe(false);
    expect(s().revision).toBe(0);
    expect(s().canUndo).toBe(false);
    expect(getSelectOverlay().guides).toEqual([]);
    // 取り消した後の離すでは何も作らない
    tool.onPointerUp?.(
      {
        page: { x: 650, y: 450 },
        screen: { x: 650, y: 450 },
        button: 0,
        clickCount: 1,
        shift: false,
        alt: false,
        mod: false,
      },
      ctx,
    );
    expect(s().revision).toBe(0);
  });

  it("押してすぐの取消では履歴も revision も増えない", () => {
    const { down, tool, ctx, s } = setup("frame");
    down(600, 400);
    tool.onCancel?.(ctx);
    expect(tool.phase()).toBe("idle");
    expect(s().revision).toBe(0);
  });

  it("ほかが開いたジェスチャーは取り消さない", () => {
    const { tool, ctx, s, store } = setup("rect");
    store.getState().beginGesture();
    tool.onCancel?.(ctx);
    expect(s().gestureActive).toBe(true);
  });

  it("Undo でジェスチャーが閉じられたら、それ以上作らない", () => {
    const { down, move, up, s, store } = setup("rect");
    down(600, 400);
    move(650, 450);
    store.getState().undo();
    move(700, 500);
    up(700, 500);
    expect(s().revision).toBe(0);
    expect(Object.keys(s().doc.nodes)).toHaveLength(8);
  });
});

describe("上限", () => {
  it("深さの上限を超えるなら作らない", () => {
    let doc = sampleDocument();
    let parent = "f";
    for (let depth = 2; depth <= CANVAS_LIMITS.maxDepth; depth++) {
      const id = `deep${depth}`;
      doc = insertNode(doc, createFrame({ id, x: 0, y: 0, width: 400, height: 300 }), {
        kind: "node",
        id: parent,
      });
      parent = id;
    }
    const a = setup("rect", doc);
    a.drag([110, 60], [150, 100]);
    expect(a.s().revision).toBe(0);
    expect(a.s().doc).toBe(doc);
    const b = setup("rect", doc);
    b.down(110, 60);
    b.up(110, 60);
    expect(b.s().revision).toBe(0);
  });

  it("座標の範囲を超えるなら作らない", () => {
    const { drag, s } = setup("rect");
    const x = CANVAS_LIMITS.maxCoordinate + 100;
    drag([x, 0], [x + 50, 50]);
    expect(s().revision).toBe(0);
  });
});
