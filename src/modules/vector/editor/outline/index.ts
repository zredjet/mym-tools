/**
 * 線のアウトライン化 (`docs/canvas-editor-design.md` §8.10)。
 *
 * `outlineStroke(subpaths, stroke)`: 点の形 (`Subpath[]`) と線 (`Stroke` の太さ・端・角・破線) から、線の見た目
 * どおりの塗りの面の輪郭を返す。結果は閉じた輪郭の並びで、`nonzero` で塗る (外側は時計回り、穴は反時計回り。
 * `booleanOperation` の合体の結果)。描くものがなければ空の配列、求められなければ null。
 *
 * 描画 (`render/buildNodeSvg.ts` の `stroke-*`) と同じ規則:
 * - 端 butt / round / square、角 miter / round / bevel。マイターの上限は 4 (超えたらベベル)
 * - 破線は輪郭ごとに始点から (`dash.ts`)。奇数個は繰り返して偶数個に
 * - 点が 1 個の輪郭は描かない。長さ 0 の輪郭 (点が 2 個以上でどれも同じ位置) は、実線なら丸・四角の端の点
 *   (四角は x 軸の向き) を描き、破線なら描かない。輪郭の中の長さ 0 の線分は飛ばす (前後の向きで角を描く)
 * - 閉じた実線の輪郭は始点にも角を描く。開いた輪郭は閉じる辺を描かない
 *
 * 計算 (`offset.ts`、`contour.ts`):
 * 1. 中心線を部分に分け、左右の端の線を 3 次ベジェで近似する (誤差は許容値の半分以内)。曲率半径が太さの半分
 *    より小さい所 (きつい側) は、法線の交点 (`pivot`) で帯を 2 つの扇形に分ける。ハンドルが点に重なった端 (速さ
 *    が 0) のそばの短い区間は弦にする
 * 2. 部分の帯・角・端を時計回りの輪郭にし、1 つの入力 (`nonzero`) として `booleanOperation("union", …)` に
 *    渡して重なり (自己交差、角の内側、破線の重なり) を 1 つの面にする
 * 3. 部品がほぼ重なって合体が求められないときは、きつい側の扇形を少し変えて 2 回まで求め直す
 *
 * 誤差: 線の太さの 1% と 0.05 px の大きい方 (`options.tolerance` で変えられる) 以内。角と端の円弧は 90° ごとの
 * 3 次ベジェ (半径の誤差 0.027%)。破線の位置は曲線の正確な長さで決める (描画するエンジンは曲線の長さを近似する
 * ことがあり、長い曲線の終わりの方では破線の端が 0.1〜0.3 px ずれて見えることがある)。
 *
 * 求められないとき: 部分・破線の区間・輪郭の線分の数が多すぎる (`tooComplex`。結果がパスの点の数の上限に
 * 収まらない大きさ)、合体が求められない・座標が有限でない (`failed`)。
 */
import {
  isDegenerate,
  pointAt,
  subSegment,
  tAtLength,
  tangentAt,
  segmentLength,
  toleranceFor,
  type Segment,
} from "../geometry/bezier";
import { booleanOperation } from "../boolean/index";
import type { Point, Stroke, Subpath } from "../model/types";
import { segmentArea } from "../path/measure";
import { segmentsToSubpath, subpathToSegments } from "../path/segments";
import { dotContour, reverseSegments, runContours, type StrokeStyle } from "./contour";
import { dashSpans, normalizeDash } from "./dash";
import { offsetPieces, type OffsetPiece } from "./offset";

export type StrokeShape = Pick<Stroke, "width" | "cap" | "join" | "dash">;

export type StrokeOutlineFailure = "failed" | "tooComplex";

export type StrokeOutline =
  | { ok: true; subpaths: Subpath[] }
  | { ok: false; reason: StrokeOutlineFailure };

export interface StrokeOutlineOptions {
  /** 許容する誤差 (px)。省くと max(太さ × 0.01, 0.05) */
  tolerance?: number;
  /**
   * きつい部分の向こう側の扇形を変える距離の、許容値に対する比 (`contour.ts` の `lobeInset`)。省くと 1/8。
   * `strokeOutline` は合体が求められないとき、この値を変えて求め直す
   */
  lobeInset?: number;
}

/** 合体が求められなかったときに試す、扇形を変える距離の比 (順に)。 */
const LOBE_INSETS = [1 / 8, 1 / 5, 1 / 12];

