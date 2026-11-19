/**
 * 線のアウトライン化の、中心線の 1 本 (線分か 3 次ベジェ) の左右の端の線 (`docs/canvas-editor-design.md` §4.16)。
 *
 * 中心線を「部分」に分け、部分ごとに左右の端の線 (中心線から太さの半分だけ法線の向きへずらした曲線) を
 * 3 次ベジェ 1 本で近似する。左右は進む向きに見たもの (y が下向きの画面で)。
 *
 * 分け方:
 * 1. 曲率半径が太さの半分に近くなる所 (太さの半分 ± 全体の許容値の 1/4) で分ける。分けた部分は、片側の
 *    曲率半径がどこでも太さの半分 + 許容値の 1/4 より小さい (その側を「きつい」側と呼ぶ) か、どこでも大きいか
 *    のどちらか
 * 2. ハンドルが点に重なった端 (速さが 0) のすぐそば (許容値の 1/4 の長さ) は弦 (線分) にする。ほぼ尖った所
 *    (速さの極小で、曲率半径が許容値より小さい) のまわりの短い区間は除き、前後を丸い角でつなぐ (`cuspSweep`)
 * 3. 端の線の近似の誤差が許容値を超えるとき、制御点の折れ線の曲がりが 90° を超えるとき、きつい側で法線が
 *    1 点 (`pivot`) の近くを通らないときは、半分に分ける
 *
 * 端の線の近似は、両端の位置と微分 (dO/dt = B'(t)·(1 − σ·h·κ(t))、σ は右 +1・左 −1、κ は y が下向きの
 * 画面で時計回りに曲がると正) を合わせた 3 次のエルミート補間。誤差は、きつくない側は端の線までの距離
 * (中心線への足から測る)、きつい側は同じ媒介変数の点どうしの距離で測る (きつい側の端の線は中心の向こうに
 * 回り込み、中心線への最も近い点がずれるため)。
 *
 * きつい側の部分は、法線が中心線の側から中心 (`pivot`) を通って向こうへ抜ける。描く範囲は「`pivot` から
 * 反対側の端の線まで」と「`pivot` から向こう側の端の線まで」の 2 つの扇形になる (`contour.ts`)。
 */
import {
  cross,
  derivativeAt,
  dot,
  pointAt,
  secondDerivativeAt,
  segmentLength,
  subSegment,
  tAtLength,
  tangentAt,
  thirdDerivative,
  type CubicSegment,
  type Segment,
} from "../geometry/bezier";
import type { Point } from "../model/types";

export type Side = "left" | "right";

export interface OffsetPiece {
  /** 中心線の部分 */
  seg: Segment;
  /** 始点・終点の進む向き (長さ 1) */
  t0: Point;
  t1: Point;
  /** 曲率半径が太さの半分より小さい側。どちらでもなければ null */
  tight: Side | null;
  /** 左右の端の線 (進む向き)。始点は 中心線の始点 + h·法線 */
  left: Segment;
  right: Segment;
  /** きつい側があるとき、始点と終点の法線の交点 */
  pivot: Point | null;
  /** 速さが 0 の端のそばを弦にした短い線分 (隣の部分との境目は中心を通らずにつなぐ。`contour.ts`) */
  chord?: boolean;
  /**
   * この部分の後にほぼ尖った所があり、短い区間を除いてある。次の部分とは丸い角でつなぐ。値は除いた区間で
   * 進む向きが回る角度 (ラジアン、正は時計回り。180° を超えうる)
   */
  cuspSweep?: number;
}

export interface OffsetOptions {
  /** 太さの半分 */
  half: number;
  /** 端の線の近似の誤差の上限 */
  tolerance: number;
  /** 部分の数の残り (超えたら null)。呼び出しの間で共有する */
  budget: { pieces: number };
}

/** 進む向きに見て左の法線 (y が下向きの画面で)。 */
export function leftNormal(t: Point): Point {
  return { x: t.y, y: -t.x };
}

/** 進む向きに見て右の法線。 */
export function rightNormal(t: Point): Point {
  return { x: -t.y, y: t.x };
}

export function sideNormal(t: Point, side: Side): Point {
  return side === "left" ? leftNormal(t) : rightNormal(t);
}

const sigma = (side: Side) => (side === "right" ? 1 : -1);
const add = (p: Point, v: Point, k = 1): Point => ({ x: p.x + v.x * k, y: p.y + v.y * k });

