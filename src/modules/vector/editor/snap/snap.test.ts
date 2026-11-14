import { describe, expect, it } from "vitest";
import { addGuide, updateNode } from "../model/transform";
import { sampleDocument } from "../model/testing";
import {
  alignedGuides,
  collectSnapTargets,
  rectGuides,
  rectSnapLines,
  snapAxis,
  snapMove,
  snapValue,
} from "./snap";

const options = { threshold: 6, gridSize: null };

describe("snapAxis", () => {
  const lines = [
    { pos: 100, start: 0, end: 10 },
    { pos: 108, start: 0, end: 10 },
  ];

  it("しきい値以内でいちばん近い線に合わせる量を返す", () => {
    expect(snapAxis([{ value: 103, grid: true }], lines, 6, null)).toBe(-3);
    expect(snapAxis([{ value: 105, grid: true }], lines, 6, null)).toBe(3);
    expect(snapAxis([{ value: 120, grid: true }], lines, 6, null)).toBeNull();
  });

  it("複数の値 (辺と中心) のうち最も近い組を選ぶ", () => {
    const values = [
      { value: 90, grid: true },
      { value: 99, grid: false },
      { value: 120, grid: true },
    ];
    expect(snapAxis(values, lines, 6, null)).toBe(1);
  });

  it("グリッドは辺だけ吸着する", () => {
    expect(snapAxis([{ value: 13, grid: true }], [], 6, 8)).toBe(3);
    expect(snapAxis([{ value: 13, grid: false }], [], 6, 8)).toBeNull();
    expect(snapAxis([{ value: 13, grid: true }], [], 2, 8)).toBeNull();
  });
});

describe("snapMove / snapValue", () => {
  const targets = { ...rectSnapLines({ x: 100, y: 100, width: 50, height: 50 }) };

  it("左・中心・右と上・中心・下を候補へ吸着する", () => {
    // 左が 103 → 100 へ (中心 118 と右 133 は遠い)、上・中心・下 (52, 67, 82) は吸着なし
    expect(snapMove({ x: 103, y: 52, width: 30, height: 30 }, targets, options)).toEqual({
      dx: -3,
      dy: 0,
    });
    // 中心 (x + 10) が 127 → 125 へ
    expect(snapMove({ x: 117, y: 0, width: 20, height: 20 }, targets, options).dx).toBe(-2);
  });

  it("軸を選べる (Shift で固定した向きだけ)", () => {
    const rect = { x: 103, y: 97, width: 30, height: 40 };
    expect(snapMove(rect, targets, options, { x: true, y: false })).toEqual({ dx: -3, dy: 0 });
    expect(snapMove(rect, targets, options, { x: false, y: true })).toEqual({ dx: 0, dy: 3 });
  });

  it("1 つの値の吸着", () => {
    expect(snapValue(148, targets.x, options)).toBe(2);
    expect(snapValue(160, targets.x, options)).toBe(0);
  });
});

describe("collectSnapTargets", () => {
  it("同じ親の兄弟 (動かすものと非表示を除く) と親 frame、ガイド線", () => {
    let doc = sampleDocument();
    doc = addGuide(doc, "p1", { axis: "x", position: 42 });
    doc = updateNode(doc, "f2", { visible: false });
    const targets = collectSnapTargets(doc, "p1", {
      parents: [{ kind: "node", id: "f" }],
      frames: ["f"],
      exclude: new Set(["r1"]),
    });
    const xs = targets.x.map((line) => line.pos).sort((a, b) => a - b);
    // grp (140..180)、f (100..500)、ガイド線 42。r1 と非表示の f2 は除く
    expect(xs).toEqual([42, 100, 140, 160, 180, 300, 500]);
    const guide = targets.x.find((line) => line.pos === 42);
    expect(guide?.start).toBe(-Infinity);
  });
});

describe("スマートガイド", () => {
  it("そろった線を、動かした矩形と候補をつなぐ長さで返す", () => {
    const lines = [{ pos: 100, start: 0, end: 50 }];
    const rect = { x: 100, y: 80, width: 20, height: 20 };
    expect(alignedGuides("x", [100], lines, rect)).toEqual([
      { axis: "x", pos: 100, start: 0, end: 100 },
    ]);
    expect(alignedGuides("x", [101], lines, rect)).toEqual([]);
  });

  it("ガイド線 (無限の線) は出さない。同じ位置は 1 本にまとめる", () => {
    const lines = [
      { pos: 100, start: -Infinity, end: Infinity },
      { pos: 100, start: 0, end: 10 },
      { pos: 100, start: 200, end: 210 },
    ];
    const rect = { x: 100, y: 50, width: 20, height: 20 };
    expect(alignedGuides("x", [100], lines, rect)).toEqual([
      { axis: "x", pos: 100, start: 0, end: 210 },
    ]);
  });

  it("rectGuides は辺と中心のそろいをすべて返す", () => {
    const targets = rectSnapLines({ x: 0, y: 0, width: 100, height: 100 });
    const guides = rectGuides({ x: 100, y: 40, width: 50, height: 20 }, targets, {
      x: true,
      y: true,
    });
    expect(guides).toEqual([
      { axis: "x", pos: 100, start: 0, end: 100 },
      { axis: "y", pos: 50, start: 0, end: 150 },
    ]);
  });
});