/** 部分 (端の線の 3 次ベジェ 1 組) の数の上限。 */
export const MAX_OUTLINE_PIECES = 20000;
/** 破線の区間の数の上限 (区間ごとに 4 点以上になり、パスの点の数の上限を超えるため)。 */
export const MAX_DASH_SPANS = 5000;
/** 合体に渡す輪郭の線分の数の上限。 */
export const MAX_OUTLINE_SEGMENTS = 60000;

/** 許容値の既定: 線の太さの 1% と 0.05 px の大きい方 (§8.10)。 */
export function outlineTolerance(width: number): number {
  return Math.max(width * 0.01, 0.05);
}

/** 線の面の輪郭。描くものがなければ空の配列、求められなければ null。 */
export function outlineStroke(
  subpaths: readonly Subpath[],
  stroke: StrokeShape,
  options: StrokeOutlineOptions = {},
): Subpath[] | null {
  const result = strokeOutline(subpaths, stroke, options);
  return result.ok ? result.subpaths : null;
}

/** `outlineStroke` と同じ。求められないときは理由を返す。 */
export function strokeOutline(
  subpaths: readonly Subpath[],
  stroke: StrokeShape,
  options: StrokeOutlineOptions = {},
): StrokeOutline {
  // 部品が許容値の中でほぼ重なる (ブーリアン演算が辺の両側を決められない) ときは、扇形を少し変えて求め直す
  const insets = options.lobeInset === undefined ? LOBE_INSETS : [options.lobeInset];
  for (const lobeInset of insets) {
    const contours = strokeContours(subpaths, stroke, { ...options, lobeInset });
    if (!contours.ok) return contours;
    if (contours.subpaths.length === 0) return { ok: true, subpaths: [] };
    const merged = booleanOperation("union", [
      { subpaths: contours.subpaths, fillRule: "nonzero" },
    ]);
    if (merged !== null) return { ok: true, subpaths: merged };
  }
  return { ok: false, reason: "failed" };
}

/**
 * 合体の前の部品の輪郭 (どれも時計回り。`nonzero` で塗ると線の面)。テストと確かめのために出す。
 */
export function strokeContours(
  subpaths: readonly Subpath[],
  stroke: StrokeShape,
  options: StrokeOutlineOptions = {},
): StrokeOutline {
  const width = stroke.width;
  if (!Number.isFinite(width) || width < 0) return { ok: false, reason: "failed" };
  if (width === 0) return { ok: true, subpaths: [] };
  const magnitude = magnitudeOf(subpaths);
  if (!Number.isFinite(magnitude)) return { ok: false, reason: "failed" };
  const half = width / 2;
  const tolerance = options.tolerance ?? outlineTolerance(width);
  const style: StrokeStyle = {
    half,
    cap: stroke.cap,
    join: stroke.join,
    lobeInset: tolerance * (options.lobeInset ?? LOBE_INSETS[0]!),
    simplify: tolerance / 64,
    thinGap: tolerance / 4,
  };
  /** 同じ点とみなす距離 (計算の丸めの差。許容値の 1e-4 か、座標の大きさに比べた丸めの大きい方) */
  const eps = Math.max((magnitude + half) * 1e-12, tolerance * 1e-4);
  /** 長さのない線分とみなす距離 (交点の許容値と同じ) */
  const degenerate = toleranceFor(magnitude);
  const pattern = normalizeDash(stroke.dash);
  const budget = { pieces: MAX_OUTLINE_PIECES };
  let spanBudget = MAX_DASH_SPANS;
  const contours: Segment[][] = [];

  const addDot = (p: Point, tangent: Point) => {
    const dot = dotContour(p, tangent, style, eps);
    if (dot) contours.push(dot);
  };
  const addUnit = (segs: readonly Segment[], closed: boolean): boolean => {
    const pieces: OffsetPiece[] = [];
    const corners: boolean[] = [];
    for (const seg of segs) {
      const ps = offsetPieces(seg, { half, tolerance: tolerance / 2, budget });
      if (ps === null) return false;
      if (ps.length === 0) continue;
      if (pieces.length > 0) corners[pieces.length - 1] = true;
      ps.forEach((p, k) => {
        pieces.push(p);
        if (k + 1 < ps.length) corners[pieces.length - 1] = false;
      });
    }
    if (pieces.length === 0) return true;
    if (closed) corners[pieces.length - 1] = true;
    contours.push(...runContours({ pieces, corners, closed }, style, eps, clockwise));
    return true;
  };

  for (const sub of subpaths) {
    if (sub.points.length < 2) continue; // 描かない (§8.4)
    const segs = subpathToSegments(sub).filter((seg) => !isDegenerate(seg, degenerate));
    if (segs.length === 0) {
      // 長さ 0 の輪郭: 実線なら端の点 (向きは x 軸)。破線は描かない
      const p = sub.points[0]!;
      if (pattern === null) addDot({ x: p.x, y: p.y }, { x: 1, y: 0 });
      continue;
    }
    if (pattern === null) {
      if (!addUnit(segs, sub.closed)) return { ok: false, reason: "tooComplex" };
      continue;
    }
    const lengths = segs.map((seg) => segmentLength(seg));
    const starts = [0];
    for (const len of lengths) starts.push(starts[starts.length - 1]! + len);
    const total = starts[starts.length - 1]!;
    const spans = dashSpans(total, sub.closed, pattern, spanBudget);
    if (spans === null) return { ok: false, reason: "tooComplex" };
    spanBudget -= spans.length;
    for (const span of spans) {
      if (!span.wraps && span.end <= span.start) {
        const at = locate(segs, starts, span.start);
        if (at) addDot(at.point, at.tangent);
        continue;
      }
      const parts = span.wraps
        ? [...slice(segs, starts, span.start, total), ...slice(segs, starts, 0, span.end)]
        : slice(segs, starts, span.start, span.end);
      if (!addUnit(parts, false)) return { ok: false, reason: "tooComplex" };
    }
  }

  const out: Subpath[] = [];
  let segmentCount = 0;
  const minExtent = tolerance / 4;
  for (const segs of contours) {
    if (segs.length === 0 || extentOf(segs) <= minExtent) continue;
    segmentCount += segs.length;
    if (segmentCount > MAX_OUTLINE_SEGMENTS) return { ok: false, reason: "tooComplex" };
    out.push(segmentsToSubpath(segs, true, { tolerance: eps }));
  }
  return { ok: true, subpaths: out };
}