/** 曲線の分割の深さの上限。 */
const MAX_DEPTH = 22;
/** 誤差を測る、部分の中の媒介変数 (端を除く)。 */
const ERROR_SAMPLES = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
/** 曲率の符号を調べる標本の数。 */
const CURVATURE_SAMPLES = 64;
/** 端の近くで足す標本 (端からの媒介変数の距離)。 */
const END_SAMPLES = [1e-6, 1e-5, 1e-4, 1e-3, 4e-3];
/** 部分の制御点の折れ線の曲がりの上限。 */
const MAX_TURN = Math.PI / 2;

/**
 * 中心線の 1 本を部分に分け、それぞれの左右の端の線を求める。長さのない線 (呼び出し側が除く) は渡さない。
 * 部分の数が `budget` を超えたら null。
 */
export function offsetPieces(seg: Segment, options: OffsetOptions): OffsetPiece[] | null {
  if (seg.kind === "line") {
    if (--options.budget.pieces < 0) return null;
    const piece = linePiece(seg.from, seg.to, options.half);
    return piece ? [piece] : [];
  }
  // ハンドルが点に重なった端 (速さが 0) のすぐそばは曲率が限りなく大きく、端の線が細かく折り返す。端から
  // 許容値の 1/4 の長さ (全体の許容値の 1/8) は弦 (線分) にする。曲がりはごくわずかなので、形の差は許容値の中
  const trim = options.tolerance / 4;
  const total = segmentLength(seg);
  const prefix: OffsetPiece[] = [];
  const suffix: OffsetPiece[] = [];
  let start = 0;
  let end = 1;
  if (total > 8 * trim) {
    if (zeroSpeed(seg, 0)) {
      start = tAtLength(seg, trim);
      const piece = linePiece(seg.from, pointAt(seg, start), options.half);
      if (piece) prefix.push({ ...piece, chord: true });
    }
    if (zeroSpeed(seg, 1)) {
      end = tAtLength(seg, total - trim);
      const piece = linePiece(pointAt(seg, end), seg.to, options.half);
      if (piece) suffix.push({ ...piece, chord: true });
    }
  }
  options.budget.pieces -= prefix.length + suffix.length;
  // ほぼ尖った所 (速さがほぼ 0 で、曲率半径が許容値より小さい) は、部分に分けても折り返しを当てはめられない。
  // そのまわりの短い区間を除き、その前後を丸い角 (折り返しの角度の扇) でつなぐ
  const cusps = nearCusps(seg, start, end, options.tolerance);
  const out: OffsetPiece[] = [...prefix];
  let from = start;
  for (const cusp of cusps) {
    if (!piecesBetween(seg, from, cusp.before, options, out)) return null;
    const last = out[out.length - 1];
    if (last) out[out.length - 1] = { ...last, cuspSweep: cusp.sweep };
    from = cusp.after;
  }
  if (!piecesBetween(seg, from, end, options, out)) return null;
  out.push(...suffix);
  if (options.budget.pieces < 0) return null;
  return out;
}

/** [start, end] を部分に分けて `out` に足す。部分の数が上限を超えたら false。 */
function piecesBetween(
  seg: CubicSegment,
  start: number,
  end: number,
  options: OffsetOptions,
  out: OffsetPiece[],
): boolean {
  if (!(end > start)) return true;
  // 曲率半径が太さの半分に近い所 (± 全体の許容値の 1/4) は、きつい側に数えて向こう側の扇形は作らない
  // (`contour.ts`)。円弧の近似の曲率は太さの半分のまわりで揺れることがあり、そのたびに分けると部分が増えるため。
  // pivot が端の線より遠くなる分と、扇形を作らない分は、どちらも許容値の 1/4 以内。分けるのは、その範囲の
  // 上の端 (きつい側の始まり) と下の端 (向こう側の扇形の始まり)。端の線の尖り (ちょうど太さの半分) は、
  // 扇形を作る部分にも作らない部分の外にも来ない
  const band = Math.min(options.half, options.tolerance / 2);
  const reach = options.half + band;
  const roots = [
    ...tightnessRoots(seg, reach),
    ...(options.half > band ? tightnessRoots(seg, options.half - band) : []),
  ]
    .filter((r) => r > start && r < end)
    .sort((x, y) => x - y);
  // ごく短い部分 (許容値の 1/100 より短い) は作らない (向きが決まりにくく、輪郭が細かく折り返すため)
  const minLength = options.tolerance / 50;
  const splits = [start];
  for (const r of roots) {
    const prev = splits[splits.length - 1]!;
    if (
      r - prev > 1e-12 &&
      chordLength(seg, prev, r) > minLength &&
      chordLength(seg, r, end) > minLength
    )
      splits.push(r);
  }
  splits.push(end);
  for (let i = 0; i + 1 < splits.length; i++) {
    const a = splits[i]!;
    const b = splits[i + 1]!;
    if (!(b > a)) continue;
    const tight = tightSideAt(seg, (a + b) / 2, reach);
    if (!refine(seg, a, b, tight, 0, options, out)) return false;
  }
  return true;
}

