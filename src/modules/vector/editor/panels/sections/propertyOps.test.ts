import { describe, expect, it } from "vitest";

import { getLocalBounds } from "../../model/geometry";
import { CANVAS_LIMITS } from "../../model/limits";
import { deepFreeze, sampleDocument } from "../../model/testing";
import { MIXED } from "../fields/values";
import { FRAME_PRESETS, DEFAULT_FRAME_PRESET, findFramePresetBySize } from "./framePresets";
import { createText } from "../../model/create";
import { insertNode } from "../../model/structure";
import { geometryWithinLimits } from "../limits";
import { readPosition, setBoundsField, setLineField } from "./propertyOps";

const doc = deepFreeze(sampleDocument());

describe("readPosition", () => {
  it("1 個なら親の座標系の値", () => {
    expect(readPosition(doc, ["r1"])).toEqual({
      mode: "box",
      values: { x: 10, y: 10, width: 20, height: 20 },
    });
  });

  it("group は外接矩形 (子から求める)", () => {
    // r2 (50,60) 10×10 と l1 (40,40)–(80,40)
    expect(readPosition(doc, ["grp"])?.values).toEqual({ x: 40, y: 40, width: 40, height: 30 });
  });

  it("線だけなら始点と終点", () => {
    expect(readPosition(doc, ["l1"])).toEqual({
      mode: "line",
      values: { x1: 40, y1: 40, x2: 80, y2: 40 },
    });
  });

  it("値が違う欄は混在。祖先も選ばれているノードは除く", () => {
    expect(readPosition(doc, ["r1", "r3"])?.values).toEqual({
      x: MIXED,
      y: MIXED,
      width: MIXED,
      height: MIXED,
    });
    expect(readPosition(doc, ["r2", "r3"])?.values).toMatchObject({ width: 10, height: 10 });
    expect(readPosition(doc, ["f2", "r3"])?.values).toEqual({
      x: 200,
      y: 100,
      width: 100,
      height: 100,
    });
    expect(readPosition(doc, [])).toBeNull();
  });
});

describe("setBoundsField", () => {
  it("X / Y は外接矩形の左上をその値にする (group は子ごと動く)", () => {
    const next = setBoundsField(doc, ["grp"], "x", 0);
    expect(getLocalBounds(next, "grp")).toMatchObject({ x: 0, y: 40 });
    expect(next.nodes.r2).toMatchObject({ x: 10, y: 60 });
    expect(next.nodes.l1).toMatchObject({ x1: 0, x2: 40 });
  });

  it("複数選択はそれぞれに当てる", () => {
    const next = setBoundsField(doc, ["r1", "r0"], "y", 7);
    expect(next.nodes.r1).toMatchObject({ y: 7 });
    expect(next.nodes.r0).toMatchObject({ y: 7 });
  });

  it("W / H は左上を保って大きさを変え、整数に丸める", () => {
    const next = setBoundsField(doc, ["grp"], "width", 81);
    expect(getLocalBounds(next, "grp")).toEqual({ x: 40, y: 40, width: 81, height: 30 });
    expect(Number.isInteger((next.nodes.r2 as { x: number }).x)).toBe(true);
    const frame = setBoundsField(doc, ["f"], "height", 10);
    expect(frame.nodes.f).toMatchObject({ height: 10 });
    expect(frame.nodes.r1).toBe(doc.nodes.r1); // frame の子は動かさない
  });

  it("大きさ 0 からでも値をそのまま当てて戻せる", () => {
    const flat = setBoundsField(doc, ["r1"], "width", 0);
    expect(flat.nodes.r1).toMatchObject({ x: 10, width: 0 });
    const back = setBoundsField(flat, ["r1"], "width", 25);
    expect(back.nodes.r1).toMatchObject({ x: 10, width: 25, height: 20 });
    const tall = setBoundsField(setBoundsField(doc, ["f"], "height", 0), ["f"], "height", 30);
    expect(tall.nodes.f).toMatchObject({ y: 50, height: 30 });
    expect(tall.nodes.r1).toBe(doc.nodes.r1);
  });

  it("大きさ 0 のテキストは resizeNodes と同じ規則で大きさの決め方を変える", () => {
    const withText = insertNode(doc, createText({ id: "t1", width: 0, height: 0 }), {
      kind: "page",
      id: "p1",
    });
    const wide = setBoundsField(withText, ["t1"], "width", 120);
    // auto-height になり、高さは折り返した結果 (空の本文は 1 行 = 16 × 1.4 を切り上げて 23) に求め直す
    expect(wide.nodes.t1).toMatchObject({ width: 120, height: 23, sizing: "auto-height" });
    const tall = setBoundsField(withText, ["t1"], "height", 40);
    expect(tall.nodes.t1).toMatchObject({ width: 0, height: 40, sizing: "fixed" });
  });

  it("同じ値なら同じ文書、範囲の外へ出るなら変えない", () => {
    expect(setBoundsField(doc, ["r1"], "x", 10)).toBe(doc);
    // group の左端を上限へ動かすと、右側の子が上限を超える
    expect(setBoundsField(doc, ["grp"], "x", CANVAS_LIMITS.maxCoordinate)).toBe(doc);
    expect(geometryWithinLimits(doc, ["f"])).toBe(true);
  });
});

describe("setLineField", () => {
  it("線の端点だけを変える", () => {
    const next = setLineField(doc, ["l1", "r1"], "y2", 90);
    expect(next.nodes.l1).toMatchObject({ y1: 40, y2: 90 });
    expect(next.nodes.r1).toBe(doc.nodes.r1);
    expect(setLineField(doc, ["l1"], "x1", 40)).toBe(doc);
    expect(setLineField(doc, ["l1"], "x1", CANVAS_LIMITS.maxCoordinate + 1)).toBe(doc);
  });
});

describe("framePresets", () => {
  it("§5.6 の 11 件で、ID は重ならない", () => {
    expect(FRAME_PRESETS).toHaveLength(11);
    expect(new Set(FRAME_PRESETS.map((p) => p.id)).size).toBe(11);
    expect(DEFAULT_FRAME_PRESET).toMatchObject({ name: "iPhone", width: 393, height: 852 });
    expect(findFramePresetBySize(1200, 630)?.name).toBe("OGP 画像");
    expect(findFramePresetBySize(1, 1)).toBeUndefined();
  });
});
