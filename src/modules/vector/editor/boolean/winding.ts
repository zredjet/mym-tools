/**
 * ブーリアン演算の巻き数: 辺 (重なった部分をまとめたもの) の上の点のすぐ左右の、入力ごとの巻き数
 * (`docs/canvas-editor-design.md` §4.15.3)。
 *
 * - 点から、辺にほぼ垂直な光線 (辺が縦寄りなら +x、横寄りなら +y) を出し、すべての部分との交わりを数える。
 *   交わりは曲線を光線の向きの座標の極値で単調な区間に分け、半開区間 [下端, 上端) の規則で数える
 *   (頂点や接する所を二重に数えない)。重みは `path/measure.ts` の `windingNumber` と同じ向き
 *   (時計回りの輪郭の内側で +1)
 * - 辺そのもの (と重なった部分) の点での交わりは数えず、その重みで光線の手前の側の巻き数を決める
 * - ほかの部分が点の近く (`otherNear` 以内) で光線を横切るなら、どちらの側に数えるかが決まらないので null
 *   (呼び出し側が辺の別の点で求め直す)。辺に属する部分 (重なった部分は許容値の中でずれうる) の交わりは
 *   `memberNear` 以内なら辺そのものの交わりとみなす
 * - 部分を、制御点の範囲で y の帯と x の帯に振り分けておき、光線の直線が通る帯の部分だけを調べる
 */
import { pointAt, type Segment, tangentAt } from "../geometry/bezier";

/** 帯への振り分け (帯 i の部分は items[offsets[i]] から items[offsets[i + 1]] の手前まで)。 */
interface Buckets {
  origin: number;
  size: number;
  count: number;
  offsets: Int32Array;
  items: Int32Array;
}

export interface WindingContext {
  /** 部分の形 */
  segs: readonly Segment[];
  /** 部分の入力の番号 */
  operands: readonly number[];
  /** 部分が属する辺 */
  edgeOf: readonly number[];
  /** 制御点の範囲 (minX, minY, maxX, maxY を 4 個ずつ) */
  bounds: Float64Array;
  operandCount: number;
  /** 辺に属する部分 (重なった部分を含む) の、点での交わりとみなす距離 */
  memberNear: number;
  /** ほかの部分がこの距離以内で光線を横切ると、どちらの側に数えるかが決まらない */
  otherNear: number;
  /** y の帯 (横の光線用) と x の帯 (縦の光線用) */
  rows: Buckets;
  columns: Buckets;
}

export interface SideWindings {
  /** 辺の向きに見て左 (y が下向きの画面で見たとおり) の、入力ごとの巻き数 */
  left: number[];
  right: number[];
}

export function createWindingContext(
  segs: readonly Segment[],
  operands: readonly number[],
  edgeOf: readonly number[],
  operandCount: number,
  memberNear: number,
  otherNear: number,
): WindingContext {
  const bounds = packBounds(segs);
  return {
    segs,
    operands,
    edgeOf,
    bounds,
    operandCount,
    memberNear,
    otherNear,
    rows: bucketize(bounds, 1, segs.length),
    columns: bucketize(bounds, 0, segs.length),
  };
}

/** 部分の制御点の範囲を並べる。 */
function packBounds(segs: readonly Segment[]): Float64Array {
  const out = new Float64Array(segs.length * 4);
  segs.forEach((s, i) => {
    let minX = Math.min(s.from.x, s.to.x);
    let maxX = Math.max(s.from.x, s.to.x);
    let minY = Math.min(s.from.y, s.to.y);
    let maxY = Math.max(s.from.y, s.to.y);
    if (s.kind === "cubic") {
      minX = Math.min(minX, s.c1.x, s.c2.x);
      maxX = Math.max(maxX, s.c1.x, s.c2.x);
      minY = Math.min(minY, s.c1.y, s.c2.y);
      maxY = Math.max(maxY, s.c1.y, s.c2.y);
    }
    out[i * 4] = minX;
    out[i * 4 + 1] = minY;
    out[i * 4 + 2] = maxX;
    out[i * 4 + 3] = maxY;
  });
  return out;
}

