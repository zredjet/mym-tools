/**
 * 線のアウトライン化のテスト用の道具 (テストからだけ使う)。
 *
 * `strokeContainsFn(subpaths, stroke)`: 点が線の面 (描画の規則どおり) の内側かを返す関数。アウトライン化の
 * 実装 (`offset.ts`、`contour.ts`) とは別に、点ごとの判定で書いた参照:
 * - 中心線を細かい折れ線 (位置の誤差は許容値の 1/20、隣の点との向きの差も、太さの半分の所で許容値の 1/20
 *   以内) にし、破線の区間ごとに、隣り合う 2 点の (曲線の本当の) 法線の間にあり、足までの距離が太さの半分以内
 *   なら内側 (曲線の帯 = 法線に沿って太さの半分ずつ広げた範囲。強く曲がる所の中心の向こう側も含む)
 * - 元の線分の境目 (区間の内側) は角の形 (マイターは上限 4、ベベル、丸)、区間の端は端の形 (丸・四角)
 * - 長さ 0 の区間・輪郭は点 (丸は円、四角は正方形)
 *
 * `compareStrokeOnGrid`: 結果の面 (`nonzero`) と参照を格子の点で比べる。点のまわり (許容値の距離の 8 方向) で
 * 参照の内外が変わる点 (境界の近く) は比べない。結果の巻き数が 0 か 1 であることも確かめる。結果の輪郭の上の
 * 点が、参照の境界から許容値の距離の中にあることも確かめる (許容値の円の 16 方向に内と外の両方がある)。
 */
import {
  flattenSegmentParams,
  isDegenerate,
  pointAt,
  segmentLength,
  tAtLength,
  tangentAt,
  toleranceFor,
  type Segment,
} from "../geometry/bezier";
import type { Point, Subpath } from "../model/types";
import { pathBounds, windingNumber } from "../path/measure";
import { subpathToSegments } from "../path/segments";
import type { StrokeShape } from "./index";

interface Vertex {
  p: Point;
  /** 曲線の進む向き (角では前の線分の終わりの向き) */
  tan: Point;
  /** 元の線分の境目 (角を描く) */
  corner: boolean;
  /** 角の後の向き */
  tout: Point | null;
}

interface RefDash {
  /** 折れ線の点 (曲線の中の点と元の線分の境目) */
  vertices: Vertex[];
  /** 閉じた実線 (始点にも角) */
  loop: boolean;
  /** 端の向き (外向き) */
  startTangent: Point;
  endTangent: Point;
}

