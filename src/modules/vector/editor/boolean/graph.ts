/**
 * ブーリアン演算の後半: 部分を辺にまとめ、両側の巻き数から残す辺を選び、閉じた輪郭につなぎ直す
 * (`docs/canvas-editor-design.md` §8.9.3)。
 *
 * - 辺: 同じ頂点の組を結ぶ同じ形の部分 (重なった辺) を 1 つにまとめたもの。代表の部分の向きを辺の向きにし、
 *   入力ごとの寄与 (代表と同じ向きの部分は +1、逆向きは -1 の和) を持つ
 * - 道 (run): 次数 2 の頂点 (ほかの曲線が通らない継ぎ目) でつながった辺の並び。道の上では両側の巻き数が
 *   変わらないので、道ごとに 1 回だけ光線で数える (`winding.ts`)。決まらない点なら別の点で数え直す
 * - 残す辺: 左右で「結果の面の内側か」が違う辺。内側が右に来る向き (時計回りの外側、y が下向き) にそろえる
 * - つなぎ直し: 残す辺はどれも内側を右に持つので、たどった輪郭は外側が時計回り、穴が反時計回りになる。
 *   出る残す辺が 2 本以上ある頂点 (結果の面が 1 点で触れる所) では、入力の同じ輪郭の続きを先に選び、
 *   残りは来た辺の逆向きから角度の小さい向き (y が下向きの画面で反時計回り) に回って最初に当たる辺にする
 *   (`pairAtVertices`)。触れる 2 つの面も、外側とそれに接する穴も、別の輪郭に分かれる
 *
 * 矛盾の検査 (どれかに当たれば null。誤った面を返すより求められなかったとする):
 * - 辺の右と左の巻き数の差が、その辺の寄与と同じ
 * - 頂点ごとに、残す辺の入る数と出る数が同じ
 * - 頂点のまわりの扇形ごとに、両側の辺から見た巻き数が同じ (向きがはっきり分かれる頂点だけ)
 * - つなぎ直しで、どの辺も 1 回だけ通り、輪郭が閉じる
 */
import {
  type Segment,
  nearestPoint,
  pointAt,
  reverseSegment,
  segmentLength,
  subSegment,
  tAtLength,
  tangentAt,
} from "../geometry/bezier";
import type { BooleanOp, FillRule, Point, Subpath } from "../model/types";
import { signedArea } from "../path/measure";
import { segmentsToSubpath } from "../path/segments";
import { controlLength, type InputSegment, type Piece, type Tolerances, withEnds } from "./split";
import {
  createWindingContext,
  type SideWindings,
  type WindingContext,
  windingsAt,
} from "./winding";

export interface Edge {
  /** 代表の部分の形 (辺の向き) */
  seg: Segment;
  from: number;
  to: number;
  /** 代表の部分の、元の線分と範囲 */
  source: number;
  t0: number;
  t1: number;
  /** 属する部分 (重なった辺なら複数)。先頭が代表 */
  pieces: number[];
  /** 部分ごとの向き (代表と同じなら 1、逆なら -1) */
  signs: number[];
  /** 入力ごとの寄与 */
  contrib: number[];
  left: number[] | null;
  right: number[] | null;
}

interface End {
  edge: number;
  /** 辺がこの頂点から出る (代表の向きで) */
  out: boolean;
}

/** 部分の t = 0.25, 0.5, 0.75 の点が相手から `tol` 以内か。 */
function sameCurve(p: Segment, q: Segment, tol: number): boolean {
  for (const s of [0.5, 0.25, 0.75]) {
    if (nearestPoint(q, pointAt(p, s)).distance > tol) return false;
  }
  return nearestPoint(p, pointAt(q, 0.5)).distance <= tol;
}

