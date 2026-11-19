import { describe, expect, it } from "vitest";
import { applyToPoint } from "../geometry/matrix";
import {
  createBoolean,
  createFrame,
  createGroup,
  createLine,
  createPath,
  createRect,
  createText,
} from "./create";
import { getNodeCorners, getPageBounds, nodePageMatrix, pageRotation } from "./geometry";
import {
  canFlip,
  flipNodes,
  roundRotation,
  rotateNodes,
  rotationCenter,
  setNodesRotation,
  snapRotationDelta,
  snapRotationTo,
} from "./rotate";
import { deepFreeze } from "./testing";
import type { CanvasDocument, CanvasNode, PathNode, RectNode } from "./types";

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return deepFreeze({
    pages: [{ id: "p1", name: "", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  });
}

const close = (value: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(value.x).toBeCloseTo(expected.x, 9);
  expect(value.y).toBeCloseTo(expected.y, 9);
};

describe("回転の値", () => {
  it("(-180, 180] にそろえて小数第 2 位で丸める", () => {
    expect(roundRotation(190)).toBe(-170);
    expect(roundRotation(-180)).toBe(180);
    expect(roundRotation(12.3456)).toBe(12.35);
    expect(roundRotation(-0.001)).toBe(0);
    expect(Object.is(roundRotation(-0.001), 0)).toBe(true);
  });

  it("Shift の 15° 刻み", () => {
    expect(snapRotationDelta(22)).toBe(15);
    expect(snapRotationDelta(-8)).toBe(-15);
    // 結果の角度を 15° の倍数に (今 10° から 22° 回すと 30°)
    expect(snapRotationTo(10, 22)).toBe(20);
  });
});

describe("rotateNodes (§4.11.3)", () => {
  it("1 個の箱は自分の中心のまわりに回り、x y width height は変わらない", () => {
    const doc = docOf([createRect({ id: "r", x: 10, y: 20, width: 40, height: 10 })], ["r"]);
    const center = rotationCenter(doc, ["r"])!;
    expect(center).toEqual({ x: 30, y: 25 });
    const next = rotateNodes(doc, ["r"], 30, center);
    expect(next.nodes.r).toMatchObject({ x: 10, y: 20, width: 40, height: 10, rotation: 30 });
  });

  it("複数選択は外接矩形の中心のまわりに、中心を回して角度を足す", () => {
    const doc = docOf(
      [
        createRect({ id: "a", x: 0, y: 0, width: 10, height: 10 }),
        createRect({ id: "b", x: 90, y: 0, width: 10, height: 10 }),
      ],
      ["a", "b"],
    );
    const center = rotationCenter(doc, ["a", "b"])!;
    expect(center).toEqual({ x: 50, y: 5 });
    const next = rotateNodes(doc, ["a", "b"], 90, center);
    const a = next.nodes.a as RectNode;
    expect(a.rotation).toBe(90);
    close({ x: a.x + 5, y: a.y + 5 }, { x: 50, y: -40 });
    const b = next.nodes.b as RectNode;
    close({ x: b.x + 5, y: b.y + 5 }, { x: 50, y: 50 });
  });

  it("線は端点を回し、group は子を回し、frame は frame だけを回す", () => {
    const doc = docOf(
      [
        createLine({ id: "l", x1: 0, y1: 0, x2: 10, y2: 0 }),
        createGroup(["gr"], { id: "g" }),
        createRect({ id: "gr", x: 0, y: 0, width: 10, height: 10 }),
        createFrame({ id: "f", x: 0, y: 0, width: 100, height: 50, children: ["fc"] }),
        createRect({ id: "fc", x: 5, y: 5, width: 10, height: 10 }),
      ],
      ["l", "g", "f"],
    );
    const line = rotateNodes(doc, ["l"], 90, { x: 0, y: 0 }).nodes.l!;
    expect(line).toMatchObject({ x1: 0, y1: 0, x2: 0, y2: 10 });
    const group = rotateNodes(doc, ["g"], 90, { x: 5, y: 5 });
    expect(group.nodes.gr).toMatchObject({ x: 0, y: 0, rotation: 90 });
    const frame = rotateNodes(doc, ["f"], 45, { x: 50, y: 25 });
    expect(frame.nodes.f).toMatchObject({ x: 0, y: 0, rotation: 45 });
    expect(frame.nodes.fc).toBe(doc.nodes.fc);
  });

  it("回転した frame の中のノードもページ上で同じ角度だけ回る", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 30,
          children: ["r"],
        }),
        createRect({ id: "r", x: 10, y: 10, width: 20, height: 20 }),
      ],
      ["f"],
    );
    const center = rotationCenter(doc, ["r"])!;
    const next = rotateNodes(doc, ["r"], 45, center);
    expect(pageRotation(next, "r")).toBeCloseTo(75, 9);
    expect((next.nodes.r as RectNode).rotation).toBe(45);
    close(rotationCenter(next, ["r"])!, center);
  });

  it("角度 0 は文書をそのまま返す", () => {
    const doc = docOf([createRect({ id: "r" })], ["r"]);
    expect(rotateNodes(doc, ["r"], 0, { x: 0, y: 0 })).toBe(doc);
  });

  it("回転の欄: 各ノードを自分の中心のまわりにそろえる", () => {
    const doc = docOf(
      [
        createRect({ id: "a", rotation: 10 }),
        createRect({ id: "b", rotation: 20 }),
        createLine({ id: "l" }),
      ],
      ["a", "b", "l"],
    );
    const next = setNodesRotation(doc, ["a", "b", "l"], 190);
    expect((next.nodes.a as RectNode).rotation).toBe(-170);
    expect((next.nodes.b as RectNode).rotation).toBe(-170);
    expect(next.nodes.l).toBe(doc.nodes.l);
    expect(setNodesRotation(next, ["a", "b"], -170)).toBe(next);
  });
});

