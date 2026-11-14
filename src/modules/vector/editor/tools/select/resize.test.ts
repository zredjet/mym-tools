import { describe, expect, it } from "vitest";
import { rectSnapLines } from "../../snap/snap";
import { grabOffset, moveLineEnd, resizeRect, type ResizeInput } from "./resize";

const start = { x: 100, y: 100, width: 200, height: 100 };
const input = (patch: Partial<ResizeInput>): ResizeInput => ({
  start,
  handle: "se",
  pointer: { x: 300, y: 200 },
  keepAspect: false,
  fromCenter: false,
  snap: null,
  ...patch,
});

describe("resizeRect", () => {
  it("ハンドルの反対側を固定し、ハンドルの辺をポインターへ動かす", () => {
    expect(resizeRect(input({ pointer: { x: 350, y: 260 } }))).toEqual({
      x: 100,
      y: 100,
      width: 250,
      height: 160,
    });
    expect(resizeRect(input({ handle: "nw", pointer: { x: 80, y: 90 } }))).toEqual({
      x: 80,
      y: 90,
      width: 220,
      height: 110,
    });
    // 辺のハンドルは片方の向きだけ
    expect(resizeRect(input({ handle: "e", pointer: { x: 320, y: 999 } }))).toEqual({
      ...start,
      width: 220,
    });
  });

  it("反対側を越えたら向きを入れ替えた矩形にする", () => {
    expect(resizeRect(input({ handle: "e", pointer: { x: 50, y: 0 } }))).toEqual({
      x: 50,
      y: 100,
      width: 50,
      height: 100,
    });
  });

  it("Alt で中心を固定する", () => {
    expect(resizeRect(input({ pointer: { x: 320, y: 210 }, fromCenter: true }))).toEqual({
      x: 80,
      y: 90,
      width: 240,
      height: 120,
    });
  });

  it("縦横比の固定: 角は変化の大きい向きに合わせる", () => {
    expect(resizeRect(input({ pointer: { x: 400, y: 210 }, keepAspect: true }))).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 150,
    });
    expect(resizeRect(input({ pointer: { x: 310, y: 300 }, keepAspect: true }))).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 200,
    });
    // 左上の角は右下を固定
    expect(
      resizeRect(input({ handle: "nw", pointer: { x: 0, y: 100 }, keepAspect: true })),
    ).toEqual({ x: 0, y: 50, width: 300, height: 150 });
  });

  it("縦横比の固定: 辺は反対の向きを中心から伸ばす", () => {
    expect(resizeRect(input({ handle: "e", pointer: { x: 500, y: 0 }, keepAspect: true }))).toEqual(
      { x: 100, y: 50, width: 400, height: 200 },
    );
  });

  it("縦横比の固定と中心", () => {
    expect(
      resizeRect(input({ pointer: { x: 400, y: 160 }, keepAspect: true, fromCenter: true })),
    ).toEqual({ x: 0, y: 50, width: 400, height: 200 });
  });

  it("縦横比の固定で反対側を越えたら、反対へ伸ばす", () => {
    expect(resizeRect(input({ pointer: { x: 0, y: 50 }, keepAspect: true }))).toEqual({
      x: 0,
      y: 50,
      width: 100,
      height: 50,
    });
  });

  it("幅か高さが 0 なら縦横比を固定しない", () => {
    const flat = { x: 0, y: 0, width: 100, height: 0 };
    expect(
      resizeRect(input({ start: flat, pointer: { x: 150, y: 20 }, keepAspect: true })),
    ).toEqual({ x: 0, y: 0, width: 150, height: 20 });
  });

  it("動かす辺だけを吸着する", () => {
    const snap = {
      targets: rectSnapLines({ x: 0, y: 0, width: 400, height: 203 }),
      options: { threshold: 6, gridSize: null },
    };
    expect(resizeRect(input({ pointer: { x: 397, y: 207 }, snap }))).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 103,
    });
  });

  it("押した位置とハンドルの辺の差", () => {
    expect(grabOffset(start, "se", { x: 297, y: 203 })).toEqual({ x: 3, y: -3 });
    expect(grabOffset(start, "n", { x: 150, y: 98 })).toEqual({ x: 0, y: 2 });
  });
});

describe("moveLineEnd", () => {
  const base = {
    from: { x: 100, y: 0 },
    other: { x: 0, y: 0 },
    constrain: false,
    fromCenter: false,
    snap: null,
  };

  it("端点をポインターへ動かす", () => {
    expect(moveLineEnd({ ...base, pointer: { x: 120, y: 30 } })).toEqual([
      { x: 120, y: 30 },
      { x: 0, y: 0 },
    ]);
  });

  it("Shift で 45° 刻み", () => {
    const [p] = moveLineEnd({ ...base, pointer: { x: 100, y: 90 }, constrain: true });
    expect(p.x).toBeCloseTo(p.y);
    const [q] = moveLineEnd({ ...base, pointer: { x: 100, y: 10 }, constrain: true });
    expect(q.y).toBe(0);
  });

  it("Alt で中点を固定し、反対の端点も動かす", () => {
    expect(moveLineEnd({ ...base, pointer: { x: 110, y: 10 }, fromCenter: true })).toEqual([
      { x: 110, y: 10 },
      { x: -10, y: -10 },
    ]);
  });

  it("吸着する", () => {
    const snap = {
      targets: rectSnapLines({ x: 0, y: 0, width: 150, height: 40 }),
      options: { threshold: 6, gridSize: null },
    };
    expect(moveLineEnd({ ...base, pointer: { x: 147, y: 43 }, snap })[0]).toEqual({
      x: 150,
      y: 40,
    });
  });
});