/** 時計回り (y が下向きの画面で面積が正) にそろえる。 */
function clockwise(segs: Segment[]): Segment[] {
  let area = 0;
  for (const seg of segs) area += segmentArea(seg);
  return area < 0 ? reverseSegments(segs) : segs;
}

function magnitudeOf(subpaths: readonly Subpath[]): number {
  let m = 0;
  for (const sub of subpaths)
    for (const p of sub.points) {
      m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
      for (const h of [p.in, p.out])
        if (h) m = Math.max(m, Math.abs(p.x + h.x), Math.abs(p.y + h.y));
    }
  return m;
}

/** 制御点の範囲の幅と高さの大きい方。 */
function extentOf(segs: readonly Segment[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const seg of segs) {
    const pts = seg.kind === "line" ? [seg.from, seg.to] : [seg.from, seg.c1, seg.c2, seg.to];
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Math.max(maxX - minX, maxY - minY);
}

/** 始点からの長さ `a` から `b` までの部分 (a < b)。元の線分ごとに 1 本。 */
function slice(
  segs: readonly Segment[],
  starts: readonly number[],
  a: number,
  b: number,
): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s0 = starts[i]!;
    const s1 = starts[i + 1]!;
    if (s1 <= a || s0 >= b) continue;
    const seg = segs[i]!;
    const t0 = a > s0 ? tAtLength(seg, a - s0) : 0;
    const t1 = b < s1 ? tAtLength(seg, b - s0) : 1;
    if (!(t1 > t0)) continue;
    out.push(t0 === 0 && t1 === 1 ? seg : subSegment(seg, t0, t1));
  }
  return out;
}

/** 始点からの長さ `d` の点と進む向き (線分の境目では、そこから始まる線分の向き)。 */
function locate(
  segs: readonly Segment[],
  starts: readonly number[],
  d: number,
): { point: Point; tangent: Point } | null {
  let i = 0;
  while (i + 1 < segs.length && starts[i + 1]! <= d) i++;
  const seg = segs[i]!;
  const t = tAtLength(seg, d - starts[i]!);
  const tangent = tangentAt(seg, t);
  return tangent ? { point: pointAt(seg, t), tangent } : null;
}