/** ほぼ尖った所として扱う、区間の中の向きの回りの下限 (120°)。 */
const MIN_CUSP_TURN = (2 * Math.PI) / 3;

interface NearCusp {
  /** 除く区間の始めと終わり */
  before: number;
  after: number;
  /** 区間の中で進む向きが回る角度 (ラジアン、正は時計回り) */
  sweep: number;
}

/**
 * ほぼ尖った所: 速さの極小 (B'·B'' = 0) で、曲率半径 (|B'|²/|B''|) が `tolerance` 以下、そのまわりの長さ
 * `tolerance` / 2 ずつ (全体の許容値の 1/4) の区間で向きが 120° 以上回るもの。除く区間と、その中で向きが回る
 * 角度を返す。
 *
 * - ちょうど尖った所 (速さがちょうど 0) は除かない (向きが裏返るだけで扇は描かない。WebKit と同じ)
 * - 区間が [start, end] の端にかかるもの、ほかの区間と重なるものは除かない
 */
function nearCusps(seg: CubicSegment, start: number, end: number, tolerance: number): NearCusp[] {
  const scale =
    Math.hypot(seg.c1.x - seg.from.x, seg.c1.y - seg.from.y) +
    Math.hypot(seg.c2.x - seg.c1.x, seg.c2.y - seg.c1.y) +
    Math.hypot(seg.to.x - seg.c2.x, seg.to.y - seg.c2.y);
  const out: NearCusp[] = [];
  const reach = tolerance / 2;
  const from = segmentLength(seg, 0, start);
  const to = segmentLength(seg, 0, end);
  for (const t of speedExtrema(seg)) {
    if (!(t > start && t < end)) continue;
    const d1 = derivativeAt(seg, t);
    const d2 = secondDerivativeAt(seg, t);
    const speed = Math.hypot(d1.x, d1.y);
    const accel = Math.hypot(d2.x, d2.y);
    if (!(accel > 0) || speed <= 1e-9 * scale) continue;
    if ((speed * speed) / accel > tolerance) continue;
    const at = segmentLength(seg, 0, t);
    if (at - reach <= from || at + reach >= to) continue;
    const before = tAtLength(seg, at - reach);
    const after = tAtLength(seg, at + reach);
    const prev = out[out.length - 1];
    if (prev && before <= prev.after) continue;
    // 折り返し (向きが 120° 以上回る) だけ。曲がりの小さいものは部分に分けて求められる
    const sweep = turning(seg, before, t, after);
    if (Math.abs(sweep) < MIN_CUSP_TURN) continue;
    out.push({ before, after, sweep });
  }
  return out;
}

/** [a, b] で進む向きが回る角度の合計 (`m` は速さの極小。そのまわりを細かく見る)。 */
function turning(seg: Segment, a: number, m: number, b: number): number {
  const ts: number[] = [];
  const n = 64;
  // 速さの極小のまわりに標本を寄せる (m からの距離の 3 乗で並べる)
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * 2 - 1;
    const d = u * u * u;
    ts.push(d < 0 ? m + d * (m - a) : m + d * (b - m));
  }
  let sum = 0;
  let prev = pieceTangent(seg, a, b);
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i]!;
    const cur = i === ts.length - 1 ? pieceTangent(seg, b, a) : pieceTangent(seg, t, b);
    if (prev && cur) sum += Math.atan2(cross(prev, cur), dot(prev, cur));
    prev = cur ?? prev;
  }
  return sum;
}

