/**
 * パスの点の形を写す・向きを変える (`docs/canvas-editor-design.md` §8.5.4、§8.5.6、§8.6、§8.9.2)。
 *
 * 返すもの:
 * - `transformSubpaths(subpaths, m)`: 点に行列を、ハンドル (点からの相対) に行列の線形部分を掛ける。
 *   アフィン変換はベジェの制御点に掛ければ厳密なので、形は正確に写る。ハンドルの連動 (`mirror`) は
 *   線形の写像で保たれる (逆向き・同じ長さの組は、写しても逆向き・同じ長さ) のでそのまま
 * - `translateSubpaths(subpaths, dx, dy)`: 点だけを動かす (ハンドルは相対なので変わらない)
 * - `reverseSubpath(sub)` / `reverseSubpaths`: 向きを逆にする。点の順を逆にし、各点の `in` と `out` を入れ替える。
 *   閉じた輪郭は先頭の点を保つ (先頭 → 最後 → … → 2 番目)。開いた輪郭は最後の点が先頭になる
 * - `orientSubpath(sub, clockwise)`: 向きをそろえる (面積が 0 の輪郭はそのまま)
 *
 * 前提: 純関数。行列式が負の行列 (反転) は輪郭の向き (時計回りか) を逆にする。
 */
import { applyToPoint, applyToVector, type Matrix } from "../geometry/matrix";
import type { PathPoint, Subpath } from "../model/types";
import { signedArea } from "./measure";

export function transformSubpaths(subpaths: readonly Subpath[], m: Matrix): Subpath[] {
  return subpaths.map((sub) => ({
    closed: sub.closed,
    points: sub.points.map((p) => {
      const q = applyToPoint(m, p);
      return {
        x: q.x,
        y: q.y,
        in: p.in ? applyToVector(m, p.in) : null,
        out: p.out ? applyToVector(m, p.out) : null,
        mirror: p.mirror,
      };
    }),
  }));
}

export function translateSubpaths(subpaths: readonly Subpath[], dx: number, dy: number): Subpath[] {
  return subpaths.map((sub) => ({
    closed: sub.closed,
    points: sub.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
  }));
}

export function reverseSubpath(sub: Subpath): Subpath {
  const flip = (p: PathPoint): PathPoint => ({ ...p, in: p.out, out: p.in });
  const pts = sub.points;
  if (sub.closed && pts.length > 0) {
    return { closed: true, points: [flip(pts[0]!), ...pts.slice(1).reverse().map(flip)] };
  }
  return { closed: sub.closed, points: [...pts].reverse().map(flip) };
}

export function reverseSubpaths(subpaths: readonly Subpath[]): Subpath[] {
  return subpaths.map(reverseSubpath);
}

/** 時計回り (`clockwise` が true) か反時計回りにそろえる。面積が 0 ならそのまま。 */
export function orientSubpath(sub: Subpath, clockwise: boolean): Subpath {
  const area = signedArea(sub);
  if (area === 0 || area > 0 === clockwise) return sub;
  return reverseSubpath(sub);
}
