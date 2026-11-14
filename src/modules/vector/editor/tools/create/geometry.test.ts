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

describe("小数の押下点", () => {
  it("dragBox: 押した点を先に整数にし、吸着した辺がずれない", () => {
    // 押した点 (40.5, 400.5)、x = 100 に吸着
    const box = dragBox({ x: 40.5, y: 400.5 }, { x: 100, y: 450 }, O, plain);
    expect(box.x + box.width).toBe(100);
    expect(box.y + box.height).toBe(450);
    // 左上へ
    const back = dragBox({ x: 40.5, y: 400.5 }, { x: 0, y: 350 }, O, plain);
    expect(back).toMatchObject({ x: 0, y: 350 });
    // 親の原点が小数でも
    const inner = dragBox({ x: 140.5, y: 60.25 }, { x: 200, y: 90 }, { x: 100.5, y: 50.25 }, plain);
    expect(inner.x + inner.width).toBe(roundLocal(200, 100.5));
  });

  it("dragLine: Shift の 45° は丸めても 45°", () => {
    expect(
      dragLine({ x: 10.5, y: 10 }, { x: 16.1, y: 15.6 }, O, { constrain: true, fromCenter: false }),
    ).toEqual({ x1: 11, y1: 10, x2: 16, y2: 15 });
    for (let i = 0; i < 50; i++) {
      const start = { x: 3.3 + i * 0.37, y: 7.9 - i * 0.21 };
      const pointer = { x: start.x + 20 + i * 1.13, y: start.y - 18 - i * 0.97 };
      const line = dragLine(
        start,
        pointer,
        { x: 0.5, y: 0.25 },
        { constrain: true, fromCenter: i % 2 === 1 },
      );
      expect(line).not.toBeNull();
      if (line) expect(Math.abs(line.x2 - line.x1)).toBe(Math.abs(line.y2 - line.y1));
    }
  });
});

const roundLocal = (v: number, origin: number) => Math.round(v - origin);

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