interface RefDot {
  p: Point;
  tangent: Point;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const crossP = (a: Point, b: Point) => a.x * b.y - a.y * b.x;

/** 破線の区間 (参照用に別に書く。`dash.ts` と同じ規則)。 */
function refSpans(
  total: number,
  closed: boolean,
  dash: readonly number[],
): { start: number; end: number; wraps: boolean }[] | null {
  if (dash.length === 0 || dash.some((v) => !(v >= 0)) || !(dash.reduce((a, b) => a + b, 0) > 0))
    return null;
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash;
  const spans: { start: number; end: number; wraps: boolean }[] = [];
  let pos = 0;
  let i = 0;
  let lastOn = false;
  const snap = 1e-9 * Math.max(1, total);
  while (total - pos > snap) {
    const on = i % 2 === 0;
    const end = pos + pattern[i]!;
    if (on) spans.push({ start: pos, end: Math.min(end, total), wraps: false });
    lastOn = on;
    pos = end;
    i = (i + 1) % pattern.length;
  }
  if (closed && lastOn && spans.length >= 2) {
    const last = spans.pop()!;
    const first = spans.shift()!;
    spans.push({ start: last.start, end: first.end, wraps: true });
  }
  return spans;
}

/** 参照の部品 (テストの調べもの用)。 */
export function buildReference(
  subpaths: readonly Subpath[],
  stroke: StrokeShape,
): { dashes: RefDash[]; dots: RefDot[] } {
  const dashes: RefDash[] = [];
  const dots: RefDot[] = [];
  const flatTol = Math.max(stroke.width * 1e-3, 0.05) / 20;
  // 折れ線の辺の法線の向きの誤差が、太さの半分の所で許容値の 1/20 以内になるように (強く曲がる所)
  const maxTurn = Math.min(0.02, flatTol / Math.max(stroke.width / 2, 1e-9));
  for (const sp of subpaths) {
    if (sp.points.length < 2) continue;
    let mag = 0;
    for (const p of sp.points) mag = Math.max(mag, Math.abs(p.x), Math.abs(p.y));
    const segs = subpathToSegments(sp).filter((s) => !isDegenerate(s, toleranceFor(mag)));
    if (segs.length === 0) {
      if (stroke.dash.length === 0 || refSpans(1, false, stroke.dash) === null)
        dots.push({ p: { x: sp.points[0]!.x, y: sp.points[0]!.y }, tangent: { x: 1, y: 0 } });
      continue;
    }
    const lengths = segs.map((s) => segmentLength(s));
    const starts = [0];
    for (const l of lengths) starts.push(starts[starts.length - 1]! + l);
    const total = starts[starts.length - 1]!;
    const spans = refSpans(total, sp.closed, stroke.dash);
    const pieces = (a: number, b: number): { seg: Segment; t0: number; t1: number }[] => {
      const out: { seg: Segment; t0: number; t1: number }[] = [];
      segs.forEach((seg, i) => {
        const s0 = starts[i]!;
        const s1 = starts[i + 1]!;
        if (s1 <= a || s0 >= b) return;
        const t0 = a > s0 ? tAtLength(seg, a - s0) : 0;
        const t1 = b < s1 ? tAtLength(seg, b - s0) : 1;
        if (t1 > t0) out.push({ seg, t0, t1 });
      });
      return out;
    };
    const toDash = (parts: { seg: Segment; t0: number; t1: number }[], loop: boolean): RefDash => {
      const vertices: Vertex[] = [];
      parts.forEach(({ seg, t0, t1 }, k) => {
        const params = refineTurn(
          seg,
          flattenSegmentParams(seg, flatTol)
            .map((t) => t0 + (t1 - t0) * t)
            .filter((t, idx, arr) => idx === 0 || t > arr[idx - 1]!),
          maxTurn,
        );
        params.forEach((t, j) => {
          const tan = tangentAt(seg, t) ?? { x: 1, y: 0 };
          if (j === 0 && k > 0) {
            // 元の線分の境目: 前の部分の終わりと同じ点。角にする
            const prev = vertices[vertices.length - 1]!;
            prev.corner = true;
            prev.tout = tan;
            return;
          }
          vertices.push({ p: pointAt(seg, t), tan, corner: false, tout: null });
        });
      });
      if (loop) {
        // 最後の点は先頭の点と同じ。先頭を角にする (前の向きは最後の点の向き)
        const last = vertices.pop()!;
        const first = vertices[0]!;
        first.corner = true;
        first.tout = first.tan;
        first.tan = last.tan;
      }
      const firstPart = parts[0]!;
      const lastPart = parts[parts.length - 1]!;
      const st = tangentAt(firstPart.seg, firstPart.t0)!;
      return {
        vertices,
        loop,
        startTangent: { x: -st.x, y: -st.y },
        endTangent: tangentAt(lastPart.seg, lastPart.t1)!,
      };
    };
    if (spans === null) {
      dashes.push(toDash(pieces(0, total), sp.closed));
      continue;
    }
    for (const span of spans) {
      if (!span.wraps && span.end <= span.start) {
        let i = 0;
        while (i + 1 < segs.length && starts[i + 1]! <= span.start) i++;
        const t = tAtLength(segs[i]!, span.start - starts[i]!);
        dots.push({ p: pointAt(segs[i]!, t), tangent: tangentAt(segs[i]!, t)! });
        continue;
      }
      const parts = span.wraps
        ? [...pieces(span.start, total), ...pieces(0, span.end)]
        : pieces(span.start, span.end);
      if (parts.length > 0) dashes.push(toDash(parts, false));
    }
  }
  return { dashes, dots };
}

/** 隣の点との進む向きの差が `maxTurn` (ラジアン) を超える区間を分ける (尖りの近くは深さで打ち切る)。 */
function refineTurn(seg: Segment, params: number[], maxTurn: number): number[] {
  const out: number[] = [];
  const angle = (a: Point, b: Point) => Math.abs(Math.atan2(crossP(a, b), dot(a, b)));
  const split = (a: number, b: number, ta: Point | null, tb: Point | null, depth: number) => {
    if (depth < 16 && ta && tb && angle(ta, tb) > maxTurn) {
      const m = (a + b) / 2;
      const tm = tangentAt(seg, m);
      split(a, m, ta, tm, depth + 1);
      out.push(m);
      split(m, b, tm, tb, depth + 1);
    }
  };
  for (let i = 0; i < params.length; i++) {
    if (i > 0) {
      const a = params[i - 1]!;
      const b = params[i]!;
      split(a, b, tangentAt(seg, a), tangentAt(seg, b), 0);
    }
    out.push(params[i]!);
  }
  return out;
}

function inPolygon(p: Point, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

function capContains(p: Point, at: Point, tangent: Point, stroke: StrokeShape): boolean {
  const h = stroke.width / 2;
  const v = sub(p, at);
  // 端は終わりより先の半分だけ (丸は半円。後ろの半分は線の帯に任せる)
  if (stroke.cap === "round") return dot(v, v) <= h * h && dot(v, tangent) >= 0;
  if (stroke.cap === "square") {
    const along = dot(v, tangent);
    return along >= 0 && along <= h && Math.abs(crossP(tangent, v)) <= h;
  }
  return false;
}

/** 角の外側の形 (`join` が "round" なら外側の扇形)。`ta` `tb` は前後の向き。 */
function joinContains(
  p: Point,
  at: Point,
  ta: Point,
  tb: Point,
  join: StrokeShape["join"],
  h: number,
): boolean {
  const v = sub(p, at);
  const c = crossP(ta, tb);
  const d = dot(ta, tb);
  if (Math.abs(c) < 1e-12 && d > 0) return false;
  // 外側の法線 (時計回りに曲がると左が外)
  const left = (t: Point) => ({ x: t.y, y: -t.x });
  const sign = c > 0 || (c === 0 && d < 0) ? 1 : -1;
  const na = { x: left(ta).x * sign, y: left(ta).y * sign };
  const nb = { x: left(tb).x * sign, y: left(tb).y * sign };
  if (join === "round") {
    if (dot(v, v) > h * h) return false;
    // na から nb へ (外側を通って) 回る扇形の中
    return crossP(na, v) * sign >= 0 && crossP(v, nb) * sign >= 0;
  }
  const P = { x: at.x + na.x * h, y: at.y + na.y * h };
  const Q = { x: at.x + nb.x * h, y: at.y + nb.y * h };
  const poly = [at, P];
  if (join === "miter" && 1 + d >= 1 / 8) {
    const k = h / (1 + d);
    poly.push({ x: at.x + (na.x + nb.x) * k, y: at.y + (na.y + nb.y) * k });
  }
  poly.push(Q);
  return inPolygon(p, poly);
}

interface Primitive {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  test(p: Point): boolean;
}

function around(at: Point, r: number, test: (p: Point) => boolean): Primitive {
  return { minX: at.x - r, minY: at.y - r, maxX: at.x + r, maxY: at.y + r, test };
}

/** 点が線の面の内側か (参照)。部品 (辺の帯、角、端、点) を格子に振り分けて、近くの部品だけを調べる。 */
export function strokeContainsFn(
  subpaths: readonly Subpath[],
  stroke: StrokeShape,
): (p: Point) => boolean {
  const { dashes, dots } = buildReference(subpaths, stroke);
  const h = stroke.width / 2;
  const h2 = h * h;
  const reach = h * 3; // マイターの先 (上限 4 で太さの半分の 4 倍まで) を含む範囲
  const prims: Primitive[] = [];
  for (const d of dots) {
    prims.push(
      around(d.p, h * Math.SQRT2, (p) => {
        const v = sub(p, d.p);
        if (stroke.cap === "round") return dot(v, v) <= h2;
        if (stroke.cap === "square")
          return Math.abs(dot(v, d.tangent)) <= h && Math.abs(crossP(d.tangent, v)) <= h;
        return false;
      }),
    );
  }
  for (const dash of dashes) {
    const vs = dash.vertices;
    const n = vs.length;
    const edges = dash.loop ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      // 隣り合う 2 点の法線の間 (曲線の帯の一片)。点が 2 本の法線の間にあり (足の向きの符号が変わる)、
      // 足までの距離が太さの半分以内なら内側。強く曲がる所の中心の向こう側も、法線の交わりに沿って正しく扱える
      const va = vs[i]!;
      const vb = vs[(i + 1) % n]!;
      const a = va.p;
      const b = vb.p;
      const ta = va.corner ? va.tout! : va.tan;
      const tb = vb.tan;
      prims.push({
        minX: Math.min(a.x, b.x) - h,
        minY: Math.min(a.y, b.y) - h,
        maxX: Math.max(a.x, b.x) + h,
        maxY: Math.max(a.y, b.y) + h,
        test: (p) => {
          const ga = dot(sub(p, a), ta);
          const gb = dot(sub(p, b), tb);
          // 符号が変わる (中心の向こう側では法線が交わって向きが逆になる)
          if ((ga < 0 && gb < 0) || (ga > 0 && gb > 0)) return false;
          const lambda = ga === gb ? 0 : ga / (ga - gb);
          const foot = { x: a.x + (b.x - a.x) * lambda, y: a.y + (b.y - a.y) * lambda };
          const d = sub(p, foot);
          return dot(d, d) <= h2;
        },
      });
    }
    for (let i = 0; i < n; i++) {
      const vtx = vs[i]!;
      const interior = dash.loop || (i > 0 && i < n - 1);
      if (!interior || !vtx.corner) continue;
      const ta = vtx.tan;
      const tb = vtx.tout!;
      prims.push(around(vtx.p, reach * 2, (p) => joinContains(p, vtx.p, ta, tb, stroke.join, h)));
    }
    if (!dash.loop) {
      const first = vs[0]!.p;
      const last = vs[n - 1]!.p;
      prims.push(
        around(first, h * Math.SQRT2, (p) => capContains(p, first, dash.startTangent, stroke)),
      );
      prims.push(
        around(last, h * Math.SQRT2, (p) => capContains(p, last, dash.endTangent, stroke)),
      );
    }
  }
  // 格子に振り分ける
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of prims) {
    minX = Math.min(minX, q.minX);
    minY = Math.min(minY, q.minY);
    maxX = Math.max(maxX, q.maxX);
    maxY = Math.max(maxY, q.maxY);
  }
  if (prims.length === 0) return () => false;
  const cells = 64;
  const cw = (maxX - minX) / cells || 1;
  const ch = (maxY - minY) / cells || 1;
  const grid: Primitive[][] = Array.from({ length: cells * cells }, () => []);
  const cellX = (x: number) => Math.min(cells - 1, Math.max(0, Math.floor((x - minX) / cw)));
  const cellY = (y: number) => Math.min(cells - 1, Math.max(0, Math.floor((y - minY) / ch)));
  for (const q of prims)
    for (let i = cellX(q.minX); i <= cellX(q.maxX); i++)
      for (let j = cellY(q.minY); j <= cellY(q.maxY); j++) grid[i * cells + j]!.push(q);
  return (p) => {
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false;
    for (const q of grid[cellX(p.x) * cells + cellY(p.y)]!) {
      if (p.x < q.minX || p.x > q.maxX || p.y < q.minY || p.y > q.maxY) continue;
      if (q.test(p)) return true;
    }
    return false;
  };
}

