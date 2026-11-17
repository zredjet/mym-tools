/**
 * ブーリアン演算の前半: 入力の輪郭を交点で分け、部分 (piece) の並びと頂点にする
 * (`docs/canvas-editor-design.md` §8.9.3)。
 *
 * 返すもの (`splitOperands`):
 * - `pieces`: 入力の曲線を交点・接点・重なりの端・自己交差で分けた部分。どの 2 つも端以外では交わらない
 *   (重なった部分は、同じ頂点の組を結ぶ同じ形の部分として別々に残る。まとめるのは `graph.ts`)
 * - 部分の端は頂点の番号 (`from` / `to`) を持ち、形の端点は頂点の点そのもの (つなぎ直した輪郭が
 *   ちょうど閉じるように)
 * - 交点を探し尽くせなかった (`intersectSegments` の `complete` が false) とき、同じ頂点にまとめた点が
 *   離れすぎているときは null
 *
 * 進め方:
 * 1. 各入力の輪郭を、閉じた線分の並びにする (開いた輪郭は閉じる。長さ 0 の線分は除く)
 * 2. 輪郭の継ぎ目 (前の線分の t = 1 と次の線分の t = 0) を同じ頂点にする
 * 3. 範囲が重なる線分の組 (x で並べて掃く) の交点と重なり、3 次ベジェ 1 本の自己交差を求め、
 *    両方の線分に分ける点 (event) を足して同じ頂点にする。輪郭で隣り合う 2 本は、継ぎ目を通る直線で
 *    分けられるなら継ぎ目でしか会わないので調べない (アイコンでは組の大半がこれ)
 * 4. 線分ごとに分ける点を t の順に並べ、間の曲線が短すぎる (`merge` 以下) 点どうしを 1 つにまとめる
 *    (継ぎ目の近くで同じ交点が 2 回報告される場合や、端点のすぐ近くの交点)。まとめた点は同じ頂点
 * 5. 頂点の点は、輪郭の継ぎ目 (入力の点そのもの) を含めばそれ、なければ最初の交点
 */
import {
  type Bounds,
  controlBounds,
  controlPoints,
  dot,
  isDegenerate,
  pointAt,
  type Segment,
  segmentMagnitude,
  subSegment,
  tangentAt,
} from "../geometry/bezier";
import { intersectSegments, selfIntersection } from "../geometry/intersect";
import type { Point } from "../model/types";
import { subpathToSegments } from "../path/segments";
import type { BooleanOperand } from "./index";

export interface Tolerances {
  /** 交わるとみなす距離 (`intersectSegments` に渡す) */
  intersect: number;
  /** 同じ点にまとめる距離。間の曲線の長さがこれ以下の分ける点は 1 つにする */
  merge: number;
  /** 同じ頂点にまとめた点が、頂点の点からこれより離れていたら求められなかったとする */
  spread: number;
}

/** 入力の曲線 1 本。 */
export interface InputSegment {
  seg: Segment;
  operand: number;
  contour: number;
  /** 輪郭の中の添字 */
  index: number;
  bounds: Bounds;
}

export interface InputContour {
  operand: number;
  /** `segments` の中の先頭の添字 */
  first: number;
  count: number;
}

/** 交点で分けた部分。 */
export interface Piece {
  /** 端点は頂点の点そのもの */
  seg: Segment;
  operand: number;
  /** 元の線分 (`InputSegment`) の添字 */
  source: number;
  /** 元の線分の上の範囲 (t0 < t1) */
  t0: number;
  t1: number;
  /** 頂点の番号 */
  from: number;
  to: number;
  /** 同じ輪郭で次と前の部分 (`pieces` の添字) */
  next: number;
  prev: number;
}

export interface SplitResult {
  segments: readonly InputSegment[];
  contours: readonly InputContour[];
  pieces: Piece[];
  vertices: Point[];
}

/** 座標の大きさに合わせた許容値。 */
export function tolerancesFor(intersect: number): Tolerances {
  return { intersect, merge: 8 * intersect, spread: 128 * intersect };
}

/** 入力の輪郭を閉じた線分の並びにする。座標の絶対値の最大も返す。 */
export function collectSegments(operands: readonly BooleanOperand[]): {
  segments: InputSegment[];
  contours: InputContour[];
  magnitude: number;
} {
  const raw: { operand: number; segs: Segment[] }[] = [];
  let magnitude = 0;
  operands.forEach((operand, k) => {
    for (const sub of operand.subpaths) {
      const segs = subpathToSegments(sub, { implicitClose: true });
      if (segs.length === 0) continue;
      for (const s of segs) magnitude = Math.max(magnitude, segmentMagnitude(s));
      raw.push({ operand: k, segs });
    }
  });
  return { ...buildContours(raw, magnitude), magnitude };
}

