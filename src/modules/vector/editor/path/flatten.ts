/**
 * パスに変換 (`docs/canvas-editor-design.md` §8.10)。純関数で、引数の文書は変えない。
 *
 * - `flattenTargets(doc, ids)`: 変換の対象 (祖先も選ばれているノードを除き、重なり順)。対象にできない選択
 *   (テキスト・画像・埋め込み SVG・frame・group を含む、複数で親が違う、パス 1 個だけ) なら、その理由
 * - `flattenNodes(doc, ids, newId)`: 変換した文書と、選び直す ID。当てられなければ理由
 *
 * 1 個 (§8.10):
 * - 矩形・楕円は §8.6 の点の形 (`rectSubpaths` / `ellipseSubpaths`) を、同じ箱・同じ回転のパスにする。
 *   始点と向きは描画と同じなので、破線の位置も変わらない。線は塗りなしの開いた輪郭 1 本 (回転 0)。
 *   ブーリアンは結果の形 (`getBooleanResult`、回転 0)。パスは何もしない
 * - 名前・表示・ロック・不透明度・塗り・線・影を引き継ぎ、ID も同じにする (選択とレイヤーの行が続く)。
 *   ブーリアンの子のまま変換したときも、同じ位置の子のままになる (パスは子にできる種類。§8.9.1)
 *
 * 複数 (§8.10、同じ親の中で選んでいるときだけ):
 * - 1 つのパスにまとめ、選択の中で最も前面のものの位置に置く。最背面のノードの名前・不透明度・塗り・線・影を
 *   引き継ぐ (表示、ロックなし)。回転は点に焼き込んで回転 0 にする
 * - 輪郭は重なり順に並べる。塗りのある形は `booleanOperation("union", [その形])` で向きをそろえた輪郭にして
 *   (`nonzero` で塗っても重なった所が穴にならない)、塗りのない形は輪郭をそのまま並べる。ブーリアンの結果は
 *   もとから向きがそろっている。面積のない塗りのある形 (合体が空) は輪郭をそのまま使う
 *
 * 当てないとき (理由を返す): ブーリアンの結果が求められない、合体が求められない形がある、形が 1 つもない
 * (大きさ 0、ブーリアンの結果が空)、結果が §3.5 と §8.3.2 の上限 (座標、大きさ、輪郭・点の数) を超える。
 */
import { booleanOperation } from "../boolean/index";
import { getBooleanResult } from "../boolean/result";
import { nodeMatrix } from "../geometry/matrix";
import { createPath } from "../model/create";
import { DocDraft } from "../model/draft";
import { getNode, getParent, sameParent, topLevelIds, type ParentRef } from "../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, PathNode, Subpath } from "../model/types";
import { geometryWithinLimits, pathPointsWithinLimits } from "../panels/limits";
import { fitPathNode } from "./fit";
import { ellipseSubpaths, lineSubpaths, rectSubpaths } from "./shapes";
import { transformSubpaths } from "./transform";

/** パスにできる種類。 */
type FlattenableNode = Extract<
  CanvasNode,
  { type: "rect" | "ellipse" | "line" | "path" | "boolean" }
>;

export type FlattenFailure =
  | "unsupported"
  | "differentParents"
  | "alreadyPath"
  | "booleanFailed"
  | "unionFailed"
  | "empty"
  | "limits";

/** 当てなかった理由の文 (画面に出す)。 */
export const FLATTEN_FAILURE_MESSAGES: Readonly<Record<FlattenFailure, string>> = {
  unsupported: "パスに変換できるのは矩形・楕円・線・パス・ブーリアンだけです。",
  differentParents: "複数のノードを 1 つのパスにまとめるには、同じ親の中で選んでください。",
  alreadyPath: "すでにパスです。",
  booleanFailed: "ブーリアンの結果を求められないため、パスに変換できません。",
  unionFailed:
    "輪郭の向きをそろえられない (合体を求められない) 形があるため、パスに変換できません。",
  empty: "形がない (大きさが 0 か、ブーリアンの結果が空) ため、パスに変換できません。",
  limits: "結果が座標・大きさ・パスの点の数の上限を超えるため、パスに変換できません。",
};

export type FlattenTargets =
  | { ok: true; nodes: FlattenableNode[]; parent: ParentRef }
  | { ok: false; reason: FlattenFailure };

export type FlattenOutcome =
  | { ok: true; doc: CanvasDocument; ids: NodeId[] }
  | { ok: false; reason: FlattenFailure };

function isFlattenable(node: CanvasNode): node is FlattenableNode {
  return (
    node.type === "rect" ||
    node.type === "ellipse" ||
    node.type === "line" ||
    node.type === "path" ||
    node.type === "boolean"
  );
}

/** 変換の対象。祖先も選ばれているノードを除き、重なり順 (背面が先)。 */
export function flattenTargets(doc: CanvasDocument, ids: readonly NodeId[]): FlattenTargets {
  const tops = topLevelIds(doc, ids);
  if (tops.length === 0) return { ok: false, reason: "unsupported" };
  const nodes: FlattenableNode[] = [];
  let parent: ParentRef | null = null;
  let sameParents = true;
  for (const id of tops) {
    const node = getNode(doc, id);
    if (!node || !isFlattenable(node)) return { ok: false, reason: "unsupported" };
    nodes.push(node);
    const p = getParent(doc, id);
    if (!p) return { ok: false, reason: "unsupported" };
    if (parent === null) parent = p;
    else if (!sameParent(parent, p)) sameParents = false;
  }
  if (!sameParents) return { ok: false, reason: "differentParents" };
  if (parent === null) return { ok: false, reason: "unsupported" };
  if (nodes.length === 1 && nodes[0]?.type === "path") return { ok: false, reason: "alreadyPath" };
  return { ok: true, nodes, parent };
}