/** 線分の部分 (端の線も線分)。長さがなければ null。 */
function linePiece(from: Point, to: Point, half: number): OffsetPiece | null {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(len > 0)) return null;
  const t = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  const l = leftNormal(t);
  return {
    seg: { kind: "line", from, to },
    t0: t,
    t1: t,
    tight: null,
    left: { kind: "line", from: add(from, l, half), to: add(to, l, half) },
    right: { kind: "line", from: add(from, l, -half), to: add(to, l, -half) },
    pivot: null,
  };
}

/** t (0 か 1) での速さがほぼ 0 (ハンドルが点に重なっている) か。 */
function zeroSpeed(seg: CubicSegment, t: 0 | 1): boolean {
  const d = derivativeAt(seg, t);
  const scale =
    Math.hypot(seg.c1.x - seg.from.x, seg.c1.y - seg.from.y) +
    Math.hypot(seg.c2.x - seg.c1.x, seg.c2.y - seg.c1.y) +
    Math.hypot(seg.to.x - seg.c2.x, seg.to.y - seg.c2.y);
  return Math.hypot(d.x, d.y) <= 1e-9 * scale;
}

// ---------------------------------------------------------------------------
// 曲率半径が太さの半分と等しくなる所
// ---------------------------------------------------------------------------

/** 右がきつい: h·cross(B', B'') − |B'|³ > 0。左がきつい: −h·cross(B', B'') − |B'|³ > 0。 */
function tightness(seg: Segment, t: number, half: number): { right: number; left: number } {
  const d1 = derivativeAt(seg, t);
  const d2 = secondDerivativeAt(seg, t);
  const c = half * cross(d1, d2);
  const s = Math.hypot(d1.x, d1.y);
  const s3 = s * s * s;
  return { right: c - s3, left: -c - s3 };
}

function tightSideAt(seg: Segment, t: number, half: number): Side | null {
  const f = tightness(seg, t, half);
  if (f.right > 0) return "right";
  if (f.left > 0) return "left";
  return null;
}

/** 速さ |B'| の極値の t (B'·B'' = 0。3 次式)。近い尖り (速さがほぼ 0) を標本から漏らさないため。 */
function speedExtrema(seg: CubicSegment): number[] {
  const d0 = { x: seg.c1.x - seg.from.x, y: seg.c1.y - seg.from.y };
  const d1 = { x: seg.c2.x - seg.c1.x, y: seg.c2.y - seg.c1.y };
  const d2 = { x: seg.to.x - seg.c2.x, y: seg.to.y - seg.c2.y };
  // B'(t) = a t² + b t + c
  const a = { x: 3 * (d0.x - 2 * d1.x + d2.x), y: 3 * (d0.y - 2 * d1.y + d2.y) };
  const b = { x: 6 * (d1.x - d0.x), y: 6 * (d1.y - d0.y) };
  const c = { x: 3 * d0.x, y: 3 * d0.y };
  // B'·B'' = 2|a|² t³ + 3(a·b) t² + (|b|² + 2 a·c) t + b·c
  return cubicRoots01(2 * dot(a, a), 3 * dot(a, b), dot(b, b) + 2 * dot(a, c), dot(b, c));
}

/** c3 t³ + c2 t² + c1 t + c0 = 0 の (0, 1) の中の根 (昇順)。極値で単調な区間に分けて二分法で求める。 */
export function cubicRoots01(c3: number, c2: number, c1: number, c0: number): number[] {
  const f = (t: number) => ((c3 * t + c2) * t + c1) * t + c0;
  const breaks = [0, 1];
  // f' = 3 c3 t² + 2 c2 t + c1
  const A = 3 * c3;
  const B = 2 * c2;
  const C = c1;
  if (A !== 0) {
    const disc = B * B - 4 * A * C;
    if (disc > 0) {
      const sq = Math.sqrt(disc);
      breaks.push((-B - sq) / (2 * A), (-B + sq) / (2 * A));
    }
  } else if (B !== 0) {
    breaks.push(-C / B);
  }
  const ts = breaks.filter((t) => t >= 0 && t <= 1).sort((x, y) => x - y);
  const roots: number[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const r = bisect(f, ts[i]!, ts[i + 1]!);
    if (
      r !== null &&
      r > 0 &&
      r < 1 &&
      (roots.length === 0 || r - roots[roots.length - 1]! > 1e-12)
    )
      roots.push(r);
  }
  return roots;
}

