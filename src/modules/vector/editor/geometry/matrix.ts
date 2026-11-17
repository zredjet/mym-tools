/**
 * 2 × 3 のアフィン行列 (`docs/canvas-editor-design.md` §8.5)。
 *
 * 返すもの:
 * - 行列は SVG の `matrix(a b c d e f)` と同じ並び。点 (x, y) を (a·x + c·y + e, b·x + d·y + f) へ写す
 * - `multiply(m1, m2)` は m1 · m2 (先に m2、次に m1 を掛ける)。SVG の `transform="m1 m2"` と同じ順
 * - 角度は度。y が下向きの座標で時計回りが正 (SVG の `rotate` と同じ)
 * - ノードの変換 (`nodeMatrix`) は「親の座標系 ← ノードの座標系」で、`T(x, y) · R(θ, 箱の中心)`
 *
 * 誤差と前提:
 * - すべて純関数で、引数を変えない。返す行列は新しいオブジェクト
 * - 90° の倍数の回転は cos / sin を 0・±1 ちょうどにする (反転や 90° の回転を重ねても小数の誤差が出ない)
 * - `invert` は行列式の絶対値が `SINGULAR_EPSILON` × (各成分の大きさ)² 以下なら null (逆がない)
 * - `decompose` の傾斜の判定は、傾斜の成分が大きさの `SKEW_EPSILON` 倍以下なら「傾斜なし」
 */
import type { Point } from "../model/types";

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** `invert` が「逆がない」と判定する行列式の相対的な大きさ。 */
export const SINGULAR_EPSILON = 1e-12;
/** `decompose` の傾斜の判定に使う相対的な大きさ。 */
export const SKEW_EPSILON = 1e-9;

export const IDENTITY: Matrix = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function matrix(a: number, b: number, c: number, d: number, e: number, f: number): Matrix {
  return { a, b, c, d, e, f };
}

/** m1 · m2。点には先に m2、次に m1 が掛かる。 */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/** 左から順に掛けた行列 (`multiplyAll(A, B, C)` = A · B · C。点には C が最初に掛かる)。 */
export function multiplyAll(...matrices: Matrix[]): Matrix {
  let result = IDENTITY;
  for (const m of matrices) result = multiply(result, m);
  return result;
}

export function determinant(m: Matrix): number {
  return m.a * m.d - m.b * m.c;
}

/** 逆行列。逆がない (潰れた) 行列なら null。 */
export function invert(m: Matrix): Matrix | null {
  const det = determinant(m);
  const scale = Math.max(Math.abs(m.a), Math.abs(m.b), Math.abs(m.c), Math.abs(m.d));
  if (!Number.isFinite(det) || scale === 0 || Math.abs(det) <= SINGULAR_EPSILON * scale * scale) {
    return null;
  }
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

export function applyToPoint(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** ベクトル (方向・ハンドルなどの相対値) に掛ける。平行移動は掛からない。 */
export function applyToVector(m: Matrix, v: Point): Point {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

export function translate(tx: number, ty: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

/** 度から cos / sin。90° の倍数は 0・±1 ちょうど。 */
export function cosSinDeg(degrees: number): { cos: number; sin: number } {
  const r = ((degrees % 360) + 360) % 360;
  if (r === 0) return { cos: 1, sin: 0 };
  if (r === 90) return { cos: 0, sin: 1 };
  if (r === 180) return { cos: -1, sin: 0 };
  if (r === 270) return { cos: 0, sin: -1 };
  const rad = (r * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

/** `degrees` 度の回転 (時計回りが正)。中心を渡せばそのまわり (SVG の `rotate(θ cx cy)`)。 */
export function rotate(degrees: number, cx = 0, cy = 0): Matrix {
  const { cos, sin } = cosSinDeg(degrees);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: cx - cos * cx + sin * cy,
    f: cy - sin * cx - cos * cy,
  };
}

/** 拡大。`sy` を省くと `sx` と同じ。中心を渡せばその点を動かさない。 */
export function scale(sx: number, sy: number = sx, cx = 0, cy = 0): Matrix {
  return { a: sx, b: 0, c: 0, d: sy, e: cx - sx * cx, f: cy - sy * cy };
}

/** 縦の直線 x = `cx` で映す (左右反転)。 */
export function flipHorizontal(cx = 0): Matrix {
  return scale(-1, 1, cx, 0);
}

/** 横の直線 y = `cy` で映す (上下反転)。 */
export function flipVertical(cy = 0): Matrix {
  return scale(1, -1, 0, cy);
}

/**
 * 箱を持つノードの「親の座標系 ← ノードの座標系」の行列 (§8.5)。
 * `T(x, y) · R(rotation, (width/2, height/2))`。ノードの座標系の原点は回転の前の箱の左上。
 */
export function nodeMatrix(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
): Matrix {
  if (rotation === 0) return translate(x, y);
  return multiply(translate(x, y), rotate(rotation, width / 2, height / 2));
}

export function isIdentity(m: Matrix, epsilon = 0): boolean {
  return matrixEquals(m, IDENTITY, epsilon);
}

/** 成分ごとの差がどれも `epsilon` 以下なら true。 */
export function matrixEquals(m1: Matrix, m2: Matrix, epsilon = 0): boolean {
  return (
    Math.abs(m1.a - m2.a) <= epsilon &&
    Math.abs(m1.b - m2.b) <= epsilon &&
    Math.abs(m1.c - m2.c) <= epsilon &&
    Math.abs(m1.d - m2.d) <= epsilon &&
    Math.abs(m1.e - m2.e) <= epsilon &&
    Math.abs(m1.f - m2.f) <= epsilon
  );
}

export interface DecomposedMatrix {
  translateX: number;
  translateY: number;
  /** 度。(-180, 180] */
  rotation: number;
  /** 0 以上 */
  scaleX: number;
  /** 反転 (行列式が負) なら負 */
  scaleY: number;
  /** 傾斜の角度 (度)。x 方向への傾斜 (SVG の `skewX`) */
  skewX: number;
  /** 傾斜があるか (`SKEW_EPSILON` で判定)。ある行列は回転と拡大だけでは表せない */
  hasSkew: boolean;
}

/**
 * 行列を `T(translateX, translateY) · R(rotation) · S(scaleX, scaleY) · skewX(skewX)` に分ける。
 * 反転は `scaleY` の符号に入れる (左右反転も「180° 回転 + 上下反転」として表す)。
 * 潰れた行列 (1 列目が 0) は null。
 */
export function decompose(m: Matrix): DecomposedMatrix | null {
  const sx = Math.hypot(m.a, m.b);
  if (!(sx > 0) || !Number.isFinite(sx)) return null;
  const rad = Math.atan2(m.b, m.a);
  const k = (m.a * m.c + m.b * m.d) / sx;
  const sy = (m.a * m.d - m.b * m.c) / sx;
  const magnitude = Math.max(sx, Math.abs(sy), Math.hypot(m.c, m.d));
  const hasSkew = Math.abs(k) > SKEW_EPSILON * magnitude;
  return {
    translateX: m.e,
    translateY: m.f,
    rotation: normalizeRotation((rad * 180) / Math.PI),
    scaleX: sx,
    scaleY: sy,
    skewX: hasSkew ? (Math.atan2(k, sx) * 180) / Math.PI : 0,
    hasSkew,
  };
}

/**
 * 角度を (-180, 180] にそろえる (§8.3.2)。丸めはしない。
 * 有限でない値はそのまま返す (呼び出し側の検証に任せる)。
 */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return degrees;
  let r = degrees % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r === 0 ? 0 : r;
}