/** 軸 (0 = x、1 = y) の範囲で部分を帯に振り分ける。 */
function bucketize(bounds: Float64Array, axis: 0 | 1, n: number): Buckets {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, bounds[i * 4 + axis]!);
    hi = Math.max(hi, bounds[i * 4 + 2 + axis]!);
  }
  const count = n === 0 || !(hi > lo) ? 1 : Math.min(256, Math.max(1, Math.round(n / 8)));
  const size = count === 1 ? Infinity : (hi - lo) / count;
  const first = (v: number) =>
    count === 1 ? 0 : Math.min(count - 1, Math.max(0, Math.floor((v - lo) / size)));
  const offsets = new Int32Array(count + 1);
  for (let i = 0; i < n; i++) {
    const a = first(bounds[i * 4 + axis]!);
    const b = first(bounds[i * 4 + 2 + axis]!);
    for (let k = a; k <= b; k++) offsets[k + 1]!++;
  }
  for (let k = 0; k < count; k++) offsets[k + 1]! += offsets[k]!;
  const items = new Int32Array(offsets[count]!);
  const fill = offsets.slice(0, count);
  for (let i = 0; i < n; i++) {
    const a = first(bounds[i * 4 + axis]!);
    const b = first(bounds[i * 4 + 2 + axis]!);
    for (let k = a; k <= b; k++) items[fill[k]!++] = i;
  }
  return { origin: lo, size, count, offsets, items };
}

/** 値 v の帯。範囲の外なら -1。 */
function bucketOf(b: Buckets, v: number): number {
  if (b.count === 1) return 0;
  const k = Math.floor((v - b.origin) / b.size);
  if (k < -1 || k > b.count) return -1;
  return Math.min(b.count - 1, Math.max(0, k));
}

/**
 * 辺 `edge` (形 `seg`、属する部分の数 `members`) の t = s の点の左右の巻き数。決まらなければ null。
 */
export function windingsAt(
  ctx: WindingContext,
  edge: number,
  seg: Segment,
  members: number,
  s: number,
): SideWindings | null {
  const p = pointAt(seg, s);
  const d = tangentAt(seg, s);
  if (!d) return null;
  const horizontal = Math.abs(d.y) >= Math.abs(d.x);
  const value = horizontal ? p.y : p.x;
  const at = horizontal ? p.x : p.y;
  const n = ctx.operandCount;
  const ahead = new Array<number>(n).fill(0);
  const self = new Array<number>(n).fill(0);
  let selfCount = 0;
  let ambiguous = false;
  const memberNear = ctx.memberNear;
  const otherNear = ctx.otherNear;
  const reach = Math.max(memberNear, otherNear);
  const b = ctx.bounds;
  const buckets = horizontal ? ctx.rows : ctx.columns;
  const bucket = bucketOf(buckets, value);
  if (bucket >= 0) {
    // 光線の直線の座標の軸 (横の光線は y)、光線の進む軸 (横の光線は x)
    const lineAxis = horizontal ? 1 : 0;
    const rayAxis = horizontal ? 0 : 1;
    let isMember = false;
    let op = 0;
    const visit = (other: number, weight: number) => {
      const diff = other - at;
      if (isMember && Math.abs(diff) <= memberNear) {
        self[op]! += weight;
        selfCount++;
        return;
      }
      if (Math.abs(diff) <= otherNear) {
        ambiguous = true;
        return;
      }
      if (diff > 0) ahead[op]! += weight;
    };
    const end = buckets.offsets[bucket + 1]!;
    for (let i = buckets.offsets[bucket]!; i < end; i++) {
      const k = buckets.items[i]!;
      // 光線の直線を横切らない部分、点より手前にしかない部分は除く
      if (value < b[k * 4 + lineAxis]! || value > b[k * 4 + 2 + lineAxis]!) continue;
      if (b[k * 4 + 2 + rayAxis]! < at - reach) continue;
      isMember = ctx.edgeOf[k] === edge;
      op = ctx.operands[k]!;
      // 部分がすべて点より先なら、交わる位置は要らない (数と向きだけ)
      const exact = b[k * 4 + rayAxis]! <= at + reach;
      forEachCrossing(ctx.segs[k]!, horizontal, value, visit, exact);
      if (ambiguous) return null;
    }
  }
  // 辺に属する部分は、それぞれちょうど 1 回、点で光線を横切る
  if (selfCount !== members) return null;
  const behind = ahead.map((w, i) => w + self[i]!);
  // 進む向きの左は (d.y, -d.x)。光線の先 (+x / +y) が左か
  const leftIsAhead = horizontal ? d.y > 0 : d.x < 0;
  return leftIsAhead ? { left: ahead, right: behind } : { left: behind, right: ahead };
}

/**
 * 曲線と、光線の直線 (横なら y = value、縦なら x = value) の交わり。`other` は交わる点のもう一方の座標、
 * `weight` は巻き数への寄与 (横の光線は y が増える横切りで +1、縦の光線は x が減る横切りで +1)。
 * `exact` が false なら交わる位置を求めず、`other` は Infinity (呼び出し側が、曲線がすべて点より先にあると
 * 分かっているとき)。
 */
