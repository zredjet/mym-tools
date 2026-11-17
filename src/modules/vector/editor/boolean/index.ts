/**
 * ブーリアン演算 (`docs/canvas-editor-design.md` §8.9)。
 *
 * 名前と引数は契約で、描画 (v3 の基盤) とパネルが呼ぶ。中身は「ブーリアン演算」のセッションが置き換える。
 * 仮の実装は、求められなかったときと同じ `null` を返す (描画は子の形を重ねて描く)。
 */
import type { BooleanOp, FillRule, Subpath } from "../model/types";

/** 演算の入力 1 個。座標は呼び出し側がそろえる (ブーリアンのノードの親の座標系)。 */
export interface BooleanOperand {
  subpaths: readonly Subpath[];
  /** 閉じていない輪郭は閉じた形として扱う */
  fillRule: FillRule;
}

/**
 * `operands` (配列の順 = 重なり順、先頭が最背面) を `op` で演算した面を、閉じた輪郭の並びで返す。
 *
 * - 結果は `nonzero` で塗ると正しい面になる。面がなければ空の配列
 * - 純関数。同じ入力には同じ結果を返す。結果の曲線は入力の曲線の一部 (折れ線に近似しない)
 * - 求められなかったとき (計算の内部の失敗) は `null` を返し、例外を投げない
 */
export function booleanOperation(
  op: BooleanOp,
  operands: readonly BooleanOperand[],
): Subpath[] | null {
  void op;
  void operands;
  return null;
}
