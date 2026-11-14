import { describe, expect, it } from "vitest";
import { clickBox, dragBox, dragLine } from "./geometry";

const O = { x: 0, y: 0 };
const plain = { square: false, fromCenter: false };

describe("dragBox", () => {
  it("押した点と今の点を対角にし、整数にする", () => {
    expect(dragBox({ x: 10, y: 20 }, { x: 60.4, y: 50.6 }, O, plain)).toEqual({
      x: 10,
      y: 20,
      width: 50,
      height: 31,
    });
  });

  it("左上へ引いても正の大きさ", () => {
    expect(dragBox({ x: 100, y: 100 }, { x: 40, y: 70 }, O, plain)).toEqual({
      x: 40,
      y: 70,
      width: 60,
      height: 30,
    });
  });

  it("親の座標系に直す", () => {
    expect(dragBox({ x: 110, y: 60 }, { x: 150, y: 90 }, { x: 100, y: 50 }, plain)).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 30,
    });
  });

  it("まっすぐ横や縦に引いたら 1 以上にする", () => {
    expect(dragBox({ x: 0, y: 0 }, { x: 50, y: 0 }, O, plain)).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 1,
    });
    expect(dragBox({ x: 0, y: 0 }, { x: 0, y: -40 }, O, plain)).toEqual({
      x: 0,
      y: -40,
      width: 1,
      height: 40,
    });
  });

  it("Shift で正方形 (大きい方に合わせ、引いた向きを保つ)", () => {
    expect(dragBox({ x: 0, y: 0 }, { x: 30, y: -80 }, O, { ...plain, square: true })).toEqual({
      x: 0,
      y: -80,
      width: 80,
      height: 80,
    });
    // 丸めても正方形
    const box = dragBox(
      { x: 0.3, y: 0 },
      { x: 10.7, y: 3 },
      { x: 0.2, y: 0 },
      {
        ...plain,
        square: true,
      },
    );
    expect(box.width).toBe(box.height);
  });

  it("Alt で押した点を中心にする", () => {
    expect(
      dragBox({ x: 100, y: 100 }, { x: 130, y: 120 }, O, { ...plain, fromCenter: true }),
    ).toEqual({
      x: 70,
      y: 80,
      width: 60,
      height: 40,
    });
    expect(
      dragBox({ x: 100, y: 100 }, { x: 70, y: 110 }, O, { square: true, fromCenter: true }),
    ).toEqual({ x: 70, y: 70, width: 60, height: 60 });
  });

  it("-0 を出さない", () => {
    const box = dragBox({ x: -0.2, y: -0.4 }, { x: -20, y: -20 }, O, plain);
    expect(Object.is(box.x + box.width, 0)).toBe(true);
    expect(Object.is(dragBox({ x: -0.2, y: 0 }, { x: 5, y: 5 }, O, plain).x, 0)).toBe(true);
  });
});

describe("clickBox", () => {
  it("押した点を左上にし、親の座標系の整数にする", () => {
    expect(clickBox({ x: 120.4, y: 80.6 }, { x: 100, y: 50 }, { width: 393, height: 852 })).toEqual(
      { x: 20, y: 31, width: 393, height: 852 },
    );
  });
});

describe("dragLine", () => {
  it("押した点から今の点へ。整数にする", () => {
    expect(
      dragLine({ x: 10, y: 10 }, { x: 50.6, y: 30.2 }, O, { constrain: false, fromCenter: false }),
    ).toEqual({
      x1: 10,
      y1: 10,
      x2: 51,
      y2: 30,
    });
  });

  it("長さ 0 なら null", () => {
    expect(
      dragLine({ x: 10, y: 10 }, { x: 10.3, y: 9.8 }, O, { constrain: false, fromCenter: false }),
    ).toBeNull();
  });

  it("Shift で 45° 刻み", () => {
    expect(
      dragLine({ x: 0, y: 0 }, { x: 100, y: 10 }, O, { constrain: true, fromCenter: false }),
    ).toEqual({
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
    });
    const diagonal = dragLine({ x: 0, y: 0 }, { x: 100, y: 90 }, O, {
      constrain: true,
      fromCenter: false,
    });
    expect(diagonal?.x2).toBe(diagonal?.y2);
  });

  it("Alt で押した点を中点にする", () => {
    expect(
      dragLine(
        { x: 100, y: 100 },
        { x: 130, y: 110 },
        { x: 50, y: 50 },
        {
          constrain: false,
          fromCenter: true,
        },
      ),
    ).toEqual({ x1: 20, y1: 40, x2: 80, y2: 60 });
  });
});