export interface StrokeGridReport {
  checked: number;
  mismatches: { p: Point; expected: boolean }[];
  badWinding: Point[];
  /** 調べた結果の輪郭の点の数 */
  boundaryChecked: number;
  /** 結果の輪郭の点のうち、許容値の距離の中に参照の境界がないもの */
  boundaryOff: Point[];
}

/**
 * 結果の面と参照を格子の点で比べる。`margin` (許容値) の距離の 8 方向で参照の内外が変わる点は比べない。
 */
export function compareStrokeOnGrid(
  subpaths: readonly Subpath[],
  stroke: StrokeShape,
  result: readonly Subpath[],
  options: { steps?: number; margin: number },
): StrokeGridReport {
  const contains = strokeContainsFn(subpaths, stroke);
  const box = pathBounds(subpaths);
  const report: StrokeGridReport = {
    checked: 0,
    mismatches: [],
    badWinding: [],
    boundaryChecked: 0,
    boundaryOff: [],
  };
  if (!box) return report;
  const steps = options.steps ?? 64;
  const pad = stroke.width * 2.5 + 1;
  const minX = box.minX - pad;
  const minY = box.minY - pad;
  const w = box.maxX - box.minX + 2 * pad;
  const hgt = box.maxY - box.minY + 2 * pad;
  const m = options.margin;
  const around = [
    [m, 0],
    [-m, 0],
    [0, m],
    [0, -m],
    [m * Math.SQRT1_2, m * Math.SQRT1_2],
    [-m * Math.SQRT1_2, m * Math.SQRT1_2],
    [m * Math.SQRT1_2, -m * Math.SQRT1_2],
    [-m * Math.SQRT1_2, -m * Math.SQRT1_2],
  ] as const;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const p = { x: minX + ((i + 0.5137) / steps) * w, y: minY + ((j + 0.4729) / steps) * hgt };
      const expected = contains(p);
      if (around.some(([dx, dy]) => contains({ x: p.x + dx, y: p.y + dy }) !== expected)) continue;
      report.checked++;
      const wn = windingNumber(result, p);
      if (wn !== 0 && wn !== 1) report.badWinding.push(p);
      if ((wn !== 0) !== expected) report.mismatches.push({ p, expected });
    }
  }
  // 結果の輪郭の上の点: 許容値の距離の円 (16 方向) の中に、参照の内側と外側の両方があること
  const ring = Array.from({ length: 16 }, (_, k) => {
    const a = (k / 16) * Math.PI * 2;
    return { x: Math.cos(a) * m, y: Math.sin(a) * m };
  });
  for (const sp of result) {
    for (const seg of subpathToSegments(sp, { implicitClose: true })) {
      for (let k = 0; k < 8; k++) {
        const q = pointAt(seg, (k + 0.37) / 8);
        report.boundaryChecked++;
        // 参照の中の、許容値より細い溝や穴の上にある点 (その点だけ内外が違う) は、境界の近くとみなす
        let inside = contains(q);
        let outside = !inside;
        if (ring.every((d) => contains({ x: q.x + d.x, y: q.y + d.y }) === outside)) continue;
        inside = false;
        outside = false;
        for (const d of ring) {
          if (contains({ x: q.x + d.x, y: q.y + d.y })) inside = true;
          else outside = true;
          if (inside && outside) break;
        }
        if (!(inside && outside)) report.boundaryOff.push(q);
      }
    }
  }
  return report;
}
