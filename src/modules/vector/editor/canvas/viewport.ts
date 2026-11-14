/**
 * 表示位置と倍率の計算 (純関数)。定義は `state/types.ts` の `Viewport`:
 * 画面座標 = (ページ座標 - {x, y}) × zoom。画面座標はキャンバス要素の左上が原点。
 */
import type { Rect } from "../model/geometry";
import type { Point } from "../model/types";
import { MAX_ZOOM, MIN_ZOOM, type Viewport } from "../state/types";

export interface Size {
  width: number;
  height: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function pageToScreen(viewport: Viewport, point: Point): Point {
  return { x: (point.x - viewport.x) * viewport.zoom, y: (point.y - viewport.y) * viewport.zoom };
}

export function screenToPage(viewport: Viewport, point: Point): Point {
  return { x: point.x / viewport.zoom + viewport.x, y: point.y / viewport.zoom + viewport.y };
}

/** ページ座標を画面座標へ写す `transform`。 */
export function viewportTransform(viewport: Viewport): string {
  const { x, y, zoom } = viewport;
  return `matrix(${zoom} 0 0 ${zoom} ${-x * zoom} ${-y * zoom})`;
}

/** ページ座標の矩形を画面座標へ。 */
export function pageRectToScreen(viewport: Viewport, rect: Rect): Rect {
  const topLeft = pageToScreen(viewport, rect);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width * viewport.zoom,
    height: rect.height * viewport.zoom,
  };
}

/** 画面に見えている範囲 (ページ座標)。 */
export function visiblePageRect(viewport: Viewport, size: Size): Rect {
  return {
    x: viewport.x,
    y: viewport.y,
    width: size.width / viewport.zoom,
    height: size.height / viewport.zoom,
  };
}

/** 画面上の点 `anchor` の下にあるページ座標を動かさずに倍率を変える。 */
export function zoomAt(viewport: Viewport, anchor: Point, zoom: number): Viewport {
  const next = clampZoom(zoom);
  const page = screenToPage(viewport, anchor);
  return { x: page.x - anchor.x / next, y: page.y - anchor.y / next, zoom: next };
}

/** 画面座標で `dx` / `dy` だけ内容を動かす (手のひら)。内容が右へ動くと表示位置は左へ動く。 */
export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, x: viewport.x - dx / viewport.zoom, y: viewport.y - dy / viewport.zoom };
}

/** ページ座標の点を画面の中央に置く。 */
export function centerOn(viewport: Viewport, point: Point, size: Size): Viewport {
  return {
    ...viewport,
    x: point.x - size.width / 2 / viewport.zoom,
    y: point.y - size.height / 2 / viewport.zoom,
  };
}

export interface FitOptions {
  /** 画面の端に残す余白 (画面 px) */
  padding?: number;
  /** これより大きくしない (例: 開いたときは 100% まで) */
  maxZoom?: number;
}

/**
 * 矩形が画面に収まる倍率と位置。矩形は画面の中央に来る。
 * 幅や高さが 0 の矩形 (水平な線など) は 1 px として扱う。
 */
export function fitRect(rect: Rect, size: Size, options: FitOptions = {}): Viewport {
  const padding = options.padding ?? 48;
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);
  const zoom = clampZoom(
    Math.min(
      availableWidth / Math.max(1, rect.width),
      availableHeight / Math.max(1, rect.height),
      options.maxZoom ?? MAX_ZOOM,
    ),
  );
  return centerOn(
    { x: 0, y: 0, zoom },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    size,
  );
}

/** ズームイン / アウトの段階 (Cmd/Ctrl + `+` / `-` とツールバー)。 */
export const ZOOM_STEPS: readonly number[] = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];

/** 今の倍率から 1 段階上 (`direction` = 1) か下 (-1) の倍率。段階の間にいれば近い方の段階へ。 */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const EPSILON = 1e-6;
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > zoom * (1 + EPSILON)) ?? MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const step = ZOOM_STEPS[i]!;
    if (step < zoom * (1 - EPSILON)) return step;
  }
  return MIN_ZOOM;
}

// ---------------------------------------------------------------------------
// ホイール
// ---------------------------------------------------------------------------

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 = px、1 = 行、2 = ページ (`WheelEvent.deltaMode`) */
  deltaMode: number;
  /** ピンチ (Chromium / WebView2 は ctrlKey 付きの wheel にする) か Cmd/Ctrl を押しながら */
  zoom: boolean;
  shift: boolean;
  /** ポインターの位置 (画面座標) */
  anchor: Point;
}

const LINE_HEIGHT_PX = 16;
/** 1 回の wheel で変える倍率の上限 (マウスのホイールは 1 目盛りで deltaY が 100 前後になる) */
const MAX_ZOOM_DELTA = 32;
const ZOOM_SPEED = 0.01;

function toPixels(delta: number, mode: number, page: number): number {
  if (mode === 1) return delta * LINE_HEIGHT_PX;
  if (mode === 2) return delta * page;
  return delta;
}

/**
 * wheel の入力から次の表示位置を求める。
 * - 倍率の変更 (`zoom`): ポインターの位置を中心に、deltaY に応じて指数的に変える
 * - Shift: 縦の量を横へ回す (OS が既に横にしていればそのまま)
 * - それ以外: 縦横にスクロール
 */
export function applyWheel(viewport: Viewport, input: WheelInput, size: Size): Viewport {
  const dx = toPixels(input.deltaX, input.deltaMode, size.width);
  const dy = toPixels(input.deltaY, input.deltaMode, size.height);
  if (input.zoom) {
    const delta = Math.max(-MAX_ZOOM_DELTA, Math.min(MAX_ZOOM_DELTA, dy));
    return zoomAt(viewport, input.anchor, viewport.zoom * Math.exp(-delta * ZOOM_SPEED));
  }
  if (input.shift && dx === 0) return panBy(viewport, -dy, 0);
  return panBy(viewport, -dx, -dy);
}
