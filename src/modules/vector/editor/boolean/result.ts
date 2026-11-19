/**
 * 文書の中のブーリアンの結果 (`docs/canvas-editor-design.md` §4.15.2、§4.15.3)。
 *
 * 子の形を集めて `booleanOperation` (`./index.ts`) を呼ぶ。描画、外接矩形、ヒットテスト、パスに変換、
 * 線のアウトライン化は、どれもここを通す。
 *
 * - 子の形: 矩形・楕円・パスは §4.12 の点の形 (`path/shapes.ts`) に、ノードの変換 (`nodeMatrix`、
 *   §4.11) を掛けて親の座標系にしたもの。パスは自分の `fillRule`。ブーリアンの子はその結果 (`nonzero`)
 * - 非表示の子は演算に入れない。演算に入れる子が 1 つもなければ、結果は空 (面がない)
 * - 子のブーリアンが求められなければ、自分も求められない (`null`)
 * - ブーリアンのノードと子孫のノードのオブジェクトが前の呼び出しと同じなら、前の結果を使い回す (`WeakMap`)。
 *   文書は書き換えない約束 (§4.2) なので、オブジェクトが同じなら中身も同じ
 * - 座標はどれもブーリアンの親の座標系 (ブーリアンは座標系を作らない。§3.8)
 */
import { nodeMatrix } from "../geometry/matrix";
import { getNode } from "../model/tree";
import type { BooleanNode, CanvasDocument, CanvasNode, NodeId, Subpath } from "../model/types";
import { pathBoundsRect, type Rect } from "../path/measure";
import { ellipseSubpaths, rectSubpaths } from "../path/shapes";
import { transformSubpaths } from "../path/transform";
import { booleanOperation, type BooleanOperand } from "./index";

export interface BooleanResult {
  /** 閉じた輪郭の並び。`nonzero` で塗ると正しい面になる。面がなければ空 */
  subpaths: Subpath[];
  /** 結果の曲線の範囲 (ハンドルの先は含めない)。面がなければ null */
  bounds: Rect | null;
}

export interface BooleanEvaluation {
  /**
   * 演算に入れた子の形 (非表示の子を除く、重なり順)。結果を求められなかったときの描画 (子の形を重ねて描く)
   * に使う。求められなかった子のブーリアンは、その子の形を並べたもの
   */
  operands: readonly BooleanOperand[];
  /** 演算の結果。求められなかったら null */
  result: BooleanResult | null;
}

interface CacheEntry {
  /** 子孫のノードのオブジェクト (深さ優先・重なり順)。見つからない子は undefined */
  deps: readonly (CanvasNode | undefined)[];
  evaluation: BooleanEvaluation;
}

const cache = new WeakMap<BooleanNode, CacheEntry>();

/** 子孫のノードのオブジェクトを集める。壊れた文書の循環でも止まる。 */
function collectDeps(
  doc: CanvasDocument,
  node: BooleanNode,
  out: (CanvasNode | undefined)[],
  seen: Set<NodeId>,
): void {
  for (const childId of node.children) {
    if (seen.has(childId)) {
      out.push(undefined);
      continue;
    }
    const child = getNode(doc, childId);
    out.push(child);
    if (child?.type === "boolean") {
      seen.add(childId);
      collectDeps(doc, child, out, seen);
      seen.delete(childId);
    }
  }
}

function sameDeps(
  a: readonly (CanvasNode | undefined)[],
  b: readonly (CanvasNode | undefined)[],
): boolean {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

/** 矩形・楕円・パスの形を、親の座標系の点の形にする。それ以外は null。 */
export function shapeOperand(node: CanvasNode): BooleanOperand | null {
  switch (node.type) {
    case "rect":
    case "ellipse":
    case "path": {
      const local =
        node.type === "rect"
          ? rectSubpaths(node.width, node.height, node.radius)
          : node.type === "ellipse"
            ? ellipseSubpaths(node.width, node.height)
            : node.subpaths;
      const matrix = nodeMatrix(node.x, node.y, node.width, node.height, node.rotation);
      return {
        subpaths: transformSubpaths(local, matrix),
        fillRule: node.type === "path" ? node.fillRule : "nonzero",
      };
    }
    default:
      return null;
  }
}

function evaluate(
  doc: CanvasDocument,
  node: BooleanNode,
  ancestors: Set<NodeId>,
): BooleanEvaluation {
  const operands: BooleanOperand[] = [];
  let failed = false;
  for (const childId of node.children) {
    const child = getNode(doc, childId);
    if (!child || !child.visible || ancestors.has(childId)) continue;
    if (child.type === "boolean") {
      const inner = evaluateCached(doc, child, ancestors);
      if (inner.result) operands.push({ subpaths: inner.result.subpaths, fillRule: "nonzero" });
      else {
        failed = true;
        operands.push(...inner.operands);
      }
      continue;
    }
    const operand = shapeOperand(child);
    if (operand) operands.push(operand);
  }
  if (failed) return { operands, result: null };
  if (operands.length === 0) return { operands, result: { subpaths: [], bounds: null } };
  let subpaths: Subpath[] | null;
  try {
    subpaths = booleanOperation(node.op, operands);
  } catch {
    // 契約では例外を投げないが、描画を止めないよう、求められなかったものとして扱う
    subpaths = null;
  }
  return {
    operands,
    result: subpaths === null ? null : { subpaths, bounds: pathBoundsRect(subpaths) },
  };
}

function evaluateCached(
  doc: CanvasDocument,
  node: BooleanNode,
  ancestors: Set<NodeId>,
): BooleanEvaluation {
  const deps: (CanvasNode | undefined)[] = [];
  collectDeps(doc, node, deps, new Set([node.id]));
  const cached = cache.get(node);
  if (cached && sameDeps(cached.deps, deps)) return cached.evaluation;
  ancestors.add(node.id);
  const evaluation = evaluate(doc, node, ancestors);
  ancestors.delete(node.id);
  cache.set(node, { deps, evaluation });
  return evaluation;
}

/**
 * ブーリアンの演算の入力と結果。ブーリアンでない (か見つからない) ノードは null。
 * 子孫が変わらなければ同じオブジェクトを返すので、画面の購読 (`useEditorStore` の selector) に使える。
 */
export function getBooleanEvaluation(doc: CanvasDocument, id: NodeId): BooleanEvaluation | null {
  const node = getNode(doc, id);
  if (node?.type !== "boolean") return null;
  return evaluateCached(doc, node, new Set());
}

/**
 * 文書の中のブーリアンの結果 (親の座標系)。求められなかったとき、ブーリアンでない (か見つからない)
 * ときは null。結果のオブジェクトは使い回すので、書き換えてはいけない。
 */
export function getBooleanResult(doc: CanvasDocument, id: NodeId): BooleanResult | null {
  return getBooleanEvaluation(doc, id)?.result ?? null;
}

/** 演算の入力の形をすべて囲む範囲 (結果を求められなかったときの代わり)。形がなければ null。 */
export function operandsBounds(operands: readonly BooleanOperand[]): Rect | null {
  return pathBoundsRect(operands.flatMap((operand) => operand.subpaths));
}