/** [a, b] で符号の変わる f の根。変わらなければ null。 */
function bisect(f: (t: number) => number, a: number, b: number): number | null {
  let fa = f(a);
  const fb = f(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa > 0 === fb > 0) return null;
  let lo = a;
  let hi = b;
  for (let i = 0; i < 60 && hi - lo > 1e-15; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (fm === 0) return mid;
    if (fm > 0 === fa > 0) {
      lo = mid;
      fa = fm;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/** 曲率半径が太さの半分と等しくなる t (0 < t < 1、昇順)。 */
function tightnessRoots(seg: CubicSegment, half: number): number[] {
  const ts = new Set<number>();
  for (let i = 0; i <= CURVATURE_SAMPLES; i++) ts.add(i / CURVATURE_SAMPLES);
  for (const t of speedExtrema(seg)) ts.add(t);
  // 端のハンドルが点に重なっている (速さが 0) と、端のすぐそばの曲率は限りなく大きい。きつい所が標本の
  // 間に隠れないよう、端の近くを細かく見る
  for (const t of END_SAMPLES) {
    ts.add(t);
    ts.add(1 - t);
  }
  const samples = [...ts].sort((x, y) => x - y);
  const values = samples.map((t) => tightness(seg, t, half));
  const roots: number[] = [];
  for (const key of ["right", "left"] as const) {
    for (let i = 0; i + 1 < samples.length; i++) {
      const fa = values[i]![key];
      const fb = values[i + 1]![key];
      if (fa > 0 === fb > 0) continue;
      const r = bisect((t) => tightness(seg, t, half)[key], samples[i]!, samples[i + 1]!);
      if (r !== null && r > 0 && r < 1) roots.push(r);
    }
  }
  roots.sort((x, y) => x - y);
  return roots.filter((r, i) => i === 0 || r - roots[i - 1]! > 1e-12);
}

// ---------------------------------------------------------------------------
// 部分の端の線
// ---------------------------------------------------------------------------

/** 端の線の点 O(t) = B(t) + σ·h·右の法線。`tangent` を渡せばその向きを使う (部分の端)。 */
function offsetPoint(seg: Segment, t: number, half: number, side: Side, tangent?: Point): Point {
  const p = pointAt(seg, t);
  const tan = tangent ?? tangentAt(seg, t);
  if (!tan) return p;
  return add(p, sideNormal(tan, side), half);
}

/**
 * dO/dt (元の曲線の媒介変数で)。速さがほぼ 0 の所 (ハンドルが点に重なった端) では 0 にする (曲率が限りなく
 * 大きくなり、差分も丸めに負けるため)。近似の誤差は呼び出し側が測り、足りなければ分ける。
 */
function offsetDerivative(seg: Segment, t: number, half: number, side: Side): Point {
  const d1 = derivativeAt(seg, t);
  const s = Math.hypot(d1.x, d1.y);
  const scale = Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) + half;
  if (!(s > 1e-7 * scale)) return { x: 0, y: 0 };
  const d2 = secondDerivativeAt(seg, t);
  const k = cross(d1, d2) / (s * s * s);
  const f = 1 - sigma(side) * half * k;
  return { x: d1.x * f, y: d1.y * f };
}

/** [a, b] の端の線をエルミート補間した 3 次ベジェ。 */
function hermiteOffset(
  seg: Segment,
  a: number,
  b: number,
  side: Side,
  half: number,
  t0: Point,
  t1: Point,
  tight: boolean,
): CubicSegment {
  const p0 = offsetPoint(seg, a, half, side, t0);
  const p3 = offsetPoint(seg, b, half, side, t1);
  const k = (b - a) / 3;
  let d0 = offsetDerivative(seg, a, half, side);
  let d3 = offsetDerivative(seg, b, half, side);
  // ハンドルは端の点どうしの距離の 2 倍まで (速さがほぼ 0 の所の近くで曲率から求めた微分が大きくなりすぎない
  // ように。近似の誤差は呼び出し側が測る)
  const limit = (2 * Math.hypot(p3.x - p0.x, p3.y - p0.y)) / Math.max(k, 1e-300);
  const cap = (d: Point): Point => {
    const len = Math.hypot(d.x, d.y);
    return len > limit ? { x: (d.x * limit) / len, y: (d.y * limit) / len } : d;
  };
  d0 = cap(d0);
  d3 = cap(d3);
  if (!tight) {
    // きつくない側の端の線は中心線と同じ向きに進む。端の向きが逆なのは、端のすぐそばの見落とした小さな
    // きつい所 (速さが 0 の端など) で、端の線に小さな折り返しができるため。0 にして折り返しを作らない
    // (失う形は許容値の中。誤差は下で測る)
    if (dot(d0, t0) < 0) d0 = { x: 0, y: 0 };
    if (dot(d3, t1) < 0) d3 = { x: 0, y: 0 };
  }
  return {
    kind: "cubic",
    from: p0,
    c1: add(p0, d0, k),
    c2: add(p3, d3, -k),
    to: p3,
  };
}

/** B(a) と B(b) の距離。 */
function chordLength(seg: Segment, a: number, b: number): number {
  const p = pointAt(seg, a);
  const q = pointAt(seg, b);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * 部分の端 `t` の進む向き (部分のもう一方の端は `other`)。元の曲線の微分から求める (ごく短い部分の制御点から
 * 求めると、丸めで向きが裏返ることがある)。速さがほぼ 0 の所 (ハンドルが点に重なった端、尖り) では、高次の
 * 微分の向き: B'(t) ≈ (t − t₀)·B''(t₀) なので、部分の内側が後ろ (`other` < t) なら −B''、前なら +B''。
 * 2 次の微分も 0 なら 3 次の微分の向き。
 */
function pieceTangent(seg: Segment, t: number, other: number): Point | null {
  const scale =
    seg.kind === "line"
      ? Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y)
      : Math.hypot(seg.c1.x - seg.from.x, seg.c1.y - seg.from.y) +
        Math.hypot(seg.c2.x - seg.c1.x, seg.c2.y - seg.c1.y) +
        Math.hypot(seg.to.x - seg.c2.x, seg.to.y - seg.c2.y);
  const unit = (v: Point, k: number): Point | null => {
    const len = Math.hypot(v.x, v.y);
    return len > 1e-9 * scale ? { x: (v.x * k) / len, y: (v.y * k) / len } : null;
  };
  return (
    unit(derivativeAt(seg, t), 1) ??
    unit(secondDerivativeAt(seg, t), other < t ? -1 : 1) ??
    unit(thirdDerivative(seg), 1) ??
    tangentAt(seg, t)
  );
}

/** 中心線への足 (t の近くで |B(t) − p| が最小の t)。 */
function footParam(seg: Segment, p: Point, guess: number, lo: number, hi: number): number {
  let t = guess;
  for (let i = 0; i < 12; i++) {
    const b = pointAt(seg, t);
    const d1 = derivativeAt(seg, t);
    const d2 = secondDerivativeAt(seg, t);
    const r = { x: b.x - p.x, y: b.y - p.y };
    const g = dot(r, d1);
    const gp = dot(d1, d1) + dot(r, d2);
    if (!(gp > 0)) break;
    const next = Math.min(hi, Math.max(lo, t - g / gp));
    if (Math.abs(next - t) < 1e-14) {
      t = next;
      break;
    }
    t = next;
  }
  return t;
}

/** 近似の誤差。きつくない側は端の線までの距離、きつい側は同じ媒介変数の点との距離。 */
function offsetError(
  seg: Segment,
  approx: CubicSegment,
  a: number,
  b: number,
  side: Side,
  half: number,
  tight: boolean,
): number {
  let worst = 0;
  for (const u of ERROR_SAMPLES) {
    const t = a + (b - a) * u;
    const q = pointAt(approx, u);
    const exact = offsetPoint(seg, t, half, side);
    const parametric = Math.hypot(q.x - exact.x, q.y - exact.y);
    let err = parametric;
    if (!tight) {
      const foot = footParam(seg, q, t, a, b);
      const f = pointAt(seg, foot);
      const tan = tangentAt(seg, foot);
      const v = { x: q.x - f.x, y: q.y - f.y };
      const onSide = tan ? dot(v, sideNormal(tan, side)) : 0;
      const geometric = Math.abs(Math.hypot(v.x, v.y) - half);
      err = onSide > 0 ? Math.min(parametric, geometric) : parametric;
    }
    if (err > worst) worst = err;
  }
  return worst;
}

/** 制御点の折れ線の曲がりの合計 (曲線そのものの曲がりはこれ以下)。 */
function controlTurn(seg: Segment): number {
  if (seg.kind === "line") return 0;
  const legs = [
    { x: seg.c1.x - seg.from.x, y: seg.c1.y - seg.from.y },
    { x: seg.c2.x - seg.c1.x, y: seg.c2.y - seg.c1.y },
    { x: seg.to.x - seg.c2.x, y: seg.to.y - seg.c2.y },
  ].filter((v) => v.x !== 0 || v.y !== 0);
  let turn = 0;
  for (let i = 0; i + 1 < legs.length; i++) {
    const u = legs[i]!;
    const v = legs[i + 1]!;
    turn += Math.abs(Math.atan2(cross(u, v), dot(u, v)));
  }
  return turn;
}

/** きつい側の、始点と終点の法線の交点。求められなければ null。 */
function pivotOf(p0: Point, n0: Point, p1: Point, n1: Point): Point | null {
  const den = cross(n0, n1);
  if (Math.abs(den) < 1e-12) return null;
  const u = cross({ x: p1.x - p0.x, y: p1.y - p0.y }, n1) / den;
  return add(p0, n0, u);
}

/** きつい側で、部分の法線が `pivot` の近く (許容値以内) を、中心線から太さの半分までの間で通るか。 */
function pivotFits(
  seg: Segment,
  a: number,
  b: number,
  side: Side,
  half: number,
  pivot: Point,
  tol: number,
): boolean {
  for (const u of [0, ...ERROR_SAMPLES, 1]) {
    const t = a + (b - a) * u;
    const tan = tangentAt(seg, t);
    if (!tan) continue;
    const p = pointAt(seg, t);
    const v = { x: pivot.x - p.x, y: pivot.y - p.y };
    if (Math.abs(dot(v, tan)) > tol) return false;
    const along = dot(v, sideNormal(tan, side));
    if (along < -tol || along > half + tol) return false;
  }
  return true;
}

function refine(
  seg: Segment,
  a: number,
  b: number,
  tight: Side | null,
  depth: number,
  options: OffsetOptions,
  out: OffsetPiece[],
): boolean {
  const { half, tolerance } = options;
  const piece = subSegment(seg, a, b);
  const t0 = pieceTangent(seg, a, b);
  const t1 = pieceTangent(seg, b, a);
  if (!t0 || !t1) return true; // 長さのない部分は描かない
  const canSplit = depth < MAX_DEPTH && chordLength(seg, a, b) > tolerance / 25;
  if (canSplit && controlTurn(piece) > MAX_TURN)
    return splitHalf(seg, a, b, tight, depth, options, out);
  const left = hermiteOffset(seg, a, b, "left", half, t0, t1, tight === "left");
  const right = hermiteOffset(seg, a, b, "right", half, t0, t1, tight === "right");
  let ok =
    offsetError(seg, left, a, b, "left", half, tight === "left") <= tolerance &&
    offsetError(seg, right, a, b, "right", half, tight === "right") <= tolerance;
  let pivot: Point | null = null;
  if (ok && tight) {
    pivot =
      pivotOf(piece.from, sideNormal(t0, tight), piece.to, sideNormal(t1, tight)) ??
      // 曲がりがほぼない (ごく短い) 部分: 中心線の始点の、きつい側の太さの半分の所
      add(piece.from, sideNormal(t0, tight), half);
    ok = pivotFits(seg, a, b, tight, half, pivot, tolerance);
  }
  if (!ok && canSplit) return splitHalf(seg, a, b, tight, depth, options, out);
  if (--options.budget.pieces < 0) return false;
  out.push({
    seg: piece,
    t0,
    t1,
    tight,
    left: snapEnds(left, piece, t0, t1, half, "left"),
    right: snapEnds(right, piece, t0, t1, half, "right"),
    pivot,
  });
  return true;
}

/** 端の線の両端を、部分の端の法線の上にちょうど置く (隣の部分・角とつながるように)。 */
function snapEnds(
  approx: CubicSegment,
  piece: Segment,
  t0: Point,
  t1: Point,
  half: number,
  side: Side,
): CubicSegment {
  return {
    ...approx,
    from: add(piece.from, sideNormal(t0, side), half),
    to: add(piece.to, sideNormal(t1, side), half),
  };
}

function splitHalf(
  seg: Segment,
  a: number,
  b: number,
  tight: Side | null,
  depth: number,
  options: OffsetOptions,
  out: OffsetPiece[],
): boolean {
  const m = (a + b) / 2;
  return (
    refine(seg, a, m, tight, depth + 1, options, out) &&
    refine(seg, m, b, tight, depth + 1, options, out)
  );
}