export function forEachCrossing(
  seg: Segment,
  horizontal: boolean,
  value: number,
  visit: (other: number, weight: number) => void,
  exact = true,
): void {
  const c0 = horizontal ? seg.from.y : seg.from.x;
  const c3 = horizontal ? seg.to.y : seg.to.x;
  const o0 = horizontal ? seg.from.x : seg.from.y;
  const o3 = horizontal ? seg.to.x : seg.to.y;
  const sign = horizontal ? 1 : -1;
  if (seg.kind === "line") {
    if (c0 === c3) return;
    const increasing = c3 > c0;
    if (increasing ? value < c0 || value >= c3 : value < c3 || value >= c0) return;
    const t = (value - c0) / (c3 - c0);
    visit(exact ? o0 + (o3 - o0) * t : Infinity, increasing ? sign : -sign);
    return;
  }
  const c1 = horizontal ? seg.c1.y : seg.c1.x;
  const c2 = horizontal ? seg.c2.y : seg.c2.x;
  // 制御点がすべて片側なら交わらない
  if (value < Math.min(c0, c1, c2, c3) || value >= Math.max(c0, c1, c2, c3)) return;
  const o1 = horizontal ? seg.c1.x : seg.c1.y;
  const o2 = horizontal ? seg.c2.x : seg.c2.y;
  // 冪の形の係数: c(t) = ((ca t + cb) t + cc) t + c0
  const ca = -c0 + 3 * c1 - 3 * c2 + c3;
  const cb = 3 * c0 - 6 * c1 + 3 * c2;
  const cc = 3 * (c1 - c0);
  // 極値 (c'(t) = 3 ca t² + 2 cb t + cc = 0) で単調な区間に分ける
  let e1 = 2;
  let e2 = 2;
  const qa = 3 * ca;
  const qb = 2 * cb;
  const scale = Math.max(Math.abs(qa), Math.abs(qb), Math.abs(cc));
  if (scale > 0) {
    if (Math.abs(qa) <= 1e-12 * scale) {
      if (Math.abs(qb) > 1e-12 * scale) e1 = -cc / qb;
    } else {
      const disc = qb * qb - 4 * qa * cc;
      if (disc > 0) {
        const q = -(qb + (qb >= 0 ? 1 : -1) * Math.sqrt(disc)) / 2;
        e1 = q / qa;
        e2 = q !== 0 ? cc / q : 2;
      } else if (disc === 0) {
        e1 = -qb / (2 * qa);
      }
    }
  }
  if (!(e1 > 0 && e1 < 1)) e1 = 2;
  if (!(e2 > 0 && e2 < 1)) e2 = 2;
  if (e2 < e1) {
    const tmp = e1;
    e1 = e2;
    e2 = tmp;
  }
  let t0 = 0;
  let v0 = c0;
  for (let i = 0; i < 3; i++) {
    const t1 = i === 0 ? e1 : i === 1 ? e2 : 1;
    if (t1 > 1) continue;
    const v1 = t1 === 1 ? c3 : ((ca * t1 + cb) * t1 + cc) * t1 + c0;
    const ta = t0;
    const va = v0;
    t0 = t1;
    v0 = v1;
    if (va === v1) continue;
    const increasing = v1 > va;
    if (increasing ? value < va || value >= v1 : value < v1 || value >= va) continue;
    if (!exact) {
      visit(Infinity, increasing ? sign : -sign);
      continue;
    }
    const t =
      va === value ? ta : solveMonotone(ca, cb, cc, c0 - value, ta, t1, va - value, v1 - value);
    const other = t === 0 ? o0 : cubicAt(o0, o1, o2, o3, t);
    visit(other, increasing ? sign : -sign);
  }
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * 単調な区間 [t0, t1] で ((a t + b) t + c) t + d = 0 の t (両端の値 f0 と f1 の符号は逆)。Illinois 法。
 */
function solveMonotone(
  a: number,
  b: number,
  c: number,
  d: number,
  t0: number,
  t1: number,
  f0: number,
  f1: number,
): number {
  let lo = t0;
  let hi = t1;
  let flo = f0;
  let fhi = f1;
  let side = 0;
  let t = lo;
  for (let iter = 0; iter < 80; iter++) {
    t = (lo * fhi - hi * flo) / (fhi - flo);
    if (!(t > lo && t < hi)) t = (lo + hi) / 2;
    const ft = ((a * t + b) * t + c) * t + d;
    if (ft === 0 || hi - lo <= 1e-15) return t;
    if (flo * ft < 0) {
      hi = t;
      fhi = ft;
      if (side === -1) flo /= 2;
      side = -1;
    } else {
      lo = t;
      flo = ft;
      if (side === 1) fhi /= 2;
      side = 1;
    }
  }
  return t;
}
