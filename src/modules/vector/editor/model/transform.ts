/**
 * 変形とプロパティの更新 (§4.6、§8.5)。すべて純関数で、変わらなければ引数の文書をそのまま返す。
 *
 * E・F・G が使うもの:
 * - `translateInDraft` / `translateNodes`: 親の座標系での平行移動 (丸めない)
 * - `transformInDraft(draft, id, m)`: 回転と平行移動の行列 `m` (新しい座標系 ← 元の座標系) でノードを写す。
 *   箱を持つノードは中心を写して `rotation` に `m` の角度を足し、線は端点、group とブーリアンは子に同じことをする。
 *   frame の子とパスの点は変えない (§8.5.2 の親の付け替え、§8.5.3 の回転)
 * - `resizeNodes(doc, ids, from, to, options)`: 外接矩形 (ページ座標) の比例のリサイズ (§4.6、§8.5.4)。
 *   回転したノード (祖先の frame の回転を含む) は中心を比例させ、大きさを自分の向きに沿った倍率で変える。
 *   パスは点とハンドルの先をページ座標で写してから箱を合わせる (厳密)
 * - `resizeNodeInOwnFrame(doc, id, rect)`: 1 個のノードを自分の向きでリサイズする (§8.5.4)。`rect` は今の
 *   ノードの座標系 (回転の前の箱の左上が原点) での新しい箱。動かさない辺・角 (Alt なら中心) を `rect` の側で
 *   決めて渡すと、その辺は親の座標系で動かない。`width` `height` は呼び出し側が丸めて渡す。`x` `y` は丸めない
 * - `ownScaleFactors(sx, sy, phi)`: ページの倍率 (sx, sy) を、ページ上の角度 φ のノードの向きの倍率にする
 * - `cleanRotation(r)`: 回転を (-180, 180] にそろえ、小数の誤差 (2 桁より下の 1e-6 以内のずれ) を落とす
 */
import { applyToPoint, invert, type Matrix, multiply, normalizeRotation } from "../geometry/matrix";
import { fitPathNode } from "../path/fit";
import { DocDraft } from "./draft";
import {
  boxCenter,
  coordinateMatrix,
  isBoxNode,
  isTranslation,
  nodeOrigin,
  nodeTransform,
  pageRotation,
  type Rect,
} from "./geometry";
import { hasOwn } from "./ids";
import { topLevelIds } from "./tree";
import type {
  CanvasDocument,
  CanvasNode,
  Guide,
  NodeId,
  Page,
  PageId,
  PathPoint,
  Point,
} from "./types";

// ---------------------------------------------------------------------------
// 平行移動
// ---------------------------------------------------------------------------

/** 下書きの中でノードを動かす。group は座標系を作らないので子を動かす。frame の子は動かさない。 */
export function translateInDraft(draft: DocDraft, id: NodeId, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const node = draft.get(id);
  if (!node) return;
  switch (node.type) {
    case "group":
    case "boolean":
      for (const child of node.children) translateInDraft(draft, child, dx, dy);
      return;
    case "line":
      draft.set({
        ...node,
        x1: node.x1 + dx,
        y1: node.y1 + dy,
        x2: node.x2 + dx,
        y2: node.y2 + dy,
      });
      return;
    default:
      draft.set({ ...node, x: node.x + dx, y: node.y + dy });
  }
}