function buildContours(
  raw: readonly { operand: number; segs: Segment[] }[],
  magnitude: number,
): { segments: InputSegment[]; contours: InputContour[] } {
  // 長さ 0 の線分を除く許容値は、交点と同じ規則 (座標の大きさ × 1e-10、下限 1e-7)
  const tol = Math.max(1e-7, magnitude * 1e-10);
  const segments: InputSegment[] = [];
  const contours: InputContour[] = [];
  for (const { operand, segs } of raw) {
    const kept = segs.filter((s) => !isDegenerate(s, tol));
    if (kept.length === 0) continue;
    const contour = contours.length;
    contours.push({ operand, first: segments.length, count: kept.length });
    kept.forEach((seg, index) => {
      segments.push({ seg, operand, contour, index, bounds: controlBounds(seg) });
    });
  }
  return { segments, contours };
}

// ---------------------------------------------------------------------------
// 分ける点 (event) と、同じ頂点のまとめ (union-find)
// ---------------------------------------------------------------------------

interface SplitEvent {
  segment: number;
  t: number;
  point: Point;
  /** 輪郭の継ぎ目 (入力の点そのもの) */
  joint: boolean;
}

class Events {
  readonly list: SplitEvent[] = [];
  private readonly parent: number[] = [];

  add(segment: number, t: number, point: Point, joint: boolean): number {
    const id = this.list.length;
    this.list.push({ segment, t: t < 0 ? 0 : t > 1 ? 1 : t, point, joint });
    this.parent.push(id);
    return id;
  }

  find(id: number): number {
    let root = id;
    while (this.parent[root] !== root) root = this.parent[root]!;
    // 経路を縮める
    let cur = id;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // 小さい番号を根にする (結果を入力の順だけで決める)
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }

  /** 2 本の線分の同じ点を、同じ頂点として足す。 */
  link(a: number, ta: number, b: number, tb: number, point: Point): void {
    const ea = this.add(a, ta, point, false);
    const eb = this.add(b, tb, point, false);
    this.union(ea, eb);
  }
}

// ---------------------------------------------------------------------------
// 分ける
// ---------------------------------------------------------------------------

export function splitOperands(
  segments: readonly InputSegment[],
  contours: readonly InputContour[],
  tol: Tolerances,
): SplitResult | null {
  const events = new Events();
  // 1. 輪郭の継ぎ目
  for (const c of contours) {
    for (let i = 0; i < c.count; i++) {
      const cur = c.first + i;
      const next = c.first + ((i + 1) % c.count);
      const point = segments[next]!.seg.from;
      const e1 = events.add(cur, 1, point, true);
      const e2 = events.add(next, 0, point, true);
      events.union(e1, e2);
    }
  }
  // 2. 自己交差
  segments.forEach((s, i) => {
    if (s.seg.kind !== "cubic") return;
    const self = selfIntersection(s.seg, { tolerance: tol.intersect });
    if (self) events.link(i, self.t1, i, self.t2, self.point);
  });
  // 3. 組の交点
  for (const [a, b] of candidatePairs(segments, tol.intersect)) {
    if (!intersectPair(segments, contours, a, b, tol, events)) return null;
  }
  // 4. 線分ごとに分ける点をまとめる
  const eventIds: number[][] = segments.map(() => []);
  events.list.forEach((e, id) => eventIds[e.segment]!.push(id));
  /** 線分ごとの、分ける t と、その点の event (同じ頂点の代表) */
  const cuts: { t: number; event: number }[][] = [];
  segments.forEach((s, i) => {
    const ids = eventIds[i]!.slice().sort((p, q) => {
      const d = events.list[p]!.t - events.list[q]!.t;
      return d !== 0 ? d : p - q;
    });
    const out: { t: number; event: number; ts: number[] }[] = [];
    for (const id of ids) {
      const e = events.list[id]!;
      const last = out[out.length - 1];
      if (last && shortBetween(s.seg, last.ts[last.ts.length - 1]!, e.t, tol.merge)) {
        events.union(last.event, id);
        last.ts.push(e.t);
        continue;
      }
      out.push({ t: e.t, event: id, ts: [e.t] });
    }
    cuts.push(
      out.map((c) => ({
        // 端 (0 / 1) を含むなら端そのもの
        t: c.ts.includes(0) ? 0 : c.ts.includes(1) ? 1 : c.ts[0]!,
        event: c.event,
      })),
    );
  });
  // 5. 頂点の番号と点
  const vertexOf = new Map<number, number>();
  const vertices: Point[] = [];
  const hasJoint: boolean[] = [];
  events.list.forEach((e, id) => {
    const root = events.find(id);
    let v = vertexOf.get(root);
    if (v === undefined) {
      v = vertices.length;
      vertexOf.set(root, v);
      vertices.push(e.point);
      hasJoint.push(e.joint);
    } else if (e.joint && !hasJoint[v]) {
      vertices[v] = e.point;
      hasJoint[v] = true;
    }
  });
  // まとめた点が離れすぎていないか (近い点のまとめが鎖のようにつながった場合)
  for (let id = 0; id < events.list.length; id++) {
    const e = events.list[id]!;
    const v = vertexOf.get(events.find(id))!;
    const p = vertices[v]!;
    if (Math.hypot(e.point.x - p.x, e.point.y - p.y) > tol.spread) return null;
  }
  // 6. 部分
  const pieces: Piece[] = [];
  segments.forEach((s, i) => {
    const list = cuts[i]!;
    for (let k = 0; k + 1 < list.length; k++) {
      const a = list[k]!;
      const b = list[k + 1]!;
      if (b.t <= a.t) continue;
      const from = vertexOf.get(events.find(a.event))!;
      const to = vertexOf.get(events.find(b.event))!;
      const sub = subSegment(s.seg, a.t, b.t);
      if (from === to && controlLength(sub) <= 4 * tol.spread) continue; // 潰れた部分
      pieces.push({
        seg: withEnds(sub, vertices[from]!, vertices[to]!),
        operand: s.operand,
        source: i,
        t0: a.t,
        t1: b.t,
        from,
        to,
        next: -1,
        prev: -1,
      });
    }
  });
  // 輪郭ごとの部分の並び (線分の順、t の順に作ってあるので、輪郭の部分は続いている)
  let start = 0;
  while (start < pieces.length) {
    const contour = segments[pieces[start]!.source]!.contour;
    let end = start;
    while (end < pieces.length && segments[pieces[end]!.source]!.contour === contour) end++;
    for (let k = start; k < end; k++) {
      pieces[k]!.next = k + 1 < end ? k + 1 : start;
      pieces[k]!.prev = k > start ? k - 1 : end - 1;
    }
    start = end;
  }
  return { segments, contours, pieces, vertices };
}

