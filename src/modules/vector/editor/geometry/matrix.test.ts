import { describe, expect, it } from "vitest";
import {
  applyToPoint,
  applyToVector,
  cosSinDeg,
  decompose,
  determinant,
  flipHorizontal,
  flipVertical,
  IDENTITY,
  invert,
  isIdentity,
  matrix,
  matrixEquals,
  multiply,
  multiplyAll,
  nodeMatrix,
  normalizeRotation,
  rotate,
  scale,
  translate,
} from "./matrix";

function expectPoint(actual: { x: number; y: number }, x: number, y: number, digits = 10) {
  expect(actual.x).toBeCloseTo(x, digits);
  expect(actual.y).toBeCloseTo(y, digits);
}

describe("matrix", () => {
  it("applies translate, rotate and scale", () => {
    expectPoint(applyToPoint(translate(3, 4), { x: 1, y: 2 }), 4, 6);
    // 時計回り (y が下向き): x 軸の向きは y 軸の向きへ
    expect(applyToPoint(rotate(90), { x: 1, y: 0 })).toEqual({ x: 0, y: 1 });
    expect(applyToPoint(rotate(-90), { x: 1, y: 0 })).toEqual({ x: 0, y: -1 });
    expectPoint(applyToPoint(rotate(45), { x: 1, y: 0 }), Math.SQRT1_2, Math.SQRT1_2);
    expectPoint(applyToPoint(scale(2, 3), { x: 1, y: 1 }), 2, 3);
    expectPoint(applyToPoint(scale(2), { x: 1, y: 1 }), 2, 2);
  });

  it("rotates around a center like SVG rotate(θ cx cy)", () => {
    const m = rotate(90, 10, 10);
    expect(applyToPoint(m, { x: 10, y: 10 })).toEqual({ x: 10, y: 10 });
    expect(applyToPoint(m, { x: 20, y: 10 })).toEqual({ x: 10, y: 20 });
    // T(c) R T(-c) と同じ
    const composed = multiplyAll(translate(10, 10), rotate(90), translate(-10, -10));
    expect(matrixEquals(m, composed, 1e-12)).toBe(true);
  });

  it("uses exact values for multiples of 90 degrees", () => {
    for (const deg of [0, 90, 180, 270, -90, -180, 360, 450]) {
      const { cos, sin } = cosSinDeg(deg);
      expect([0, 1, -1]).toContain(cos);
      expect([0, 1, -1]).toContain(sin);
    }
    // 4 回の 90° 回転は恒等そのもの
    const r = rotate(90, 3, 7);
    expect(isIdentity(multiplyAll(r, r, r, r))).toBe(true);
  });

  it("multiplies in SVG order (right is applied first)", () => {
    const m = multiply(translate(10, 0), scale(2));
    expectPoint(applyToPoint(m, { x: 1, y: 1 }), 12, 2);
    const n = multiply(scale(2), translate(10, 0));
    expectPoint(applyToPoint(n, { x: 1, y: 1 }), 22, 2);
    expect(multiplyAll()).toEqual(IDENTITY);
  });

  it("inverts and round-trips points", () => {
    const m = multiplyAll(translate(5, -3), rotate(33, 2, 1), scale(1.5, -0.25));
    const inv = invert(m);
    expect(inv).not.toBeNull();
    const p = { x: 123.456, y: -78.9 };
    const back = applyToPoint(inv!, applyToPoint(m, p));
    expectPoint(back, p.x, p.y, 9);
    expect(isIdentity(multiply(m, inv!), 1e-12)).toBe(true);
  });

  it("returns null for singular matrices", () => {
    expect(invert(scale(0, 1))).toBeNull();
    expect(invert(matrix(1, 2, 2, 4, 5, 6))).toBeNull();
    expect(invert(matrix(0, 0, 0, 0, 1, 1))).toBeNull();
    expect(invert(matrix(1e-9, 0, 0, 1e-9, 0, 0))).not.toBeNull();
  });

  it("applies vectors without translation", () => {
    expect(applyToVector(translate(100, 100), { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(applyToVector(rotate(90, 50, 50), { x: 1, y: 0 })).toEqual({ x: 0, y: 1 });
  });

  it("flips around an axis", () => {
    expect(applyToPoint(flipHorizontal(10), { x: 3, y: 5 })).toEqual({ x: 17, y: 5 });
    expect(applyToPoint(flipVertical(10), { x: 3, y: 5 })).toEqual({ x: 3, y: 15 });
    expect(determinant(flipHorizontal(4))).toBe(-1);
  });

  it("builds the node matrix T(x, y) · R(θ, box center)", () => {
    expect(nodeMatrix(10, 20, 100, 50, 0)).toEqual(translate(10, 20));
    const m = nodeMatrix(10, 20, 100, 50, 90);
    // 箱の中心はノードの座標系で (50, 25)、親の座標系で (60, 45)。回転で動かない
    expect(applyToPoint(m, { x: 50, y: 25 })).toEqual({ x: 60, y: 45 });
    // 左上の角は中心のまわりに 90° 回る: (-50, -25) → (25, -50)
    expect(applyToPoint(m, { x: 0, y: 0 })).toEqual({ x: 85, y: -5 });
    const m180 = nodeMatrix(0, 0, 10, 10, 180);
    expect(applyToPoint(m180, { x: 0, y: 0 })).toEqual({ x: 10, y: 10 });
  });

  it("decomposes translate, rotate, scale and reflection", () => {
    const m = multiplyAll(translate(7, -2), rotate(30), scale(2, 3));
    const d = decompose(m)!;
    expect(d.translateX).toBeCloseTo(7, 12);
    expect(d.translateY).toBeCloseTo(-2, 12);
    expect(d.rotation).toBeCloseTo(30, 10);
    expect(d.scaleX).toBeCloseTo(2, 12);
    expect(d.scaleY).toBeCloseTo(3, 12);
    expect(d.hasSkew).toBe(false);
    expect(d.skewX).toBe(0);

    const flipped = decompose(multiply(rotate(-120), scale(1, -2)))!;
    expect(flipped.rotation).toBeCloseTo(-120, 10);
    expect(flipped.scaleY).toBeCloseTo(-2, 12);
    expect(flipped.hasSkew).toBe(false);

    // 左右反転は 180° 回転 + 上下反転として出る
    const h = decompose(flipHorizontal())!;
    expect(h.rotation).toBe(180);
    expect(h.scaleX).toBe(1);
    expect(h.scaleY).toBe(-1);
  });

  it("detects skew, including rotation with non-uniform scale", () => {
    const skew = decompose(matrix(1, 0, Math.tan(Math.PI / 6), 1, 0, 0))!;
    expect(skew.hasSkew).toBe(true);
    expect(skew.skewX).toBeCloseTo(30, 10);
    // 回転の後に縦横の違う拡大を掛けると傾斜になる
    const mixed = decompose(multiply(scale(2, 1), rotate(30)))!;
    expect(mixed.hasSkew).toBe(true);
    // 回転の前の拡大なら傾斜にならない
    expect(decompose(multiply(rotate(30), scale(2, 1)))!.hasSkew).toBe(false);
    // 分解したものを組み立て直すと元に戻る
    const original = matrix(1.2, 0.3, -0.7, 0.9, 4, 5);
    const parts = decompose(original)!;
    const skewMatrix = matrix(1, 0, Math.tan((parts.skewX * Math.PI) / 180), 1, 0, 0);
    const rebuilt = multiplyAll(
      translate(parts.translateX, parts.translateY),
      rotate(parts.rotation),
      scale(parts.scaleX, parts.scaleY),
      skewMatrix,
    );
    expect(matrixEquals(rebuilt, original, 1e-12)).toBe(true);
  });

  it("returns null when decomposing a collapsed matrix", () => {
    expect(decompose(matrix(0, 0, 1, 1, 0, 0))).toBeNull();
  });

  it("normalizes rotation into (-180, 180]", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(Object.is(normalizeRotation(-0), 0)).toBe(true);
    expect(Object.is(normalizeRotation(-360), 0)).toBe(true);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(-180)).toBe(180);
    expect(normalizeRotation(190)).toBe(-170);
    expect(normalizeRotation(-190)).toBe(170);
    expect(normalizeRotation(540)).toBe(180);
    expect(normalizeRotation(725.5)).toBeCloseTo(5.5, 12);
    expect(normalizeRotation(Number.NaN)).toBeNaN();
  });
});
