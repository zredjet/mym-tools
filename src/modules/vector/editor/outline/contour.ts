/**
 * 線のアウトライン化の輪郭づくり (`docs/canvas-editor-design.md` §8.10、§8.11)。
 *
 * 線の面は、次の部品の合体 (SVG 2 の「線の形」と同じ定義):
 * - 中心線の各部分の帯 (法線に沿って太さの半分ずつ広げた範囲)
 * - 角 (元の線分の境目) の外側の形: マイター (上限 4 を超えたらベベル)・丸・ベベル
 * - 端 (開いた輪郭・破線の端): なし・丸・四角
 *
 * 部品の輪郭はどれも時計回り (y が下向きの画面で) にし、1 つの入力 (`nonzero`) にまとめてブーリアン演算の
 * 合体に渡す。時計回りの輪郭の巻き数はどこでも 0 以上なので、足し合わせた巻き数が 0 でない所が合体になる。
 *
 * 破線 1 本 (または実線の輪郭 1 本) の帯と外側の角と端は、1 本の輪郭にまとめる (よく知られた線の描き方と
 * 同じ。左の端の線を進み、終わりの端、右の端の線を戻り、始めの端。閉じた実線は左右の 2 本の閉じた輪郭)。
 * 角の内側は中心の点を通って折り返す。これは帯と角と端の輪郭を足し合わせ、重なった辺を打ち消したものと
 * 同じ巻き数になる。
 *
 * きつい側のある部分 (曲率半径が太さの半分より小さい) は、帯の輪郭が中心を越えて裏返る (巻き数 −1 の所が
 * できる)。そこで、その部分のきつい側は端の線の代わりに `pivot` (法線の交点) を通る折れ線にして、帯を
 * 「`pivot` から反対側の端の線までの扇形」にし (向きは正のまま)、向こう側に回り込む扇形 (`pivot` から
 * きつい側の端の線まで) は別の輪郭にする。
 */
import { cross, dot, type Segment } from "../geometry/bezier";
import type { Point, StrokeCap, StrokeJoin } from "../model/types";
import { leftNormal, rightNormal, sideNormal, type OffsetPiece, type Side } from "./offset";

/** SVG の既定の `stroke-miterlimit` (描画と同じ。§8.4)。 */
export const MITER_LIMIT = 4;
/** 角の向きの変わりがこれより小さい (sin) なら角を描かない (端の線がほぼつながっている)。 */
const STRAIGHT_SIN = 1e-9;

const add = (p: Point, v: Point, k = 1): Point => ({ x: p.x + v.x * k, y: p.y + v.y * k });
const perp = (v: Point): Point => ({ x: -v.y, y: v.x });
/**
 * 点 c と、a と p を通る直線の距離 (a と p が同じ点なら 0: a → c → a は面積のない行き来)。a → c → p の c を
 * 除くと、この距離を高さとする細い三角形 (c が a と p の間の外にはみ出す折り返しも含む) だけ形が変わる。
 */
const lineDistance = (c: Point, a: Point, p: Point): number => {
  const dx = p.x - a.x;
  const dy = p.y - a.y;
  const len = Math.hypot(dx, dy);
  return len === 0 ? 0 : Math.abs(dx * (c.y - a.y) - dy * (c.x - a.x)) / len;
};
/** a → c → p が同じ直線の上 (丸めの差を除いて) か。 */
const collinear = (a: Point, c: Point, p: Point): boolean => {
  const ux = c.x - a.x;
  const uy = c.y - a.y;
  const vx = p.x - c.x;
  const vy = p.y - c.y;
  return Math.abs(ux * vy - uy * vx) <= 1e-9 * Math.hypot(ux, uy) * Math.hypot(vx, vy);
};
const rotateVec = (v: Point, a: number): Point => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};

// ---------------------------------------------------------------------------
// 輪郭を組み立てる
// ---------------------------------------------------------------------------

