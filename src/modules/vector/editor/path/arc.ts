/**
 * SVG の円弧 (`A` 命令) を 3 次ベジェで近似する (`docs/canvas-editor-design.md` §8.12)。
 *
 * 返すもの:
 * - `arcToCubics(from, rx, ry, xAxisRotation, largeArc, sweep, to)`: 線分 (`line`) か 3 次ベジェの並び
 *   - SVG 2 の実装の注記 (B.2.4 の端点の形から中心の形への変換、B.2.5 の半径の補正) のとおり:
 *     始点と終点が同じなら空 (命令を飛ばす)、rx か ry が 0 なら線分 1 本、半径は絶対値を使い、
 *     届かない半径は 2 点を通るまで縦横同じ比で大きくする
 *   - 円弧を 90° 以下の等しい区間に分け、区間ごとに 1 本の 3 次ベジェ (ハンドルの長さ 4/3·tan(Δ/4))
 *   - 最初の曲線の始点は `from`、最後の曲線の終点は `to` そのもの (丸めでずれない)
 *
 * 誤差:
 * - 区間ごとの近似の誤差は、半径 1 に対して 90° の区間で 2.7e-4 (半径 100 px で 0.027 px)。
 *   区間が短いほど小さい (45° で 4.2e-6)。楕円は、縦横の大きい方の半径に対する割合
 * - 回転の角度は度。90° の倍数は cos / sin をちょうどにする
 */
import type { Segment } from "../geometry/bezier";
import { cosSinDeg } from "../geometry/matrix";
import type { Point } from "../model/types";

export function arcToCubics(
  from: Point,
  rxIn: number,
  ryIn: number,
  xAxisRotation: number,
  largeArc: boolean,
  sweep: boolean,
  to: Point,
): Segment[] {
  if (from.x === to.x && from.y === to.y) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    return [{ kind: "line", from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } }];
  }
  const { cos, sin } = cosSinDeg(xAxisRotation);
  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (from.x + to.x) / 2;
  const cy = sin * cxp + cos * cyp + (from.y + to.y) / 2;

  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angleBetween(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const k = (4 / 3) * Math.tan(step / 4);
  // 単位円の点を楕円へ写す
  const map = (ux: number, uy: number): Point => ({
    x: cx + cos * rx * ux - sin * ry * uy,
    y: cy + sin * rx * ux + cos * ry * uy,
  });
  const out: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const a = theta1 + step * i;
    const b = a + step;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const cb = Math.cos(b);
    const sb = Math.sin(b);
    out.push({
      kind: "cubic",
      from: i === 0 ? { x: from.x, y: from.y } : map(ca, sa),
      c1: map(ca - k * sa, sa + k * ca),
      c2: map(cb + k * sb, sb - k * cb),
      to: i === count - 1 ? { x: to.x, y: to.y } : map(cb, sb),
    });
  }
  // 区間の境目の点を、前の曲線の終点と次の曲線の始点で同じ値にする
  for (let i = 1; i < out.length; i++) out[i]!.from = { ...out[i - 1]!.to };
  return out;
}

/** ベクトル u から v への符号つきの角度 (ラジアン、(-π, π])。 */
function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}