/** 部分を辺にまとめる。 */
export function groupPieces(
  pieces: readonly Piece[],
  operandCount: number,
  sameTol: number,
): Edge[] {
  const edges: Edge[] = [];
  const byPair = new Map<string, number[]>();
  pieces.forEach((piece, index) => {
    const key = piece.from < piece.to ? `${piece.from},${piece.to}` : `${piece.to},${piece.from}`;
    const candidates = byPair.get(key);
    if (candidates) {
      for (const e of candidates) {
        const edge = edges[e]!;
        if (!sameCurve(piece.seg, edge.seg, sameTol)) continue;
        let sign: number;
        if (piece.from !== piece.to) {
          sign = piece.from === edge.from ? 1 : -1;
        } else {
          // 同じ頂点に戻る輪: 向きを接線で比べる
          const tp = tangentAt(piece.seg, 0.5);
          const np = nearestPoint(edge.seg, pointAt(piece.seg, 0.5));
          const tq = tangentAt(edge.seg, np.t);
          sign = tp && tq && tp.x * tq.x + tp.y * tq.y < 0 ? -1 : 1;
        }
        edge.pieces.push(index);
        edge.signs.push(sign);
        edge.contrib[piece.operand]! += sign;
        return;
      }
    }
    const contrib = new Array<number>(operandCount).fill(0);
    contrib[piece.operand] = 1;
    const e = edges.length;
    edges.push({
      seg: piece.seg,
      from: piece.from,
      to: piece.to,
      source: piece.source,
      t0: piece.t0,
      t1: piece.t1,
      pieces: [index],
      signs: [1],
      contrib,
      left: null,
      right: null,
    });
    if (candidates) candidates.push(e);
    else byPair.set(key, [e]);
  });
  return edges;
}

function endsByVertex(edges: readonly Edge[], vertexCount: number): End[][] {
  const ends: End[][] = [];
  for (let v = 0; v < vertexCount; v++) ends.push([]);
  edges.forEach((e, i) => {
    ends[e.from]!.push({ edge: i, out: true });
    ends[e.to]!.push({ edge: i, out: false });
  });
  return ends;
}

interface Run {
  edges: number[];
  /** 道の向きが辺の向きと逆 */
  flips: boolean[];
}

/** 次数 2 の頂点でつながった辺の並び。 */
function buildRuns(edges: readonly Edge[], ends: readonly End[][]): Run[] {
  const runOf = new Int32Array(edges.length).fill(-1);
  const runs: Run[] = [];
  for (let e0 = 0; e0 < edges.length; e0++) {
    if (runOf[e0]! >= 0) continue;
    const r = runs.length;
    runOf[e0] = r;
    const list: number[] = [e0];
    const flips: boolean[] = [false];
    let cyclic = false;
    // 前へ
    let cur = e0;
    let curFlip = false;
    for (;;) {
      const edge = edges[cur]!;
      const v: number = curFlip ? edge.from : edge.to;
      const at: readonly End[] = ends[v]!;
      if (at.length !== 2) break;
      const arrivalOut = curFlip;
      const other: End = at[0]!.edge === cur && at[0]!.out === arrivalOut ? at[1]! : at[0]!;
      if (other.edge === e0) {
        cyclic = true;
        break;
      }
      if (runOf[other.edge]! >= 0) break;
      runOf[other.edge] = r;
      cur = other.edge;
      curFlip = !other.out;
      list.push(cur);
      flips.push(curFlip);
    }
    if (!cyclic) {
      // 後ろへ
      cur = e0;
      curFlip = false;
      for (;;) {
        const edge = edges[cur]!;
        const v: number = curFlip ? edge.to : edge.from;
        const at: readonly End[] = ends[v]!;
        if (at.length !== 2) break;
        const departureOut = !curFlip;
        const other: End = at[0]!.edge === cur && at[0]!.out === departureOut ? at[1]! : at[0]!;
        if (runOf[other.edge]! >= 0) break;
        runOf[other.edge] = r;
        cur = other.edge;
        // 前の辺はこの頂点に入る: 代表の向きで入る (out が false) なら逆にしない
        curFlip = other.out;
        list.unshift(cur);
        flips.unshift(curFlip);
      }
    }
    runs.push({ edges: list, flips });
  }
  return runs;
}

