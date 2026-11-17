/**
 * ブーリアン演算 (`docs/canvas-editor-design.md` §8.9)。
 *
 * 名前と引数は契約で、描画 (`boolean/result.ts` の `getBooleanResult`)、パスに変換、線のアウトライン化が呼ぶ。
 *
 * 計算 (paper.js と同じ考え方。コードは自作):
 * 1. 入力の輪郭を閉じた曲線の並びにし、曲線どうしの交点・接点・重なりの端と自己交差で分ける (`split.ts`)
 * 2. 同じ形の部分 (重なった辺) を 1 つの辺にまとめ、ほかの曲線が通らない継ぎ目でつながった辺の道ごとに、
 *    入力ごとの左右の巻き数を光線で数える (`graph.ts`、`winding.ts`)
 * 3. 左右で「結果の面の内側か」が違う辺を、内側が右に来る向きで残し、頂点ごとに面の境界をなぞって
 *    閉じた輪郭にする。同じ元の曲線の続いた部分は 1 本に戻す
 *
 * 扱うもの: 重なった辺 (同じ直線・同じ曲線の一部)、接する曲線、自己交差 (`nonzero` と `evenodd`)、
 * 同じ点を通る複数の輪郭、入れ子の穴、面積 0 の輪郭、閉じていない輪郭 (閉じた形として扱う)。
 *
 * 求められないとき (null): 交点を探し尽くせなかった (`intersectSegments` の打ち切り)、同じ点にまとめた
 * 交点が離れすぎている、辺のどの点でも巻き数が決まらない (ほかの曲線が許容値の中で寄り添う)、結果の面の
 * 境界に矛盾がある (`graph.ts` の検査)、座標が有限でない、計算の中で例外が起きた。
 */
import { toleranceFor } from "../geometry/bezier";
import type { BooleanOp, FillRule, Subpath } from "../model/types";
import { buildResult } from "./graph";
import { collectSegments, splitOperands, tolerancesFor } from "./split";

/** 演算の入力 1 個。座標は呼び出し側がそろえる (ブーリアンのノードの親の座標系)。 */
export interface BooleanOperand {
  subpaths: readonly Subpath[];
  /** 閉じていない輪郭は閉じた形として扱う */
  fillRule: FillRule;
}

/**
 * `operands` (配列の順 = 重なり順、先頭が最背面) を `op` で演算した面を、閉じた輪郭の並びで返す。
 *
 * - 結果は `nonzero` で塗ると正しい面になる。外側の輪郭は時計回り、穴は反時計回り (y が下向きの座標で)。
 *   面がなければ空の配列
 * - 型抜きは、表示されている子のうち最背面のものから残りの合体を引く (非表示の子は呼び出し側が除く)
 * - 純関数。同じ入力には同じ結果を返す。結果の曲線は入力の曲線の一部 (折れ線に近似しない)
 * - 求められなかったとき (計算の内部の失敗) は `null` を返し、例外を投げない
 */
export function booleanOperation(
  op: BooleanOp,
  operands: readonly BooleanOperand[],
): Subpath[] | null {
  try {
    return compute(op, operands);
  } catch {
    return null;
  }
}

const OPS: readonly BooleanOp[] = ["union", "subtract", "intersect", "exclude"];

function compute(op: BooleanOp, operands: readonly BooleanOperand[]): Subpath[] | null {
  if (!OPS.includes(op)) return null;
  for (const operand of operands) {
    if (operand.fillRule !== "nonzero" && operand.fillRule !== "evenodd") return null;
    if (!finiteSubpaths(operand.subpaths)) return null;
  }
  if (operands.length === 0) return [];
  const { segments, contours, magnitude } = collectSegments(operands);
  // 面のない入力: 交差は空、型抜きは引かれる側がなければ空
  const present = operands.map((_, k) => contours.some((c) => c.operand === k));
  if (op === "intersect" && present.some((p) => !p)) return [];
  if (op === "subtract" && !present[0]) return [];
  if (segments.length === 0) return [];
  const tol = tolerancesFor(toleranceFor(magnitude));
  const split = splitOperands(segments, contours, tol);
  if (!split) return null;
  return buildResult(op, {
    segments: split.segments,
    pieces: split.pieces,
    vertices: split.vertices,
    rules: operands.map((o) => o.fillRule),
    tol,
  });
}

function finiteSubpaths(subpaths: readonly Subpath[]): boolean {
  for (const sub of subpaths) {
    for (const p of sub.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
      if (p.in && !(Number.isFinite(p.in.x) && Number.isFinite(p.in.y))) return false;
      if (p.out && !(Number.isFinite(p.out.x) && Number.isFinite(p.out.y))) return false;
    }
  }
  return true;
}
