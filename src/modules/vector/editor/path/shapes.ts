/**
 * 矩形・楕円・線を、描画と同じ形の点の形 (`Subpath[]`) にする (`docs/canvas-editor-design.md` §8.6、§8.10)。
 *
 * 返すもの (座標はどれも、渡した値の座標系のまま):
 * - `rectSubpaths(width, height, radius)`: 箱の左上を原点とする閉じた輪郭 1 本
 *   - 角丸は SVG の規則 (今の描画は `rx` だけを付ける): rx = min(角丸, width/2)、ry = min(角丸, height/2) の
 *     楕円の 1/4 を 3 次ベジェ 1 本 (κ = `ELLIPSE_KAPPA`) で。rx か ry が 0 なら角丸なし
 *   - 始点と向きは SVG 2 の `rect` の等価なパスと同じ: (rx, 0) から時計回り。角丸なしは (0, 0) から
 *   - 長さ 0 の辺 (角丸が辺の半分ちょうど、幅や高さが 0) は点を重ねず 1 つにまとめる (ハンドルは両方残す)
 * - `ellipseSubpaths(width, height)`: 箱の左上を原点とする閉じた輪郭 1 本。4 本の 3 次ベジェ
 *   (κ = 0.5522847498)。SVG 2 の `ellipse` と同じく (cx + rx, cy) から時計回り
 * - `lineSubpaths(from, to)`: 開いた輪郭 1 本 (始点から終点)
 *
 * 誤差: 円の近似の半径の誤差は 0.027% 以内 (今の描画も `<ellipse>` なので、パスにすると最大でこの差が出る)。
 * 角丸の 1/4 も同じ。
 *
 * 前提: 純関数。width / height / radius は 0 以上 (負の値は 0 とみなす)。
 */
import type { HandleMirror, PathPoint, Point, Subpath } from "../model/types";
import { inferMirror } from "./segments";

/** 1/4 円を 3 次ベジェで近似するハンドルの長さの比 (§8.6)。 */
export const ELLIPSE_KAPPA = 0.5522847498;

export function rectSubpaths(width: number, height: number, radius: number): Subpath[] {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const r = Math.max(0, radius);
  const rx = Math.min(r, w / 2);
  const ry = Math.min(r, h / 2);
  if (rx === 0 || ry === 0) {
    return [
      {
        closed: true,
        points: mergeCoincident([corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)]),
      },
    ];
  }
  const kx = ELLIPSE_KAPPA * rx;
  const ky = ELLIPSE_KAPPA * ry;
  const pts: PathPoint[] = [
    pt(rx, 0, { x: -kx, y: 0 }, null),
    pt(w - rx, 0, null, { x: kx, y: 0 }),
    pt(w, ry, { x: 0, y: -ky }, null),
    pt(w, h - ry, null, { x: 0, y: ky }),
    pt(w - rx, h, { x: kx, y: 0 }, null),
    pt(rx, h, null, { x: -kx, y: 0 }),
    pt(0, h - ry, { x: 0, y: ky }, null),
    pt(0, ry, null, { x: 0, y: -ky }),
  ];
  return [{ closed: true, points: mergeCoincident(pts) }];
}

export function ellipseSubpaths(width: number, height: number): Subpath[] {
  const rx = Math.max(0, width) / 2;
  const ry = Math.max(0, height) / 2;
  const kx = ELLIPSE_KAPPA * rx;
  const ky = ELLIPSE_KAPPA * ry;
  return [
    {
      closed: true,
      points: [
        pt(2 * rx, ry, { x: 0, y: -ky }, { x: 0, y: ky }),
        pt(rx, 2 * ry, { x: kx, y: 0 }, { x: -kx, y: 0 }),
        pt(0, ry, { x: 0, y: ky }, { x: 0, y: -ky }),
        pt(rx, 0, { x: -kx, y: 0 }, { x: kx, y: 0 }),
      ],
    },
  ];
}

export function lineSubpaths(from: Point, to: Point): Subpath[] {
  return [{ closed: false, points: [corner(from.x, from.y), corner(to.x, to.y)] }];
}

function corner(x: number, y: number): PathPoint {
  return { x, y, in: null, out: null, mirror: "none" };
}

function pt(x: number, y: number, handleIn: Point | null, handleOut: Point | null): PathPoint {
  const mirror: HandleMirror = inferMirror(handleIn, handleOut);
  return { x, y, in: handleIn, out: handleOut, mirror };
}

/** 閉じた輪郭で、続く 2 点 (最後と先頭も) が同じ座標なら 1 点にまとめる (前の点の in と後の点の out)。 */
function mergeCoincident(points: PathPoint[]): PathPoint[] {
  const out: PathPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && prev.x === p.x && prev.y === p.y) {
      out[out.length - 1] = pt(p.x, p.y, prev.in, p.out);
    } else {
      out.push(p);
    }
  }
  while (out.length > 1) {
    const last = out[out.length - 1]!;
    const first = out[0]!;
    if (last.x !== first.x || last.y !== first.y) break;
    out.pop();
    out[0] = pt(first.x, first.y, last.in, first.out);
  }
  return out;
}