/** 行列の回転の角度 (度)。 */
function matrixAngle(m: Matrix): number {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

/**
 * 回転を (-180, 180] にそろえる。足し引きで出た小数の誤差 (小数第 2 位の値から 1e-6 以内のずれ) は落とす
 * (画面の操作で書く回転は小数第 2 位までなので、和を元の桁に戻す)。
 */
export function cleanRotation(r: number): number {
  const n = normalizeRotation(r);
  const hundredths = Math.round(n * 100);
  const cleaned = Math.abs(n * 100 - hundredths) < 1e-6 ? hundredths / 100 : n;
  const result = cleaned <= -180 ? cleaned + 360 : cleaned;
  return result === 0 ? 0 : result;
}

/**
 * 下書きの中でノードを、回転と平行移動の行列 `m` (新しい座標系 ← 元の座標系) で写す (§8.5.2、§8.5.3)。
 * - 平行移動だけなら `translateInDraft` と同じ (第 1 段階と同じ値)
 * - 箱を持つノード (frame・パスを含む) は中心を写し、`rotation` に `m` の角度を足す。frame の子とパスの点は変えない
 * - 線は端点を写す。group とブーリアンは子に同じことをする
 * 位置は丸めない。`m` に反転や拡大を含めてはいけない (反転は `model/rotate.ts` の `flipNodes`)。
 */
export function transformInDraft(draft: DocDraft, id: NodeId, m: Matrix): void {
  if (isTranslation(m)) {
    translateInDraft(draft, id, m.e, m.f);
    return;
  }
  const node = draft.get(id);
  if (!node) return;
  switch (node.type) {
    case "group":
    case "boolean":
      for (const child of node.children) transformInDraft(draft, child, m);
      return;
    case "line": {
      const a = applyToPoint(m, { x: node.x1, y: node.y1 });
      const b = applyToPoint(m, { x: node.x2, y: node.y2 });
      draft.set({ ...node, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      return;
    }
    default: {
      const c = applyToPoint(m, boxCenter(node));
      draft.set({
        ...node,
        x: noNegativeZero(c.x - node.width / 2),
        y: noNegativeZero(c.y - node.height / 2),
        rotation: cleanRotation(node.rotation + matrixAngle(m)),
      });
    }
  }
}

/**
 * ノードを (dx, dy) だけ動かす。祖先も選ばれているノードは祖先と一緒に動くので重ねて動かさない。
 * (dx, dy) は親の座標系のずれ (回転した frame の中のノードを、ページの向きに動かすときは
 * `pageVectorToLocal` で直してから渡す)。丸めはしない (呼び出し側が整数の移動量を渡す)。
 */
export function translateNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): CanvasDocument {
  if (dx === 0 && dy === 0) return doc;
  const draft = new DocDraft(doc);
  for (const id of topLevelIds(doc, ids)) translateInDraft(draft, id, dx, dy);
  return draft.finish();
}

// ---------------------------------------------------------------------------
// 拡大縮小
// ---------------------------------------------------------------------------

export interface ResizeOptions {
  /** 結果の辺を整数に丸める (左右・上下の辺をそれぞれ丸めるので、隣り合う図形の間に隙間ができない) */
  round?: boolean;
}

function normalizeRect(r: Rect): Rect {
  return {
    x: r.width < 0 ? r.x + r.width : r.x,
    y: r.height < 0 ? r.y + r.height : r.y,
    width: Math.abs(r.width),
    height: Math.abs(r.height),
  };
}

/** `-0` を `0` にする (`Object.is` で「変わった」と見なされないように)。 */
const noNegativeZero = (v: number) => (v === 0 ? 0 : v);

/**
 * ページ座標の外接矩形 `from` を `to` へ写すように、ノードを拡大縮小する (§4.6、§8.5.4)。
 *
 * - 複数のノードと group は、子孫の位置と大きさを `from` に対する割合のまま比例させる
 * - frame は自分の矩形だけを変え、子は動かさない (group や複数選択の中の frame も同じ)
 * - テキストはフォントサイズを変えず枠だけを変える。横に引いた (`from` と `to` の幅の比が 1 でない)
 *   だけなら `auto-width` を `auto-height` に、縦に引いた (高さの比が 1 でない) なら `fixed` にする。
 *   縦に引いていなければ、テキストの `height` は丸めでも変えない
 * - 角丸・線の太さ・影は変えない
 * - `from` の幅 (高さ) が 0 の向きは拡大縮小せず、`to` との差だけ動かす
 * - 反転 (負の幅) は扱わない。`from` と `to` は正規化 (負の幅なら左右を入れ替える) してから使う
 * - 中身が変わらなければ引数の文書をそのまま返す
 *
 * 回転 (§8.5.4): ページ上の角度 φ が 0 でないノード (祖先の frame の回転を含む) は、中心を比例させ、
 * 大きさを自分の向きに沿った倍率 (`ownScaleFactors`) で変える。角度は変えない。`round` は `width` `height` だけを
 * 丸める (`x` `y` は中心から決める)。テキストの大きさの決め方は、自分の向きでの倍率で判定する。
 * パスは点とハンドルの先をページ座標で P′ = A + S·(P − A) に写してから、角度を変えずに自分の座標系へ戻し、
 * 箱を合わせる (`fitPathNode`。厳密)。線は端点をページ座標で写す。
 */
export function resizeNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  from: Rect,
  to: Rect,
  options: ResizeOptions = {},
): CanvasDocument {
  const src = normalizeRect(from);
  const dst = normalizeRect(to);
  if (src.x === dst.x && src.y === dst.y && src.width === dst.width && src.height === dst.height)
    return doc;
  const sx = src.width === 0 ? 1 : dst.width / src.width;
  const sy = src.height === 0 ? 1 : dst.height / src.height;
  const round = options.round ? Math.round : (v: number) => v;
  const draft = new DocDraft(doc);
  /** ページ座標の点を写す。 */
  const mapPage = (p: Point): Point => ({
    x: dst.x + (p.x - src.x) * sx,
    y: dst.y + (p.y - src.y) * sy,
  });

  /** 回転していない座標系の回転していないノード (第 1 段階と同じ計算)。 */
  const visitPlain = (node: CanvasNode, origin: Point) => {
    const mapX = (lx: number) =>
      noNegativeZero(round(dst.x + (origin.x + lx - src.x) * sx) - origin.x);
    const mapY = (ly: number) =>
      noNegativeZero(round(dst.y + (origin.y + ly - src.y) * sy) - origin.y);
    let next: CanvasNode;
    switch (node.type) {
      case "group":
      case "boolean":
        return;
      case "line":
        next = {
          ...node,
          x1: mapX(node.x1),
          y1: mapY(node.y1),
          x2: mapX(node.x2),
          y2: mapY(node.y2),
        };
        break;
      default: {
        const left = mapX(node.x);
        const top = mapY(node.y);
        const width = Math.max(0, mapX(node.x + node.width) - left);
        let height = Math.max(0, mapY(node.y + node.height) - top);
        if (node.type === "text") {
          let sizing = node.sizing;
          if (sy !== 1) sizing = "fixed";
          else {
            height = node.height; // 縦に引いていなければ、丸めでも高さを変えない
            if (sx !== 1 && sizing === "auto-width") sizing = "auto-height";
          }
          next = { ...node, x: left, y: top, width, height, sizing };
        } else next = { ...node, x: left, y: top, width, height };
      }
    }
    if (!shallowEqual(next, node)) draft.set(next);
  };

  /** 回転したノードか、回転した frame の中のノードか、パス。`space` はページ ← 親の座標系。 */
  const visitRotated = (node: CanvasNode, space: Matrix) => {
    const back = invert(space);
    if (!back) return;
    const toParent = (p: Point) => applyToPoint(back, mapPage(applyToPoint(space, p)));
    let next: CanvasNode;
    switch (node.type) {
      case "group":
      case "boolean":
        return;
      case "line": {
        const a = toParent({ x: node.x1, y: node.y1 });
        const b = toParent({ x: node.x2, y: node.y2 });
        next = { ...node, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        break;
      }
      case "path": {
        // 点とハンドルの先をページ座標で写し、角度を変えずに自分の座標系へ戻す (箱はあとで合わせる)
        const own = multiply(space, nodeTransform(node));
        const ownBack = invert(own);
        if (!ownBack) return;
        const mapLocal = (p: Point) => applyToPoint(ownBack, mapPage(applyToPoint(own, p)));
        next = fitPathNode({
          ...node,
          subpaths: node.subpaths.map((sub) => ({
            ...sub,
            points: sub.points.map((pt) => mapPathPoint(pt, mapLocal)),
          })),
        });
        break;
      }
      default: {
        const phi = pageRotation(doc, node.id);
        const f = ownScaleFactors(sx, sy, phi);
        const width = Math.max(0, round(node.width * f.x));
        let height = Math.max(0, round(node.height * f.y));
        let sizing = node.type === "text" ? node.sizing : null;
        if (node.type === "text") {
          if (!nearlyOne(f.y)) sizing = "fixed";
          else {
            height = node.height; // 自分の向きで縦に引いていなければ、高さを変えない
            if (!nearlyOne(f.x) && sizing === "auto-width") sizing = "auto-height";
          }
        }
        const c = toParent(boxCenter(node));
        const box = {
          x: noNegativeZero(c.x - width / 2),
          y: noNegativeZero(c.y - height / 2),
          width,
          height,
        };
        next =
          node.type === "text" && sizing !== null
            ? { ...node, ...box, sizing }
            : { ...node, ...box };
      }
    }
    if (!shallowEqual(next, node)) draft.set(next);
  };

  const visit = (id: NodeId) => {
    const node = draft.get(id);
    if (!node) return;
    if (node.type === "group" || node.type === "boolean") {
      for (const child of node.children) visit(child);
      return;
    }
    const space = coordinateMatrix(doc, id);
    // パスは回転していなくても点を写す (箱だけを変えない。§8.5.4)
    const rotated =
      node.type === "path" || !isTranslation(space) || (isBoxNode(node) && node.rotation !== 0);
    if (rotated) visitRotated(node, space);
    else visitPlain(node, nodeOrigin(doc, id));
  };

  for (const id of topLevelIds(doc, ids)) visit(id);
  return draft.finish();
}

/** 1 に十分近いか (自分の向きの倍率の判定。√ の誤差を見ない)。 */
function nearlyOne(v: number): boolean {
  return Math.abs(v - 1) <= 1e-9;
}

/**
 * ページの倍率 (sx, sy) を、ページ上の角度 φ のノードの向きの倍率にする (§8.5.4)。
 * 幅は √((sx·cos φ)² + (sy·sin φ)²)、高さは √((sx·sin φ)² + (sy·cos φ)²)。φ が 90° の倍数なら厳密。
 */
export function ownScaleFactors(sx: number, sy: number, phi: number): Point {
  const r = ((((phi % 360) + 360) % 360) * Math.PI) / 180;
  const quarter = ((phi % 90) + 90) % 90 === 0;
  const cos = quarter ? Math.round(Math.cos(r)) : Math.cos(r);
  const sin = quarter ? Math.round(Math.sin(r)) : Math.sin(r);
  return {
    x: Math.hypot(sx * cos, sy * sin),
    y: Math.hypot(sx * sin, sy * cos),
  };
}

/** 点とハンドルの先を `map` で写した点 (ハンドルは点からの相対に戻す)。 */
function mapPathPoint(pt: PathPoint, map: (p: Point) => Point): PathPoint {
  const p = map(pt);
  const handle = (h: Point | null) => {
    if (!h) return null;
    const tip = map({ x: pt.x + h.x, y: pt.y + h.y });
    return { x: tip.x - p.x, y: tip.y - p.y };
  };
  return { ...pt, x: p.x, y: p.y, in: handle(pt.in), out: handle(pt.out) };
}

/**
 * 1 個のノードを自分の向きでリサイズする (§8.5.4、§8.5.5)。`rect` は今のノードの座標系 (回転の前の箱の左上が
 * 原点) での新しい箱 (`width` `height` は 0 以上で、呼び出し側が丸める)。新しい箱が `rect` の位置にそのまま
 * 描かれるよう `x` `y` を決める (丸めない)。動かさない辺 (Alt なら中心) を `rect` の側でそろえれば、その辺は
 * 親の座標系で動かない。
 *
 * - テキストは `resizeNodes` と同じ規則 (自分の向きで縦に引いたら `fixed`、横だけなら `auto-width` を
 *   `auto-height` に。縦に引いていなければ `height` を変えない)
 * - パスは点とハンドルを自分の座標系で p′ = a + S·(p − a) に写す (a は動かさない点) ので、厳密に変わる
 * - frame の子は変えない
 * - 箱を持たないノード (線・group・ブーリアン) は何もしない
 */
export function resizeNodeInOwnFrame(doc: CanvasDocument, id: NodeId, rect: Rect): CanvasDocument {
  const node = doc.nodes[id];
  if (!node || !hasOwn(doc.nodes, id) || !isBoxNode(node)) return doc;
  const width = Math.max(0, rect.width);
  const height = Math.max(0, rect.height);
  const center = applyToPoint(nodeTransform(node), {
    x: rect.x + width / 2,
    y: rect.y + height / 2,
  });
  let next: CanvasNode = {
    ...node,
    x: noNegativeZero(center.x - width / 2),
    y: noNegativeZero(center.y - height / 2),
    width,
    height,
  };
  if (node.type === "text" && next.type === "text") {
    let sizing = node.sizing;
    if (height !== node.height) sizing = "fixed";
    else if (width !== node.width && sizing === "auto-width") sizing = "auto-height";
    next = { ...next, sizing };
  }
  if (node.type === "path" && next.type === "path") {
    const kx = node.width === 0 ? 1 : width / node.width;
    const ky = node.height === 0 ? 1 : height / node.height;
    next = fitPathNode({
      ...next,
      subpaths: node.subpaths.map((sub) => ({
        ...sub,
        points: sub.points.map((pt) => scalePathPoint(pt, kx, ky)),
      })),
    });
  }
  if (shallowEqual(next, node)) return doc;
  const draft = new DocDraft(doc);
  draft.set(next);
  return draft.finish();
}

/** 点とハンドルを原点からの倍率で写す。 */
function scalePathPoint(pt: PathPoint, kx: number, ky: number): PathPoint {
  const scale = (h: Point | null) => (h ? { x: h.x * kx, y: h.y * ky } : null);
  return { ...pt, x: pt.x * kx, y: pt.y * ky, in: scale(pt.in), out: scale(pt.out) };
}

// ---------------------------------------------------------------------------
// プロパティの部分更新
// ---------------------------------------------------------------------------

type PatchOf<T> = T extends unknown ? Partial<Omit<T, "id" | "type" | "children">> : never;

/**
 * ノードの部分更新。種別ごとのフィールドの和 (`id` / `type` / `children` は変えられない)。
 * 複数選択に当てるとき、そのノードにないフィールドは無視する (楕円に `radius` を当てても足さない)。
 * 線に `stroke: null` は当てない (線の stroke は null にできないため)。
 */
export type NodePatch = PatchOf<CanvasNode>;

/** JSON の値として等しいか (塗りや影のオブジェクトを値で比べる)。 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true; // 0 と -0 は同じと見る
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (key) =>
      hasOwn(b, key) &&
      jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** 浅い比較。数値は `===` で比べる (`0` と `-0` を同じと見る)。 */
function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a) as (keyof typeof a)[];
  return ka.length === Object.keys(b).length && ka.every((key) => a[key] === b[key]);
}