describe("flipNodes (§4.11.6)", () => {
  it("反転できない種類を (子孫に) 含む選択はできない", () => {
    const doc = docOf(
      [
        createRect({ id: "r" }),
        createText({ id: "t" }),
        createGroup(["f"], { id: "g" }),
        createFrame({ id: "f" }),
      ],
      ["r", "t", "g"],
    );
    expect(canFlip(doc, ["r"])).toBe(true);
    expect(canFlip(doc, ["r", "t"])).toBe(false);
    expect(canFlip(doc, ["g"])).toBe(false);
    expect(canFlip(doc, [])).toBe(false);
    expect(flipNodes(doc, ["r", "t"], "horizontal")).toBe(doc);
  });

  it("回転した矩形: 角度は -φ、中心は軸で映し、グラデーションと影を映す", () => {
    const doc = docOf(
      [
        createRect({ id: "a", x: 0, y: 0, width: 20, height: 10, rotation: 30 }),
        createRect({
          id: "b",
          x: 100,
          y: 0,
          width: 20,
          height: 10,
          fill: {
            type: "linear",
            from: { x: 0.2, y: 0.1 },
            to: { x: 0.9, y: 0.6 },
            stops: [
              { offset: 0, color: "#000000", opacity: 1 },
              { offset: 1, color: "#FFFFFF", opacity: 1 },
            ],
          },
          shadow: { x: 3, y: 4, blur: 0, color: "#000000", opacity: 1 },
        }),
      ],
      ["a", "b"],
    );
    const before = getPageBounds(doc, "a")!;
    const bounds = { min: before.x, max: 120 };
    const axis = (bounds.min + bounds.max) / 2;
    const next = flipNodes(doc, ["a", "b"], "horizontal");
    const a = next.nodes.a as RectNode;
    expect(a.rotation).toBe(-30);
    expect(a.x + a.width / 2).toBeCloseTo(2 * axis - 10, 9);
    expect(a.y).toBe(0);
    const b = next.nodes.b as RectNode;
    expect(b.fill).toMatchObject({ from: { x: 0.8, y: 0.1 }, to: { x: 1 - 0.9, y: 0.6 } });
    expect(b.shadow).toMatchObject({ x: -3, y: 4 });
    // 左右反転を 2 回で元に戻る
    const twice = flipNodes(next, ["a", "b"], "horizontal");
    expect((twice.nodes.a as RectNode).rotation).toBe(30);
    expect((twice.nodes.a as RectNode).x).toBeCloseTo(0, 9);
  });

  it("パスは点とハンドルを自分の座標系で映し、箱は変わらない", () => {
    const tri = createPath(
      [
        {
          closed: true,
          points: [
            { x: 0, y: 0, in: null, out: { x: 5, y: 0 }, mirror: "none" },
            { x: 20, y: 0, in: null, out: null, mirror: "none" },
            { x: 0, y: 10, in: null, out: null, mirror: "none" },
          ],
        },
      ],
      { id: "p" },
    );
    const doc = docOf([tri], ["p"]);
    const flipped = flipNodes(doc, ["p"], "horizontal").nodes.p as PathNode;
    expect(flipped).toMatchObject({ x: 0, y: 0, width: 20, height: 10, rotation: 0 });
    expect(flipped.subpaths[0]!.points.map((p) => [p.x, p.y])).toEqual([
      [20, 0],
      [0, 0],
      [20, 10],
    ]);
    expect(flipped.subpaths[0]!.points[0]!.out).toEqual({ x: -5, y: 0 });
    const vertical = flipNodes(doc, ["p"], "vertical").nodes.p as PathNode;
    expect(vertical.subpaths[0]!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 10],
      [20, 10],
      [0, 0],
    ]);
  });

  it("ページ上の見た目が鏡像になる (回転した frame の中でも)", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 50,
          y: 50,
          width: 100,
          height: 100,
          rotation: 30,
          children: ["r"],
        }),
        createRect({ id: "r", x: 10, y: 20, width: 30, height: 10, rotation: 15 }),
      ],
      ["f"],
    );
    const bounds = getPageBounds(doc, "r")!;
    const axis = bounds.x + bounds.width / 2;
    const next = flipNodes(doc, ["r"], "horizontal");
    expect(pageRotation(next, "r")).toBeCloseTo(-45, 9);
    // 元の 4 隅を鏡に映した点は、反転した箱の 4 隅 (左右の順は入れ替わる)
    const before = getNodeCorners(doc, "r")!.map((p) => ({ x: 2 * axis - p.x, y: p.y }));
    const after = getNodeCorners(next, "r")!;
    close(after[0]!, before[1]!);
    close(after[1]!, before[0]!);
    close(after[2]!, before[3]!);
    close(after[3]!, before[2]!);
  });

  it("線は端点、group とブーリアンは子を映す", () => {
    const doc = docOf(
      [
        createLine({ id: "l", x1: 0, y1: 0, x2: 10, y2: 5 }),
        createBoolean("union", ["a"], {
          id: "u",
          shadow: { x: 2, y: 1, blur: 0, color: "#000000", opacity: 1 },
        }),
        createRect({ id: "a", x: 20, y: 0, width: 10, height: 10 }),
      ],
      ["l", "u"],
    );
    const next = flipNodes(doc, ["l", "u"], "horizontal");
    expect(next.nodes.l).toMatchObject({ x1: 30, y1: 0, x2: 20, y2: 5 });
    expect(next.nodes.a).toMatchObject({ x: 0, y: 0 });
    expect(next.nodes.u).toMatchObject({ shadow: { x: -2, y: 1 } });
    // 回転した frame の中でも、映した矩形の行列は鏡像の位置を描く
    expect(applyToPoint(nodePageMatrix(next, "a"), { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});