/** 範囲 (制御点の範囲) が重なる線分の組 (a < b)。x で並べて掃く。結果は (a, b) の昇順。 */
function candidatePairs(segments: readonly InputSegment[], margin: number): [number, number][] {
  const order = segments.map((_, i) => i);
  order.sort((p, q) => {
    const d = segments[p]!.bounds.minX - segments[q]!.bounds.minX;
    return d !== 0 ? d : p - q;
  });
  const pairs: [number, number][] = [];
  for (let i = 0; i < order.length; i++) {
    const a = order[i]!;
    const ba = segments[a]!.bounds;
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j]!;
      const bb = segments[b]!.bounds;
      if (bb.minX > ba.maxX + margin) break;
      if (bb.minY > ba.maxY + margin || ba.minY > bb.maxY + margin) continue;
      pairs.push(a < b ? [a, b] : [b, a]);
    }
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return pairs;
}

type Adjacency = "none" | "forward" | "backward" | "both";

/** a と b が同じ輪郭で隣り合うか。forward は a の終点が b の始点、backward は b の終点が a の始点。 */
function adjacency(
  segments: readonly InputSegment[],
  contours: readonly InputContour[],
  a: number,
  b: number,
): Adjacency {
  const A = segments[a]!;
  const B = segments[b]!;
  if (A.contour !== B.contour) return "none";
  const n = contours[A.contour]!.count;
  const forward = (A.index + 1) % n === B.index;
  const backward = (B.index + 1) % n === A.index;
  if (forward && backward) return "both";
  return forward ? "forward" : backward ? "backward" : "none";
}

/** 組の交点を足す。探し尽くせなかったら false。 */
function intersectPair(
  segments: readonly InputSegment[],
  contours: readonly InputContour[],
  a: number,
  b: number,
  tol: Tolerances,
  events: Events,
): boolean {
  const A = segments[a]!.seg;
  const B = segments[b]!.seg;
  const adj = adjacency(segments, contours, a, b);
  if (adj === "forward" && meetOnlyAtJoint(A, B, tol.intersect)) return true;
  if (adj === "backward" && meetOnlyAtJoint(B, A, tol.intersect)) return true;
  if (adj === "none" && separatedByBands(A, B, tol.intersect)) return true;
  const r = intersectSegments(A, B, { tolerance: tol.intersect });
  if (!r.complete) return false;
  for (const x of r.intersections) {
    // 継ぎ目そのもの (輪郭で隣り合う 2 本の共有の端点) は交点ではない
    if ((adj === "forward" || adj === "both") && x.t1 === 1 && x.t2 === 0) continue;
    if ((adj === "backward" || adj === "both") && x.t1 === 0 && x.t2 === 1) continue;
    events.link(a, x.t1, b, x.t2, x.point);
  }
  for (const o of r.overlaps) {
    events.link(a, o.t1[0], b, o.t2[0], pointAt(A, o.t1[0]));
    events.link(a, o.t1[1], b, o.t2[1], pointAt(A, o.t1[1]));
  }
  return true;
}