function patchNode(node: CanvasNode, patch: NodePatch): CanvasNode {
  let next: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id" || key === "type" || key === "children" || !hasOwn(node, key)) continue;
    if (value === undefined) continue;
    // 線の stroke は null にできない (§4.6)。混在選択に「線なし」を当てたときは線を外す
    if (key === "stroke" && value === null && node.type === "line") continue;
    const current = (node as unknown as Record<string, unknown>)[key];
    if (jsonEqual(current, value)) continue;
    next ??= { ...node };
    next[key] = value;
  }
  return next ? (next as unknown as CanvasNode) : node;
}

/** 1 つのノードのプロパティを変える。値が同じなら文書をそのまま返す。 */
export function updateNode(doc: CanvasDocument, id: NodeId, patch: NodePatch): CanvasDocument {
  return updateNodes(doc, [id], patch);
}

/** 複数のノードに同じ変更を当てる (プロパティパネルの複数選択)。 */
export function updateNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  patch: NodePatch,
): CanvasDocument {
  const draft = new DocDraft(doc);
  for (const id of ids) {
    const node = draft.get(id);
    if (node) draft.set(patchNode(node, patch));
  }
  return draft.finish();
}

/** ノードごとに違う変更を当てる (`patchFor` が null を返したノードは変えない)。 */
export function mapNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  patchFor: (node: CanvasNode) => NodePatch | null,
): CanvasDocument {
  const draft = new DocDraft(doc);
  for (const id of ids) {
    const node = draft.get(id);
    if (!node) continue;
    const patch = patchFor(node);
    if (patch) draft.set(patchNode(node, patch));
  }
  return draft.finish();
}