const SAMPLE_PARAMS = [0.5, 0.3, 0.7, 0.15, 0.85, 0.42, 0.58];
const SAMPLE_EDGES = 4;

/** 道ごとに巻き数を求め、辺に入れる。決まらない道、矛盾する辺があれば false。 */
function assignWindings(edges: Edge[], runs: readonly Run[], ctx: WindingContext): boolean {
  for (const run of runs) {
    const order = run.edges
      .map((e, i) => ({ e, i, size: controlLength(edges[e]!.seg) }))
      .sort((a, b) => b.size - a.size || a.i - b.i)
      .slice(0, SAMPLE_EDGES);
    let found: SideWindings | null = null;
    for (const { e, i } of order) {
      for (const s of SAMPLE_PARAMS) {
        const w = windingsAt(ctx, e, edges[e]!.seg, edges[e]!.pieces.length, s);
        if (!w) continue;
        // 道の向きにそろえる
        found = run.flips[i] ? { left: w.right, right: w.left } : w;
        break;
      }
      if (found) break;
    }
    if (!found) return false;
    run.edges.forEach((e, i) => {
      const edge = edges[e]!;
      if (run.flips[i]) {
        edge.left = found!.right;
        edge.right = found!.left;
      } else {
        edge.left = found!.left;
        edge.right = found!.right;
      }
    });
  }
  // 右と左の差は辺の寄与 (時計回りの内側は右)
  for (const edge of edges) {
    for (let k = 0; k < edge.contrib.length; k++) {
      if (edge.right![k]! - edge.left![k]! !== edge.contrib[k]!) return false;
    }
  }
  return true;
}

function insideOf(w: number, rule: FillRule): boolean {
  return rule === "evenodd" ? (w & 1) === 1 : w !== 0;
}

/** 入力ごとの巻き数から、結果の面の内側か。 */
export function resultInside(
  op: BooleanOp,
  w: readonly number[],
  rules: readonly FillRule[],
): boolean {
  switch (op) {
    case "union":
      return w.some((x, k) => insideOf(x, rules[k]!));
    case "intersect":
      return w.length > 0 && w.every((x, k) => insideOf(x, rules[k]!));
    case "exclude": {
      let count = 0;
      w.forEach((x, k) => {
        if (insideOf(x, rules[k]!)) count++;
      });
      return (count & 1) === 1;
    }
    case "subtract":
      return (
        w.length > 0 &&
        insideOf(w[0]!, rules[0]!) &&
        !w.some((x, k) => k > 0 && insideOf(x, rules[k]!))
      );
  }
}

// ---------------------------------------------------------------------------
// 頂点での向き
// ---------------------------------------------------------------------------

/** 頂点から出る曲線 (入る辺は逆向き)。 */
function departure(edges: readonly Edge[], end: End): Segment {
  const seg = edges[end.edge]!.seg;
  return end.out ? seg : reverseSegment(seg);
}

/** 接線の向きがこれより近い端があれば、少し進んだ点への向きで比べる (rad)。 */
const NEAR_ANGLE = 1e-2;

/**
 * 頂点 v の端ごとの向き (atan2)。ふつうは接線の向き。接線が近い端 (接する曲線など) があれば、どの端も、
 * 頂点から少し進んだ点 (頂点に集まる部分の最も短いものの長さの 1/4) への向きにする: 同じ接線の曲線も
 * 曲がり方の違いで分けられる。部分は端のほかで交わらないので、その範囲で向きの順は変わらない。
 * 頂点ごとに 1 つの物差しで測る (比べ方を混ぜると順が決まらなくなる)。
 */