/**
 * 2 本の 3 次ベジェが交わらないと安く分かるか (`intersectSegments` の前の絞り込み)。曲線は制御点の凸包の中に
 * あるので、片方の弦の向きとその法線の向きのそれぞれで、制御点の座標の帯 (fat line と、弦に沿った幅) を作り、
 * 相手の制御点がすべて帯の片側の外 (許容値より遠く) なら交わらない。線分を含む組は `intersectSegments` が
 * 安く解くので調べない。
 */
function separatedByBands(a: Segment, b: Segment, tol: number): boolean {
  if (a.kind !== "cubic" || b.kind !== "cubic") return false;
  return bandSeparates(a, b, tol) || bandSeparates(b, a, tol);
}

function bandSeparates(a: Segment, b: Segment, tol: number): boolean {
  const dx = a.to.x - a.from.x;
  const dy = a.to.y - a.from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return false;
  const ux = dx / len;
  const uy = dy / len;
  const pa = controlPoints(a);
  const pb = controlPoints(b);
  for (const [vx, vy] of [
    [-uy, ux],
    [ux, uy],
  ] as const) {
    let aLo = Infinity;
    let aHi = -Infinity;
    for (const p of pa) {
      const d = (p.x - a.from.x) * vx + (p.y - a.from.y) * vy;
      if (d < aLo) aLo = d;
      if (d > aHi) aHi = d;
    }
    let bLo = Infinity;
    let bHi = -Infinity;
    for (const p of pb) {
      const d = (p.x - a.from.x) * vx + (p.y - a.from.y) * vy;
      if (d < bLo) bLo = d;
      if (d > bHi) bHi = d;
    }
    if (bLo > aHi + tol || bHi < aLo - tol) return true;
  }
  return false;
}

/**
 * 輪郭で続く 2 本 (a の終点 = b の始点 = P) が P でしか会わないか。P を通る直線で、a のほかの制御点と
 * b のほかの制御点を (許容値より離して) 分けられれば、曲線はそれぞれの制御点の凸包の中にあるので
 * P のほかでは会わない。直線の法線は、進む向きの和 (滑らかな継ぎ目なら接線、角なら二等分)、b の向き、a の向き。
 */
function meetOnlyAtJoint(a: Segment, b: Segment, tol: number): boolean {
  const P = a.to;
  const da = tangentAt(a, 1);
  const db = tangentAt(b, 0);
  if (!da || !db) return false;
  const sum = { x: da.x + db.x, y: da.y + db.y };
  const len = Math.hypot(sum.x, sum.y);
  const normals = len > 1e-6 ? [{ x: sum.x / len, y: sum.y / len }, db, da] : [db, da];
  const aPts = controlPoints(a).slice(0, -1);
  const bPts = controlPoints(b).slice(1);
  const margin = 4 * tol;
  for (const n of normals) {
    // a の制御点は P より後ろ (内積が負)、b の制御点は前。P に重なる制御点 (長さ 0 のハンドル) は除く
    const separated =
      aPts.every((q) => {
        const v = { x: q.x - P.x, y: q.y - P.y };
        return Math.hypot(v.x, v.y) <= margin || dot(v, n) < -margin;
      }) &&
      bPts.every((q) => {
        const v = { x: q.x - P.x, y: q.y - P.y };
        return Math.hypot(v.x, v.y) <= margin || dot(v, n) > margin;
      });
    if (separated) return true;
  }
  return false;
}

/** 線分 seg の t0 から t1 までの曲線が短い (制御点の折れ線の長さが `limit` 以下)。 */
function shortBetween(seg: Segment, t0: number, t1: number, limit: number): boolean {
  if (t1 === t0) return true;
  return controlLength(subSegment(seg, t0, t1)) <= limit;
}

/** 制御点の折れ線の長さ (曲線の長さの上限)。 */
export function controlLength(seg: Segment): number {
  const pts = controlPoints(seg);
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return len;
}

/** 端点を差し替えた曲線 (制御点はそのまま)。 */
export function withEnds(seg: Segment, from: Point, to: Point): Segment {
  const f = { x: from.x, y: from.y };
  const t = { x: to.x, y: to.y };
  return seg.kind === "line"
    ? { kind: "line", from: f, to: t }
    : { kind: "cubic", from: f, c1: seg.c1, c2: seg.c2, to: t };
}
