/**
 * 変形とプロパティの更新 (§4.6)。すべて純関数で、変わらなければ引数の文書をそのまま返す。
 */
import { DocDraft } from "./draft";
import { nodeOrigin, type Rect } from "./geometry";
import { hasOwn } from "./ids";
import { topLevelIds } from "./tree";
import type { CanvasDocument, CanvasNode, Guide, NodeId, Page, PageId, Point } from "./types";

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

/**
 * ノードを (dx, dy) だけ動かす。祖先も選ばれているノードは祖先と一緒に動くので重ねて動かさない。
 * 丸めはしない (呼び出し側が整数の移動量を渡す)。
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
 * ページ座標の外接矩形 `from` を `to` へ写すように、ノードを拡大縮小する (§4.6)。
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

  const visit = (id: NodeId, origin: Point) => {
    const node = draft.get(id);
    if (!node) return;
    const mapX = (lx: number) =>
      noNegativeZero(round(dst.x + (origin.x + lx - src.x) * sx) - origin.x);
    const mapY = (ly: number) =>
      noNegativeZero(round(dst.y + (origin.y + ly - src.y) * sy) - origin.y);
    let next: CanvasNode;
    switch (node.type) {
      case "group":
        for (const child of node.children) visit(child, origin);
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

  for (const id of topLevelIds(doc, ids)) visit(id, nodeOrigin(doc, id));
  return draft.finish();
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