function endAngles(edges: readonly Edge[], v: Point, at: readonly End[]): number[] {
  const deps = at.map((end) => departure(edges, end));
  const tangents = deps.map((d) => {
    const t = tangentAt(d, 0);
    return t ? Math.atan2(t.y, t.x) : Number.NaN;
  });
  const sorted = tangents.slice().sort((a, b) => a - b);
  let separated = sorted.every((a) => !Number.isNaN(a));
  for (let i = 0; separated && i < sorted.length; i++) {
    const a = sorted[i]!;
    const b = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + TWO_PI;
    if (b - a < NEAR_ANGLE) separated = false;
  }
  if (separated) return tangents;
  let shortest = Infinity;
  for (const d of deps) shortest = Math.min(shortest, segmentLength(d));
  const delta = shortest / 4;
  return deps.map((d) => {
    const q = pointAt(d, tAtLength(d, delta));
    return Math.atan2(q.y - v.y, q.x - v.x);
  });
}

const TWO_PI = Math.PI * 2;

/** 角度の小さい向きへ a から b まで回る量 (0 より大きく 2π 以下)。 */
function clockwiseFrom(a: number, b: number): number {
  let r = (a - b) % TWO_PI;
  if (r <= 0) r += TWO_PI;
  return r;
}

/** 頂点のまわりの扇形ごとに、両側の辺から見た巻き数が同じか。向きが近すぎる頂点は調べない。 */
function sectorsConsistent(
  edges: readonly Edge[],
  at: readonly End[],
  angles: readonly number[],
): boolean {
  const order = at.map((_, i) => i).sort((a, b) => angles[a]! - angles[b]! || a - b);
  for (let i = 0; i < order.length; i++) {
    const a = angles[order[i]!]!;
    const b = i + 1 < order.length ? angles[order[i + 1]!]! : angles[order[0]!]! + TWO_PI;
    if (b - a < 1e-6) return true;
  }
  for (let i = 0; i < order.length; i++) {
    const e1 = at[order[i]!]!;
    const e2 = at[order[(i + 1) % order.length]!]!;
    // 出る向きで角度の大きい側は進む向きの右。入る辺 (逆向き) では代表の左
    const after = e1.out ? edges[e1.edge]!.right! : edges[e1.edge]!.left!;
    const before = e2.out ? edges[e2.edge]!.left! : edges[e2.edge]!.right!;
    for (let k = 0; k < after.length; k++) if (after[k] !== before[k]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------

export interface GraphInput {
  segments: readonly InputSegment[];
  pieces: readonly Piece[];
  vertices: readonly Point[];
  rules: readonly FillRule[];
  tol: Tolerances;
}

/** 部分から結果の輪郭を作る。矛盾があれば null。 */
export function buildResult(op: BooleanOp, input: GraphInput): Subpath[] | null {
  const { pieces, vertices, rules, tol } = input;
  const operandCount = rules.length;
  const sameTol = tol.spread;
  const edges = groupPieces(pieces, operandCount, sameTol);
  if (edges.length === 0) return [];
  const ends = endsByVertex(edges, vertices.length);
  const runs = buildRuns(edges, ends);
  const edgeOf = new Array<number>(pieces.length).fill(-1);
  edges.forEach((e, i) => {
    for (const p of e.pieces) edgeOf[p] = i;
  });
  const ctx = createWindingContext(
    pieces.map((p) => p.seg),
    pieces.map((p) => p.operand),
    edgeOf,
    operandCount,
    2 * sameTol,
    tol.merge,
  );
  if (!assignWindings(edges, runs, ctx)) return null;

  // 残す辺と向き
  const keepReversed = new Int8Array(edges.length).fill(-1); // -1 残さない、0 そのまま、1 逆
  const outCount = new Int32Array(vertices.length);
  const inCount = new Int32Array(vertices.length);
  edges.forEach((e, i) => {
    const l = resultInside(op, e.left!, rules);
    const r = resultInside(op, e.right!, rules);
    if (l === r) return;
    keepReversed[i] = r ? 0 : 1;
    const from = r ? e.from : e.to;
    const to = r ? e.to : e.from;
    outCount[from]!++;
    inCount[to]!++;
  });
  for (let v = 0; v < vertices.length; v++) if (outCount[v] !== inCount[v]) return null;

  // 頂点の向き (必要な頂点だけ)
  const angleCache = new Map<number, number[]>();
  const anglesAt = (v: number): number[] => {
    let a = angleCache.get(v);
    if (!a) {
      a = endAngles(edges, vertices[v]!, ends[v]!);
      angleCache.set(v, a);
    }
    return a;
  };
  for (let v = 0; v < vertices.length; v++) {
    if (ends[v]!.length >= 3 && !sectorsConsistent(edges, ends[v]!, anglesAt(v))) return null;
  }

  // つなぎ直し: 頂点ごとに、入る残す辺から出る残す辺への対応を決めてからたどる
  const succ = pairAtVertices(input.pieces, edges, ends, keepReversed, outCount, anglesAt);
  if (!succ) return null;
  const used = new Uint8Array(edges.length);
  const loops: number[][] = [];
  for (let start = 0; start < edges.length; start++) {
    if (keepReversed[start]! < 0 || used[start]) continue;
    const loop: number[] = [];
    let cur = start;
    for (let guard = 0; ; guard++) {
      if (guard > edges.length) return null;
      used[cur] = 1;
      loop.push(cur);
      const next = succ[cur]!;
      if (next < 0) return null;
      if (next === start) break;
      if (used[next]) return null;
      cur = next;
    }
    loops.push(loop);
  }

  const out: Subpath[] = [];
  for (const loop of loops) {
    const sub = loopToSubpath(loop, edges, keepReversed, input);
    if (sub) out.push(sub);
  }
  return out;
}

/**
 * 頂点ごとに、入る残す辺から出る残す辺への対応 (`succ[入る辺] = 出る辺`)。
 * - 出る辺が 1 本なら、それ
 * - 2 本以上 (結果の面が頂点で触れる所) なら、まず入力の同じ輪郭の続き (入る辺の元の部分の次の部分) が
 *   出る残す辺ならそれにする。触れる 2 つの面を別の輪郭に分け、外側と、外側に接する穴も分ける
 *   (面の境界を回るだけだと、外側と穴が接点で 1 つの輪郭になる)
 * - 残りは、来た辺の逆向きから角度の小さい向きに回って最初に当たる、まだ選ばれていない出る辺
 * どの対応でも面は同じ (残す辺をすべて 1 回ずつ通る閉じた輪郭になる)。違うのは輪郭の分け方だけ。
 */
function pairAtVertices(
  pieces: readonly Piece[],
  edges: readonly Edge[],
  ends: readonly End[][],
  keepReversed: Int8Array,
  outCount: Int32Array,
  anglesAt: (v: number) => number[],
): Int32Array | null {
  const succ = new Int32Array(edges.length).fill(-1);
  const edgeOfPiece = new Int32Array(pieces.length).fill(-1);
  const signOfPiece = new Int8Array(pieces.length);
  edges.forEach((e, i) => {
    e.pieces.forEach((p, k) => {
      edgeOfPiece[p] = i;
      signOfPiece[p] = e.signs[k]!;
    });
  });
  /** 残す辺 e の、残す向きでの終わりの頂点で、元の輪郭の続きにあたる残す辺 (なければ -1) */
  const continuation = (e: number): number => {
    const reversed = keepReversed[e] === 1;
    const piece = pieces[edges[e]!.pieces[0]!]!;
    // 代表の部分の向きに進むなら次の部分を前へ、逆なら前の部分を後ろへ
    const q = reversed ? piece.prev : piece.next;
    const f = edgeOfPiece[q]!;
    if (f < 0 || f === e || keepReversed[f]! < 0) return -1;
    // q を進む向き (逆なら q を後ろへ) が f の残す向きと同じか
    const qForward = reversed ? -1 : 1;
    const fForward = keepReversed[f] === 0 ? 1 : -1;
    return signOfPiece[q]! * qForward === fForward ? f : -1;
  };
  for (let v = 0; v < ends.length; v++) {
    const at = ends[v]!;
    if (outCount[v] === 0) continue;
    // この頂点での残す辺の役割
    const ins: number[] = [];
    const outs: number[] = [];
    at.forEach((end, i) => {
      const k = keepReversed[end.edge]!;
      if (k < 0) return;
      if (end.out === (k === 0)) outs.push(i);
      else ins.push(i);
    });
    if (outs.length === 1 && ins.length === 1) {
      succ[at[ins[0]!]!.edge] = at[outs[0]!]!.edge;
      continue;
    }
    const free = new Set(outs);
    const pending: number[] = [];
    for (const i of ins) {
      const e = at[i]!.edge;
      const c = continuation(e);
      const j = c < 0 ? -1 : (outs.find((o) => at[o]!.edge === c && free.has(o)) ?? -1);
      if (j >= 0) {
        succ[e] = c;
        free.delete(j);
      } else {
        pending.push(i);
      }
    }
    if (pending.length === 0) continue;
    const angles = anglesAt(v);
    for (const i of pending) {
      let best = -1;
      let bestRot = Infinity;
      for (const o of outs) {
        if (!free.has(o)) continue;
        const rot = clockwiseFrom(angles[i]!, angles[o]!);
        if (rot < bestRot) {
          bestRot = rot;
          best = o;
        }
      }
      if (best < 0) return null;
      succ[at[i]!.edge] = at[best]!.edge;
      free.delete(best);
    }
  }
  return succ;
}

interface Stretch {
  source: number;
  /** 進む順の t */
  ta: number;
  tb: number;
  from: number;
  to: number;
}

/** 残す辺の輪を輪郭にする。同じ元の線分の続いた部分は 1 本にまとめる。面積がほぼ 0 なら null。 */
function loopToSubpath(
  loop: readonly number[],
  edges: readonly Edge[],
  keepReversed: Int8Array,
  input: GraphInput,
): Subpath | null {
  const items: Stretch[] = loop.map((i) => {
    const e = edges[i]!;
    return keepReversed[i] === 1
      ? { source: e.source, ta: e.t1, tb: e.t0, from: e.to, to: e.from }
      : { source: e.source, ta: e.t0, tb: e.t1, from: e.from, to: e.to };
  });
  const joinable = (a: Stretch, b: Stretch) =>
    a.source === b.source &&
    a.tb === b.ta &&
    a.tb !== 0 &&
    a.tb !== 1 &&
    a.ta < a.tb === b.ta < b.tb;
  // つなげない継ぎ目から始める
  let start = 0;
  if (items.length > 1) {
    start = -1;
    for (let i = 0; i < items.length; i++) {
      if (!joinable(items[(i + items.length - 1) % items.length]!, items[i]!)) {
        start = i;
        break;
      }
    }
    if (start < 0) start = 0;
  }
  const merged: Stretch[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[(start + k) % items.length]!;
    const last = merged[merged.length - 1];
    if (last && joinable(last, it)) {
      last.tb = it.tb;
      last.to = it.to;
    } else {
      merged.push({ ...it });
    }
  }
  const { segments, vertices, tol } = input;
  const segs = merged.map((m) =>
    withEnds(subSegment(segments[m.source]!.seg, m.ta, m.tb), vertices[m.from]!, vertices[m.to]!),
  );
  const sub = segmentsToSubpath(segs, true, { tolerance: tol.merge });
  // 面積がほぼ 0 の輪 (細長い隙間の名残) は落とす
  let perimeter = 0;
  for (const s of segs) perimeter += controlLength(s);
  if (Math.abs(signedArea(sub)) <= tol.merge * perimeter) return null;
  return sub;
}
