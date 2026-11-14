/**
 * 塗りの節で使う純関数 (種類の切替、停止点の追加・削除・変更、線形の向き)。
 * 範囲は `docs/canvas-editor-design.md` §3.5 (停止点の数、`from` `to` `center` の各成分は
 * 絶対値 100 以下、`radius` は 0 より大きく 100 以下)。
 */
import { CANVAS_LIMITS } from "../../model/limits";
import type {
  GradientStop,
  LinearGradientPaint,
  Paint,
  Point,
  RadialGradientPaint,
} from "../../model/types";
import { roundTo } from "../fields/values";

export type PaintKind = "none" | "solid" | "linear" | "radial";

export const PAINT_KIND_LABELS: Record<PaintKind, string> = {
  none: "なし",
  solid: "単色",
  linear: "線形",
  radial: "円形",
};

/** 塗りのなかったノードに単色を入れるときの色 (矩形の既定と同じ)。 */
export const DEFAULT_FILL_COLOR = "#D9D9D9";

/** 正規化した座標の成分の上限 (§3.5)。 */
export const MAX_GRADIENT_COORD = 100;

export function paintKind(paint: Paint | null): PaintKind {
  return paint === null ? "none" : paint.type;
}

/** 塗りの代表色 (単色ならその色、グラデーションなら最初の停止点)。 */
function baseColor(paint: Paint | null): { color: string; opacity: number } {
  if (paint === null) return { color: DEFAULT_FILL_COLOR, opacity: 1 };
  if (paint.type === "solid") return { color: paint.color, opacity: paint.opacity };
  const first = paint.stops[0];
  return first
    ? { color: first.color, opacity: first.opacity }
    : { color: DEFAULT_FILL_COLOR, opacity: 1 };
}

/** グラデーションへ切り替えるときの停止点。グラデーション同士はそのまま引き継ぐ。 */
function baseStops(paint: Paint | null): GradientStop[] {
  if (paint !== null && paint.type !== "solid") return paint.stops.map((stop) => ({ ...stop }));
  const { color, opacity } = baseColor(paint);
  return [
    { offset: 0, color, opacity },
    { offset: 1, color, opacity: 0 },
  ];
}

/**
 * 塗りの種類を切り替える。同じ種類ならそのまま返す。
 * 色はなるべく引き継ぐ (単色 → グラデーションは同じ色から透明へ、グラデーション → 単色は最初の停止点)。
 */
export function convertPaint(paint: Paint | null, kind: PaintKind): Paint | null {
  if (paintKind(paint) === kind) return paint;
  switch (kind) {
    case "none":
      return null;
    case "solid":
      return { type: "solid", ...baseColor(paint) };
    case "linear":
      return {
        type: "linear",
        stops: baseStops(paint),
        from: { x: 0, y: 0.5 },
        to: { x: 1, y: 0.5 },
      };
    case "radial":
      return { type: "radial", stops: baseStops(paint), center: { x: 0.5, y: 0.5 }, radius: 0.5 };
  }
}

/** 停止点を `offset` の昇順に並べる (同値は元の順を保つ)。 */
export function sortStops(stops: readonly GradientStop[]): GradientStop[] {
  return stops
    .map((stop, index) => ({ stop, index }))
    .sort((a, b) => a.stop.offset - b.stop.offset || a.index - b.index)
    .map(({ stop }) => stop);
}

/**
 * 停止点を足す。いちばん広い隙間の中央に、左の停止点の色で入れる。
 * 上限 (`maxGradientStops`) に達していれば null。
 */
export function addGradientStop(stops: readonly GradientStop[]): GradientStop[] | null {
  if (stops.length >= CANVAS_LIMITS.maxGradientStops) return null;
  const sorted = sortStops(stops);
  let at = 0;
  let widest = -1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = (sorted[i + 1] as GradientStop).offset - (sorted[i] as GradientStop).offset;
    if (gap > widest) {
      widest = gap;
      at = i;
    }
  }
  const left = sorted[at];
  const right = sorted[at + 1] ?? left;
  if (!left || !right) return null;
  const stop: GradientStop = {
    offset: roundTo((left.offset + right.offset) / 2, 4),
    color: left.color,
    opacity: roundTo((left.opacity + right.opacity) / 2, 4),
  };
  return [...sorted.slice(0, at + 1), stop, ...sorted.slice(at + 1)];
}

/** 停止点を消す。下限 (`minGradientStops`) なら null。 */
export function removeGradientStop(
  stops: readonly GradientStop[],
  index: number,
): GradientStop[] | null {
  if (stops.length <= CANVAS_LIMITS.minGradientStops) return null;
  if (index < 0 || index >= stops.length) return null;
  return stops.filter((_, i) => i !== index);
}

/** 停止点を変える。`offset` を変えたら昇順に並べ直す。 */
export function updateGradientStop(
  stops: readonly GradientStop[],
  index: number,
  patch: Partial<GradientStop>,
): GradientStop[] {
  const next = stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop));
  return patch.offset === undefined ? next : sortStops(next);
}

/** 線形の向き (度)。0 は左から右、90 は上から下 (y は下向き)。0 以上 360 未満。 */
export function linearAngle(paint: LinearGradientPaint): number {
  const dx = paint.to.x - paint.from.x;
  const dy = paint.to.y - paint.from.y;
  if (dx === 0 && dy === 0) return 0;
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return roundTo(((degrees % 360) + 360) % 360, 2);
}

/**
 * 線形の向きを変える。中点と長さを保って回す (長さ 0 なら 1 にする)。
 * 成分が範囲 (絶対値 100) を超えるなら null。
 */
export function withLinearAngle(
  paint: LinearGradientPaint,
  degrees: number,
): LinearGradientPaint | null {
  const mid: Point = { x: (paint.from.x + paint.to.x) / 2, y: (paint.from.y + paint.to.y) / 2 };
  const length = Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y) || 1;
  const radians = (degrees * Math.PI) / 180;
  const hx = (Math.cos(radians) * length) / 2;
  const hy = (Math.sin(radians) * length) / 2;
  const from = { x: roundTo(mid.x - hx, 6), y: roundTo(mid.y - hy, 6) };
  const to = { x: roundTo(mid.x + hx, 6), y: roundTo(mid.y + hy, 6) };
  const fits = [from.x, from.y, to.x, to.y].every((v) => Math.abs(v) <= MAX_GRADIENT_COORD);
  return fits ? { ...paint, from, to } : null;
}

/** 円形の中心と半径を変える。 */
export function withRadial(
  paint: RadialGradientPaint,
  patch: Partial<Pick<RadialGradientPaint, "center" | "radius">>,
): RadialGradientPaint {
  return { ...paint, ...patch };
}