/**
 * 続いた線分の並びを作る。
 * - 前の終点と次の始点が `eps` 以内なら同じ点とみなす (計算の丸めの差を埋める)
 * - 線分と線分の間の点は、前後の点を通る直線から `simplify` 以内なら除く (同じ直線の上の点、ごく小さな
 *   折り返し、ほぼ同じ直線の上の行き来)。面積のない行き来や、ほぼ重なる短い線分の組は、ブーリアン演算が辺の両側を決められなくなる
 *   ため。除いて変わる形は `simplify` 以内 (許容値の 1/64 ほど)
 */
export class ContourBuilder {
  readonly segments: Segment[] = [];
  private start: Point;
  private current: Point;

  constructor(
    start: Point,
    private readonly eps: number,
    private readonly simplify = 0,
  ) {
    this.start = start;
    this.current = start;
  }

  get end(): Point {
    return this.current;
  }

  private near(p: Point, q: Point): boolean {
    return Math.abs(p.x - q.x) <= this.eps && Math.abs(p.y - q.y) <= this.eps;
  }

  lineTo(p: Point): void {
    if (this.near(p, this.current)) return;
    for (;;) {
      const last = this.segments[this.segments.length - 1];
      if (last?.kind !== "line") break;
      const a = last.from;
      if (lineDistance(this.current, a, p) > this.simplify && !collinear(a, this.current, p)) break;
      this.segments.pop();
      this.current = a;
      if (this.near(p, a)) return;
    }
    this.segments.push({ kind: "line", from: this.current, to: p });
    this.current = p;
  }

  /** 線分か曲線を足す。始点が今の点から離れていれば、線分でつないでから足す。 */
  segment(seg: Segment): void {
    if (!this.near(seg.from, this.current)) this.lineTo(seg.from);
    const from = this.current;
    if (
      seg.kind === "line" ||
      (this.near(seg.to, from) && this.near(seg.c1, from) && this.near(seg.c2, from))
    ) {
      this.lineTo(seg.to);
      return;
    }
    this.segments.push({ ...seg, from });
    this.current = seg.to;
  }

  /** 中心 `center`、半径 `radius` の円弧。`fromDir` (長さ 1) から `sweep` (ラジアン。正は時計回り) だけ回る。 */
  arc(center: Point, radius: number, fromDir: Point, sweep: number): void {
    for (const seg of arcSegments(center, radius, fromDir, sweep)) this.segment(seg);
  }

  /** 最後の線分 (曲線) の終点を `p` へ動かす (曲線は終点のハンドルも一緒に動かす)。 */
  moveEnd(p: Point): void {
    const last = this.segments[this.segments.length - 1];
    if (!last) {
      this.start = p;
      this.current = p;
      return;
    }
    const dx = p.x - last.to.x;
    const dy = p.y - last.to.y;
    this.segments[this.segments.length - 1] =
      last.kind === "line"
        ? { kind: "line", from: last.from, to: p }
        : { ...last, c2: { x: last.c2.x + dx, y: last.c2.y + dy }, to: p };
    this.current = p;
  }

  /** 始点 (最初の線分の始点) を `p` へ動かす (曲線は始点のハンドルも一緒に動かす)。 */
  moveStart(p: Point): void {
    const first = this.segments[0];
    if (first) {
      const dx = p.x - first.from.x;
      const dy = p.y - first.from.y;
      this.segments[0] =
        first.kind === "line"
          ? { kind: "line", from: p, to: first.to }
          : { ...first, from: p, c1: { x: first.c1.x + dx, y: first.c1.y + dy } };
    }
    if (this.segments.length === 0) this.current = p;
    this.start = p;
  }

  /** 始点へ戻って閉じた線分の並び。 */
  close(): Segment[] {
    this.lineTo(this.start);
    const segs = this.segments;
    const last = segs[segs.length - 1];
    if (last && last.to !== this.start) segs[segs.length - 1] = { ...last, to: this.start };
    return segs;
  }
}