/** 形を親の座標系の輪郭にしたもの。求められなければ理由。 */
type ParentShape = { ok: true; subpaths: Subpath[] } | { ok: false; reason: FlattenFailure };

/** ノードの形を親の座標系で (回転を点に焼き込んで)。 */
function parentSpaceShape(doc: CanvasDocument, node: FlattenableNode): ParentShape {
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
      const m = nodeMatrix(node.x, node.y, node.width, node.height, node.rotation);
      return { ok: true, subpaths: transformSubpaths(local, m) };
    }
    case "line":
      return {
        ok: true,
        subpaths: lineSubpaths({ x: node.x1, y: node.y1 }, { x: node.x2, y: node.y2 }),
      };
    case "boolean": {
      const result = getBooleanResult(doc, node.id);
      if (!result) return { ok: false, reason: "booleanFailed" };
      return { ok: true, subpaths: result.subpaths };
    }
  }
}

/** 塗り・線・影 (線は塗りと影を持たない)。 */
function lookOf(node: FlattenableNode): Pick<PathNode, "fill" | "stroke" | "shadow"> {
  if (node.type === "line") return { fill: null, stroke: node.stroke, shadow: null };
  return { fill: node.fill, stroke: node.stroke, shadow: node.shadow };
}

/** 1 個のノードを同じ見た目のパスにする (ID も同じ)。 */
function flattenOne(doc: CanvasDocument, node: FlattenableNode): PathNode | FlattenFailure {
  const common = {
    id: node.id,
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    ...lookOf(node),
  };
  if (node.type === "rect" || node.type === "ellipse") {
    // 箱と回転はそのまま。点は自分の座標系 (箱の左上が原点) で、範囲は箱にぴったり合う
    const subpaths =
      node.type === "rect"
        ? rectSubpaths(node.width, node.height, node.radius)
        : ellipseSubpaths(node.width, node.height);
    if (subpaths.length === 0) return "empty";
    return fitPathNode({
      ...common,
      type: "path",
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation,
      subpaths,
      fillRule: "nonzero",
    });
  }
  const shape = parentSpaceShape(doc, node);
  if (!shape.ok) return shape.reason;
  if (shape.subpaths.length === 0) return "empty";
  return createPath(shape.subpaths, { ...common, fillRule: "nonzero" });
}

/** 複数のノードを 1 つのパスの輪郭にする (重なり順)。 */
function mergedSubpaths(
  doc: CanvasDocument,
  nodes: readonly FlattenableNode[],
): Subpath[] | FlattenFailure {
  const result: Subpath[] = [];
  for (const node of nodes) {
    const shape = parentSpaceShape(doc, node);
    if (!shape.ok) return shape.reason;
    if (shape.subpaths.length === 0) continue;
    const filled = node.type !== "line" && node.fill !== null;
    if (!filled || node.type === "boolean") {
      result.push(...shape.subpaths);
      continue;
    }
    const fillRule = node.type === "path" ? node.fillRule : "nonzero";
    const oriented = booleanOperation("union", [{ subpaths: shape.subpaths, fillRule }]);
    if (oriented === null) return "unionFailed";
    // 面積のない形 (合体が空) は、線の見た目を残すため輪郭をそのまま使う
    result.push(...(oriented.length > 0 ? oriented : shape.subpaths));
  }
  return result;
}

/**
 * 選んだノードをパスに変換する (§8.10)。`newId` は複数をまとめるときの新しいパスの ID
 * (1 個のときは元の ID のまま)。当てられなければ理由を返す (文書は変えない)。
 */
export function flattenNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  newId: NodeId,
): FlattenOutcome {
  const targets = flattenTargets(doc, ids);
  if (!targets.ok) return targets;
  const { nodes, parent } = targets;
  const draft = new DocDraft(doc);
  let path: PathNode;

  if (nodes.length === 1) {
    const node = nodes[0] as FlattenableNode;
    const one = flattenOne(doc, node);
    if (typeof one === "string") return { ok: false, reason: one };
    path = one;
    // ブーリアンの子は消す。ノード自身は同じ ID のパスに置き換える (親の children はそのまま)
    if (node.type === "boolean") for (const child of node.children) draft.removeSubtree(child);
    draft.set(path);
  } else {
    if (getNode(doc, newId) !== undefined) return { ok: false, reason: "unsupported" };
    const subpaths = mergedSubpaths(doc, nodes);
    if (typeof subpaths === "string") return { ok: false, reason: subpaths };
    if (subpaths.length === 0) return { ok: false, reason: "empty" };
    const back = nodes[0] as FlattenableNode;
    path = createPath(subpaths, {
      id: newId,
      name: back.name,
      opacity: back.opacity,
      ...lookOf(back),
      fillRule: "nonzero",
    });
    // 最も前面のノードの位置から、それより背面にある (外す) ノードの数を引いた位置に入れる
    const removing = new Set(nodes.map((node) => node.id));
    const siblings = draft.children(parent);
    const front = nodes[nodes.length - 1] as FlattenableNode;
    const frontIndex = siblings.indexOf(front.id);
    const at = frontIndex - siblings.slice(0, frontIndex).filter((id) => removing.has(id)).length;
    draft.setChildren(
      parent,
      siblings.filter((id) => !removing.has(id)),
    );
    for (const node of nodes) draft.removeSubtree(node.id);
    draft.set(path);
    draft.attach(path.id, parent, at);
  }

  const next = draft.finish();
  if (!geometryWithinLimits(next, [path.id]) || !pathPointsWithinLimits(next, [path.id]))
    return { ok: false, reason: "limits" };
  return { ok: true, doc: next, ids: [path.id] };
}