// ---------------------------------------------------------------------------
// ページとガイド線
// ---------------------------------------------------------------------------

function replacePage(
  doc: CanvasDocument,
  pageId: PageId,
  change: (page: Page) => Page,
): CanvasDocument {
  const index = doc.pages.findIndex((page) => page.id === pageId);
  const page = doc.pages[index];
  if (!page) return doc;
  const next = change(page);
  if (next === page) return doc;
  const pages = [...doc.pages];
  pages[index] = next;
  return { ...doc, pages };
}

/** ページの名前やガイド線を変える (`children` は木の操作で変える)。 */
export function updatePage(
  doc: CanvasDocument,
  pageId: PageId,
  patch: Partial<Pick<Page, "name" | "guides">>,
): CanvasDocument {
  return replacePage(doc, pageId, (page) => {
    const name = patch.name ?? page.name;
    const guides = patch.guides ?? page.guides;
    if (name === page.name && jsonEqual(guides, page.guides)) return page;
    return { ...page, name, guides };
  });
}

/** ガイド線を足す。 */
export function addGuide(doc: CanvasDocument, pageId: PageId, guide: Guide): CanvasDocument {
  return replacePage(doc, pageId, (page) => ({ ...page, guides: [...page.guides, guide] }));
}

/** `index` 番目のガイド線の位置を変える。 */
export function moveGuide(
  doc: CanvasDocument,
  pageId: PageId,
  index: number,
  position: number,
): CanvasDocument {
  return replacePage(doc, pageId, (page) => {
    const guide = page.guides[index];
    if (!guide || guide.position === position) return page;
    const guides = [...page.guides];
    guides[index] = { ...guide, position };
    return { ...page, guides };
  });
}

/** `index` 番目のガイド線を消す。 */
export function removeGuide(doc: CanvasDocument, pageId: PageId, index: number): CanvasDocument {
  return replacePage(doc, pageId, (page) => {
    if (index < 0 || index >= page.guides.length) return page;
    return { ...page, guides: page.guides.filter((_, i) => i !== index) };
  });
}