/** 円弧を 90° 以下の 3 次ベジェに分ける (半径の誤差は 90° で 0.027%)。 */
export function arcSegments(
  center: Point,
  radius: number,
  fromDir: Point,
  sweep: number,
): Segment[] {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: Segment[] = [];
  let u = fromDir;
  for (let i = 0; i < n; i++) {
    const v = i === n - 1 ? rotateVec(fromDir, sweep) : rotateVec(u, step);
    const from = add(center, u, radius);
    const to = add(center, v, radius);
    out.push({
      kind: "cubic",
      from,
      c1: add(from, perp(u), k * radius),
      c2: add(to, perp(v), -k * radius),
      to,
    });
    u = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 角と端
// ---------------------------------------------------------------------------

export interface StrokeStyle {
  half: number;
  cap: StrokeCap;
  join: StrokeJoin;
  /**
   * 向こう側の扇形を `pivot` の方へ縮める距離 (端の線の所で)。扇形の端の線は、隣の部分の端の線や外側の角・端と
   * 同じ点で接する (向きがそろう) ので、そのままだとブーリアン演算が辺の両側を決められない。許容値の 1/8 ほど
   */
  lobeInset: number;
  /** 輪郭の点を除く距離 (`ContourBuilder`) */
  simplify: number;
  /**
   * 角の内側と曲線の中の境目で、前後の端の線の端がこの距離以内なら、中心の点を通らずに直接つなぐ (許容値の
   * 1/4)。中心を通ると、ほぼ重なる細い行き来ができてブーリアン演算が辺の両側を決められない。直接つないで
   * 外れる細い三角形は、前の部分の帯の中にある
   */
  thinGap: number;
}

/** `ta` から `tb` への向きの変わり (ラジアン、正は時計回り)。ちょうど折り返すときは +π。 */
function turnAngle(ta: Point, tb: Point): number {
  const c = cross(ta, tb);
  const d = dot(ta, tb);
  if (c === 0 && d < 0) return Math.PI;
  return Math.atan2(c, d);
}

/** 角を描くほど向きが変わるか。 */
export function isCorner(ta: Point, tb: Point): boolean {
  return Math.abs(cross(ta, tb)) > STRAIGHT_SIN || dot(ta, tb) < 0;
}

/** 外側の側 (時計回りに曲がると左が外)。 */
function outerSide(ta: Point, tb: Point): Side {
  return turnAngle(ta, tb) > 0 ? "left" : "right";
}

/**
 * 角の外側の形を、外側の端の線の終わり (v + h·n(ta)) から始まり (v + h·n(tb)) で終わる道として足す。
 */
function joinPath(
  b: ContourBuilder,
  v: Point,
  ta: Point,
  tb: Point,
  side: Side,
  style: StrokeStyle,
  forward: boolean,
  roundSweep?: number,
): void {
  const h = style.half;
  const na = sideNormal(ta, side);
  const nb = sideNormal(tb, side);
  const p = add(v, na, h);
  const q = add(v, nb, h);
  const [from, to] = forward ? [p, q] : [q, p];
  b.lineTo(from);
  if (roundSweep !== undefined || style.join === "round") {
    const sweep = roundSweep ?? turnAngle(ta, tb);
    if (forward) b.arc(v, h, na, sweep);
    else b.arc(v, h, nb, -sweep);
  } else if (style.join === "miter" && 1 + dot(ta, tb) >= 2 / (MITER_LIMIT * MITER_LIMIT)) {
    // 1/cos(θ/2) ≤ 4 ⇔ (1 + cos θ)/2 ≥ 1/16 (θ は向きの変わり)。超えたらベベル
    const k = h / (1 + dot(ta, tb));
    b.lineTo(add(v, { x: na.x + nb.x, y: na.y + nb.y }, k));
  }
  b.lineTo(to);
}

/**
 * 端の形を、`tangent` (外向き) の左の点から右の点への道として足す。終わりの端は進む向き、始めの端は
 * 進む向きの逆を `tangent` に渡す。
 */
function capPath(b: ContourBuilder, p: Point, tangent: Point, style: StrokeStyle): void {
  const h = style.half;
  const l = leftNormal(tangent);
  const r = rightNormal(tangent);
  b.lineTo(add(p, l, h));
  if (style.cap === "round") {
    b.arc(p, h, l, Math.PI);
  } else if (style.cap === "square") {
    b.lineTo(add(add(p, l, h), tangent, h));
    b.lineTo(add(add(p, r, h), tangent, h));
  }
  b.lineTo(add(p, r, h));
}

/** 長さのない線の点 (破線の長さ 0 の部分、点だけの輪郭) の形。丸は円、四角は `tangent` の向きの正方形。 */
export function dotContour(
  p: Point,
  tangent: Point,
  style: StrokeStyle,
  eps: number,
): Segment[] | null {
  if (style.cap === "butt") return null;
  const h = style.half;
  const l = leftNormal(tangent);
  const b = new ContourBuilder(add(p, l, h), eps, style.simplify);
  if (style.cap === "round") {
    b.arc(p, h, l, 2 * Math.PI);
    return b.close();
  }
  const back = { x: -tangent.x, y: -tangent.y };
  capPath(b, p, tangent, style);
  capPath(b, p, back, style);
  return b.close();
}

// ---------------------------------------------------------------------------
// 部分の並びから輪郭へ
// ---------------------------------------------------------------------------

export interface StrokeRun {
  pieces: OffsetPiece[];
  /** pieces[i] と pieces[i + 1] の間が元の線分の境目 (角を描く) か。閉じたときは最後と先頭の間も (添字 n − 1) */
  corners: boolean[];
  /** 実線の閉じた輪郭 (端がなく、始点にも角) */
  closed: boolean;
}

/**
 * 部分の並び (破線 1 本か、実線の輪郭 1 本) の線の面を、時計回りの輪郭の並び (線分の並び) にする。
 * `orient` は向こう側の扇形を時計回りにそろえる関数。
 */
export function runContours(
  run: StrokeRun,
  style: StrokeStyle,
  eps: number,
  orient: (segs: Segment[]) => Segment[],
): Segment[][] {
  const { pieces, corners, closed } = run;
  if (pieces.length === 0) return [];
  const out: Segment[][] = [];
  for (const piece of pieces) {
    const far = farContour(piece, style, eps);
    if (far) out.push(orient(far));
  }
  if (closed) {
    // 左と右の 2 本の閉じた輪郭 (右は逆向きにたどる)
    out.push(loopSide(pieces, corners, "left", style, eps));
    out.push(reverseSegments(loopSide(pieces, corners, "right", style, eps)));
  } else {
    out.push(openRun(pieces, corners, style, eps));
  }
  return out;
}

function negate(v: Point): Point {
  return { x: -v.x, y: -v.y };
}

/** 開いた並びの輪郭: 左の端の線を進み、終わりの端、右の端の線を戻り、始めの端。 */
function openRun(
  pieces: OffsetPiece[],
  corners: boolean[],
  style: StrokeStyle,
  eps: number,
): Segment[] {
  const first = pieces[0]!;
  const last = pieces[pieces.length - 1]!;
  const b = new ContourBuilder(first.left.from, eps, style.simplify);
  sidePath(b, pieces, corners, "left", style, false);
  capPath(b, last.seg.to, last.t1, style);
  const right = new ContourBuilder(first.right.from, eps, style.simplify);
  sidePath(right, pieces, corners, "right", style, false);
  for (const seg of reverseSegments(right.segments)) b.segment(seg);
  capPath(b, first.seg.from, negate(first.t0), style);
  return b.close();
}

/**
 * 片側の端の線を、角をはさんでつなぐ (進む向き)。`closedLoop` なら最後と先頭の間の角も足す。
 * きつい側は端の線の代わりに `pivot` を通る (端の線の始点 → pivot → 終点)。
 */
function sidePath(
  b: ContourBuilder,
  pieces: OffsetPiece[],
  corners: boolean[],
  side: Side,
  style: StrokeStyle,
  closedLoop: boolean,
): void {
  const n = pieces.length;
  let start: Point | null = null;
  for (let i = 0; i < n; i++) {
    const piece = pieces[i]!;
    const offset = side === "left" ? piece.left : piece.right;
    if (piece.tight === side && piece.pivot) {
      if (!start) b.lineTo(offset.from);
      b.lineTo(piece.pivot);
      b.lineTo(offset.to);
    } else {
      b.segment(start ? withStart(offset, start) : offset);
    }
    start = null;
    if (i + 1 < n || closedLoop) {
      const next = pieces[(i + 1) % n]!;
      start = connect(b, piece, next, corners[i] ?? false, side, style);
    }
  }
  // 閉じた輪郭の最後と先頭の間で先頭の端の線を切ったときは、輪郭の始点も動かす
  if (closedLoop && start) b.moveStart(start);
}

/** 線分 (曲線) の始点を `p` にしたもの (曲線は始点のハンドルも一緒に動かす)。 */
function withStart(seg: Segment, p: Point): Segment {
  if (seg.kind === "line") return { kind: "line", from: p, to: seg.to };
  return {
    ...seg,
    from: p,
    c1: { x: seg.c1.x + p.x - seg.from.x, y: seg.c1.y + p.y - seg.from.y },
  };
}

/**
 * 部分 a の終わりから部分 b の始まりへ、片側の端の線をつなぐ。外側は角の形。内側と曲線の中の境目は、離れて
 * いれば中心の点を通る。近ければ (`thinGap` 以内)、端の線が重なっている (後ろへ戻る) ときは 2 本の端の線を
 * 交わる所で切り (前の端の線の終点を動かし、次の端の線の始点を返す)、重なっていなければ線分でつなぐ。
 */
function connect(
  b: ContourBuilder,
  a: OffsetPiece,
  next: OffsetPiece,
  corner: boolean,
  side: Side,
  style: StrokeStyle,
): Point | null {
  const v = a.seg.to;
  const from = side === "left" ? a.left.to : a.right.to;
  const to = side === "left" ? next.left.from : next.right.from;
  if (a.cuspSweep !== undefined) {
    // ほぼ尖った所を除いた境目: 外側は向きの回った角度の丸い扇 (曲線が実際に回った向き)。内側は中心を通る
    if ((a.cuspSweep > 0 ? "left" : "right") === side) {
      joinPath(b, v, a.t1, next.t0, side, style, true, a.cuspSweep);
      b.lineTo(to);
    } else {
      b.lineTo(v);
      b.lineTo(to);
    }
    return null;
  }
  if (corner && isCorner(a.t1, next.t0) && outerSide(a.t1, next.t0) === side) {
    joinPath(b, v, a.t1, next.t0, side, style, true);
    return null;
  }
  const gap = Math.hypot(from.x - to.x, from.y - to.y);
  // 弦にした短い線分と曲線の間 (同じ線分の中の境目で、向きの差は小さい) も中心を通らない
  const chord = !corner && (a.chord === true || next.chord === true);
  if (gap > style.thinGap && !chord) {
    b.lineTo(v);
    b.lineTo(to);
    return null;
  }
  const dir = { x: a.t1.x + next.t0.x, y: a.t1.y + next.t0.y };
  if ((to.x - from.x) * dir.x + (to.y - from.y) * dir.y >= 0) {
    b.lineTo(to);
    return null;
  }
  // 重なっている: 2 本の端の線 (端の向きの直線で近似) の交わる所で切る
  const den = cross(a.t1, next.t0);
  let cut: Point = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  if (Math.abs(den) > 1e-12) {
    const u = cross({ x: to.x - from.x, y: to.y - from.y }, next.t0) / den;
    const candidate = add(from, a.t1, u);
    const reach = 2 * Math.max(style.thinGap, gap);
    if (
      Math.hypot(candidate.x - from.x, candidate.y - from.y) <= reach &&
      Math.hypot(candidate.x - to.x, candidate.y - to.y) <= reach
    )
      cut = candidate;
  }
  b.moveEnd(cut);
  return cut;
}

/** 閉じた実線の片側の輪郭 (先頭の点の角を含む)。 */
function loopSide(
  pieces: OffsetPiece[],
  corners: boolean[],
  side: Side,
  style: StrokeStyle,
  eps: number,
): Segment[] {
  const first = pieces[0]!;
  const b = new ContourBuilder(
    side === "left" ? first.left.from : first.right.from,
    eps,
    style.simplify,
  );
  sidePath(b, pieces, corners, side, style, true);
  return b.close();
}

/** 線分の並びを逆向きにする。 */
export function reverseSegments(segs: readonly Segment[]): Segment[] {
  return segs
    .slice()
    .reverse()
    .map((s) =>
      s.kind === "line"
        ? { kind: "line", from: s.to, to: s.from }
        : { kind: "cubic", from: s.to, c1: s.c2, c2: s.c1, to: s.from },
    );
}

/**
 * きつい部分の、向こう側に回り込む扇形 (`pivot` の向こうの、きつい側の端の線まで)。端の線が `pivot` の向こうに
 * なければ null。向きはそろえない (呼び出し側が時計回りにする)。
 *
 * 扇形は少し変える: 端の線は `pivot` を中心に `inset` だけ縮め、要の点は `pivot` から中心線の側へ `inset`
 * だけ戻した点にする (どちらも扇形の大きさの 1/4 まで)。端の線は隣の部分の端の線や外側の角・端と同じ点で
 * 向きをそろえて接し、扇形の 2 辺は輪郭の `pivot` を通る線分とほぼ重なるので、そのままではブーリアン演算が
 * 辺の両側を決められない。変えると、扇形の辺は法線と端点でだけ交わる。面の変わりは許容値の 1/8 ほど。
 */
function farContour(piece: OffsetPiece, style: StrokeStyle, eps: number): Segment[] | null {
  const inset = style.lobeInset;
  if (piece.tight === null || piece.pivot === null) return null;
  const pivot = piece.pivot;
  const far = piece.tight === "left" ? piece.left : piece.right;
  // 端の線が pivot より向こう (中心線から遠い側) にあるときだけ
  const n0 = sideNormal(piece.t0, piece.tight);
  const n1 = sideNormal(piece.t1, piece.tight);
  const beyond0 = (far.from.x - pivot.x) * n0.x + (far.from.y - pivot.y) * n0.y;
  const beyond1 = (far.to.x - pivot.x) * n1.x + (far.to.y - pivot.y) * n1.y;
  const reach = Math.max(beyond0, beyond1);
  // 向こう側へ全体の許容値の 1/4 (縮める距離の 2 倍) 届かなければ作らない (`offset.ts` の分け方と同じ境目)。
  // 細い扇形 (広がりが許容値の 1/4 以下) も作らない。どちらも、なくても形の差は許容値の 1/4 以内
  if (reach <= Math.max(eps, 2 * inset)) return null;
  const spread = Math.abs(Math.atan2(cross(n0, n1), dot(n0, n1)));
  if (reach * spread <= 2 * inset) return null;
  const step = Math.min(inset, reach / 4);
  const k = 1 - step / reach;
  const shrink = (p: Point): Point => ({
    x: pivot.x + (p.x - pivot.x) * k,
    y: pivot.y + (p.y - pivot.y) * k,
  });
  const curve: Segment =
    far.kind === "line"
      ? { kind: "line", from: shrink(far.from), to: shrink(far.to) }
      : {
          kind: "cubic",
          from: shrink(far.from),
          c1: shrink(far.c1),
          c2: shrink(far.c2),
          to: shrink(far.to),
        };
  // 要: 扇形の真ん中の向き (始点と終点の法線の和) と逆へ、中心線の側に戻した点。扇形の 2 辺は pivot の
  // そばを通るので、pivot のまわりに穴を残さない (辺の外へ step ほどはみ出すが、許容値の 1/8 以内)
  const mid = { x: n0.x + n1.x, y: n0.y + n1.y };
  const len = Math.hypot(mid.x, mid.y);
  const apex = len > 1e-12 ? add(pivot, mid, -step / len) : pivot;
  const b = new ContourBuilder(apex, eps, style.simplify);
  b.lineTo(curve.from);
  b.segment(curve);
  const segs = b.close();
  return segs.length >= 3 ? segs : null;
}
