import { describe, expect, it } from "vitest";

import { CANVAS_LIMITS } from "../../model/limits";
import type { GradientStop, LinearGradientPaint, SolidPaint } from "../../model/types";
import {
  addGradientStop,
  convertPaint,
  linearAngle,
  removeGradientStop,
  updateGradientStop,
  withLinearAngle,
} from "./paint";

const solid: SolidPaint = { type: "solid", color: "#FF0000", opacity: 0.5 };
const stops: GradientStop[] = [
  { offset: 0, color: "#000000", opacity: 1 },
  { offset: 1, color: "#FFFFFF", opacity: 1 },
];
const linear: LinearGradientPaint = {
  type: "linear",
  stops,
  from: { x: 0, y: 0.5 },
  to: { x: 1, y: 0.5 },
};

describe("convertPaint", () => {
  it("同じ種類はそのまま", () => {
    expect(convertPaint(solid, "solid")).toBe(solid);
    expect(convertPaint(null, "none")).toBeNull();
  });
  it("なし → 単色は既定の色", () => {
    expect(convertPaint(null, "solid")).toEqual({ type: "solid", color: "#D9D9D9", opacity: 1 });
  });
  it("単色 → グラデーションは同じ色から透明へ", () => {
    expect(convertPaint(solid, "linear")).toEqual({
      type: "linear",
      stops: [
        { offset: 0, color: "#FF0000", opacity: 0.5 },
        { offset: 1, color: "#FF0000", opacity: 0 },
      ],
      from: { x: 0, y: 0.5 },
      to: { x: 1, y: 0.5 },
    });
    expect(convertPaint(solid, "radial")).toMatchObject({
      type: "radial",
      center: { x: 0.5, y: 0.5 },
      radius: 0.5,
    });
  });
  it("グラデーション同士は停止点を引き継ぎ、単色へは最初の停止点", () => {
    expect(convertPaint(linear, "radial")).toMatchObject({ type: "radial", stops });
    expect(convertPaint(linear, "solid")).toEqual({
      type: "solid",
      color: "#000000",
      opacity: 1,
    });
    expect(convertPaint(linear, "none")).toBeNull();
  });
});

describe("停止点", () => {
  it("いちばん広い隙間の中央に足す", () => {
    const added = addGradientStop([...stops, { offset: 0.2, color: "#FF0000", opacity: 1 }]);
    expect(added?.map((s) => s.offset)).toEqual([0, 0.2, 0.6, 1]);
    expect(added?.[2]?.color).toBe("#FF0000");
  });
  it("上限では足せず、下限では消せない", () => {
    const full = Array.from({ length: CANVAS_LIMITS.maxGradientStops }, (_, i) => ({
      offset: i / 20,
      color: "#000000",
      opacity: 1,
    }));
    expect(addGradientStop(full)).toBeNull();
    expect(removeGradientStop(stops, 0)).toBeNull();
    expect(removeGradientStop([...stops, stops[0]!], 2)).toEqual(stops);
  });
  it("位置を変えたら昇順に並べ直す", () => {
    const next = updateGradientStop(stops, 0, { offset: 1 });
    // 同じ位置は元の順を保つ
    expect(next.map((s) => s.color)).toEqual(["#000000", "#FFFFFF"]);
    const moved = updateGradientStop([stops[0]!, { ...stops[1]!, offset: 0.5 }], 0, {
      offset: 0.8,
    });
    expect(moved.map((s) => s.color)).toEqual(["#FFFFFF", "#000000"]);
    expect(updateGradientStop(stops, 1, { color: "#123456" })[1]?.color).toBe("#123456");
  });
});

describe("線形の向き", () => {
  it("左から右が 0°、上から下が 90°", () => {
    expect(linearAngle(linear)).toBe(0);
    const down = withLinearAngle(linear, 90)!;
    expect(down.from).toEqual({ x: 0.5, y: 0 });
    expect(down.to).toEqual({ x: 0.5, y: 1 });
    expect(linearAngle(down)).toBe(90);
    expect(linearAngle(withLinearAngle(linear, -90)!)).toBe(270);
  });
  it("範囲を超える向きは当てない", () => {
    const far: LinearGradientPaint = { ...linear, from: { x: 99, y: 0 }, to: { x: 100, y: 0 } };
    expect(withLinearAngle(far, 0)).not.toBeNull();
    expect(
      withLinearAngle({ ...linear, from: { x: 0, y: 0 }, to: { x: 200, y: 0 } }, 0),
    ).toBeNull();
  });
});
