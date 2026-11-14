import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM } from "../state/types";
import {
  applyWheel,
  clampZoom,
  fitRect,
  pageRectToScreen,
  pageToScreen,
  panBy,
  screenToPage,
  stepZoom,
  viewportTransform,
  visiblePageRect,
  zoomAt,
  type WheelInput,
} from "./viewport";

const SIZE = { width: 800, height: 600 };

describe("座標の変換", () => {
  const viewport = { x: 100, y: -50, zoom: 2 };

  it("画面座標 = (ページ座標 - {x, y}) × zoom", () => {
    expect(pageToScreen(viewport, { x: 110, y: -40 })).toEqual({ x: 20, y: 20 });
    expect(screenToPage(viewport, { x: 20, y: 20 })).toEqual({ x: 110, y: -40 });
  });

  it("往復しても元に戻る", () => {
    const point = { x: 123.25, y: -7.5 };
    expect(screenToPage(viewport, pageToScreen(viewport, point))).toEqual(point);
  });

  it("矩形と見えている範囲", () => {
    expect(pageRectToScreen(viewport, { x: 100, y: -50, width: 10, height: 5 })).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 10,
    });
    expect(visiblePageRect(viewport, SIZE)).toEqual({ x: 100, y: -50, width: 400, height: 300 });
  });

  it("transform は同じ写像になる", () => {
    expect(viewportTransform(viewport)).toBe("matrix(2 0 0 2 -200 100)");
  });
});

describe("ズーム", () => {
  it("ポインターの下のページ座標を動かさない", () => {
    const viewport = { x: 10, y: 20, zoom: 1.5 };
    const anchor = { x: 300, y: 200 };
    const before = screenToPage(viewport, anchor);
    const next = zoomAt(viewport, anchor, 4);
    expect(next.zoom).toBe(4);
    const after = screenToPage(next, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("範囲は MIN_ZOOM〜MAX_ZOOM", () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 1000).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 0).zoom).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("段階のズームイン / アウト", () => {
    expect(stepZoom(1, 1)).toBe(2);
    expect(stepZoom(1, -1)).toBe(0.5);
    expect(stepZoom(0.75, 1)).toBe(1);
    expect(stepZoom(0.75, -1)).toBe(0.5);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe("全体を表示", () => {
  it("矩形が余白の内側に収まり、画面の中央に来る", () => {
    const rect = { x: 100, y: 100, width: 400, height: 200 };
    const viewport = fitRect(rect, SIZE, { padding: 50 });
    expect(viewport.zoom).toBe(1.75); // min(700 / 400, 500 / 200)
    const center = pageToScreen(viewport, { x: 300, y: 200 });
    expect(center.x).toBeCloseTo(400);
    expect(center.y).toBeCloseTo(300);
  });

  it("maxZoom を超えない", () => {
    expect(fitRect({ x: 0, y: 0, width: 10, height: 10 }, SIZE, { maxZoom: 1 }).zoom).toBe(1);
  });

  it("幅や高さが 0 の矩形でも有限の倍率", () => {
    const viewport = fitRect({ x: 0, y: 0, width: 100, height: 0 }, SIZE, { padding: 0 });
    expect(viewport.zoom).toBe(8);
    expect(Number.isFinite(viewport.x)).toBe(true);
  });
});

describe("ホイール", () => {
  const base = { x: 0, y: 0, zoom: 2 };
  const input = (patch: Partial<WheelInput>): WheelInput => ({
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    zoom: false,
    shift: false,
    anchor: { x: 0, y: 0 },
    ...patch,
  });

  it("縦横にスクロールする (画面 px を倍率で割る)", () => {
    expect(applyWheel(base, input({ deltaX: 10, deltaY: 20 }), SIZE)).toEqual({
      x: 5,
      y: 10,
      zoom: 2,
    });
  });

  it("Shift なら縦の量を横へ回す。OS が既に横にしていればそのまま", () => {
    expect(applyWheel(base, input({ deltaY: 20, shift: true }), SIZE)).toEqual({
      x: 10,
      y: 0,
      zoom: 2,
    });
    expect(applyWheel(base, input({ deltaX: 20, shift: true }), SIZE)).toEqual({
      x: 10,
      y: 0,
      zoom: 2,
    });
  });

  it("行単位の delta は px にする", () => {
    expect(applyWheel({ x: 0, y: 0, zoom: 1 }, input({ deltaY: 3, deltaMode: 1 }), SIZE).y).toBe(
      48,
    );
  });

  it("ズームはポインターの位置を中心にし、上へ回すと拡大する", () => {
    const anchor = { x: 200, y: 100 };
    const next = applyWheel(base, input({ deltaY: -10, zoom: true, anchor }), SIZE);
    expect(next.zoom).toBeGreaterThan(2);
    const before = screenToPage(base, anchor);
    const after = screenToPage(next, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(applyWheel(base, input({ deltaY: 10, zoom: true }), SIZE).zoom).toBeLessThan(2);
  });

  it("マウスのホイール 1 目盛り (deltaY 100) でも倍率の変化は抑える", () => {
    const next = applyWheel({ x: 0, y: 0, zoom: 1 }, input({ deltaY: -100, zoom: true }), SIZE);
    expect(next.zoom).toBeCloseTo(Math.exp(0.32));
  });

  it("手のひら: 内容が右へ動くと表示位置は左へ", () => {
    expect(panBy(base, 10, -20)).toEqual({ x: -5, y: 10, zoom: 2 });
  });
});
