/**
 * 文書を書き換えずに複数の変更をまとめるための下書き (model の内部用)。
 *
 * - `nodes` / `pages` / `assets` は最初に変えたときにだけ浅く複製する
 * - 変えていないノード・ページは元のオブジェクトのまま使う
 * - `finish()` は、結果が元と同じなら元の文書をそのまま返す
 *
 * 親の参照は元の文書の索引を使い、下書きの中で付け替えたものは上書きの表で追う。
 */
import { hasOwn } from "./ids";
import { getParent, isContainer, type ParentRef } from "./tree";
import type { Asset, AssetId, CanvasDocument, CanvasNode, NodeId, Page } from "./types";

export class DocDraft {
  readonly base: CanvasDocument;
  private nodes: Record<NodeId, CanvasNode> | null = null;
  private pages: Page[] | null = null;
  private assets: Record<AssetId, Asset> | null = null;
  private parents = new Map<NodeId, ParentRef | null>();

  constructor(base: CanvasDocument) {
    this.base = base;
  }

  get(id: NodeId): CanvasNode | undefined {
    const nodes = this.nodes ?? this.base.nodes;
    return hasOwn(nodes, id) ? nodes[id] : undefined;
  }

  has(id: NodeId): boolean {
    return this.get(id) !== undefined;
  }

  /** ノードを置く (同じオブジェクトなら何もしない)。 */
  set(node: CanvasNode): void {
    if (this.get(node.id) === node) return;
    this.nodes ??= { ...this.base.nodes };
    this.nodes[node.id] = node;
  }

  /** ノードを表から消す (親の `children` からは外さない)。 */
  remove(id: NodeId): void {
    if (!this.has(id)) return;
    this.nodes ??= { ...this.base.nodes };
    delete this.nodes[id];
    this.parents.set(id, null);
  }

  /** ノードと子孫を表から消す。 */
  removeSubtree(id: NodeId): void {
    const node = this.get(id);
    if (!node) return;
    if (isContainer(node)) for (const child of node.children) this.removeSubtree(child);
    this.remove(id);
  }

  page(pageId: string): Page | undefined {
    return (this.pages ?? this.base.pages).find((page) => page.id === pageId);
  }

  parentOf(id: NodeId): ParentRef | null {
    return this.parents.has(id) ? (this.parents.get(id) ?? null) : getParent(this.base, id);
  }

  children(parent: ParentRef): readonly NodeId[] {
    if (parent.kind === "page") return this.page(parent.id)?.children ?? [];
    const node = this.get(parent.id);
    return node && isContainer(node) ? node.children : [];
  }

  /** 親の `children` を置き換え、子の親の表を更新する。 */
  setChildren(parent: ParentRef, children: readonly NodeId[]): void {
    for (const child of children) this.parents.set(child, parent);
    if (parent.kind === "page") {
      const pages = this.pages ?? this.base.pages;
      const i = pages.findIndex((page) => page.id === parent.id);
      const page = pages[i];
      if (!page || sameIds(page.children, children)) return;
      const original = this.base.pages.find((p) => p.id === parent.id);
      const next =
        original && sameIds(original.children, children)
          ? original
          : { ...page, children: [...children] };
      this.pages ??= [...this.base.pages];
      this.pages[i] = next;
      return;
    }
    const node = this.get(parent.id);
    if (!node || !isContainer(node) || sameIds(node.children, children)) return;
    const original = this.base.nodes[parent.id];
    if (original && isContainer(original) && original.type === node.type) {
      const restored = sameIds(original.children, children) && sameExceptChildren(original, node);
      if (restored) {
        this.set(original);
        return;
      }
    }
    this.set({ ...node, children: [...children] });
  }

  /** 親の `children` から外す。外した位置を返す (なければ -1)。 */
  detach(id: NodeId): number {
    const parent = this.parentOf(id);
    if (!parent) return -1;
    const children = this.children(parent);
    const index = children.indexOf(id);
    if (index < 0) return -1;
    this.setChildren(
      parent,
      children.filter((child) => child !== id),
    );
    this.parents.set(id, null);
    return index;
  }

  /** 親の `children` の `index` (省略すると末尾 = 最前面) に入れる。 */
  attach(id: NodeId, parent: ParentRef, index?: number): void {
    const children = [...this.children(parent)];
    const at =
      index === undefined ? children.length : Math.max(0, Math.min(index, children.length));
    children.splice(at, 0, id);
    this.setChildren(parent, children);
  }

  asset(id: AssetId): Asset | undefined {
    const assets = this.assets ?? this.base.assets;
    return hasOwn(assets, id) ? assets[id] : undefined;
  }

  setAsset(id: AssetId, asset: Asset): void {
    if (this.asset(id) === asset) return;
    this.assets ??= { ...this.base.assets };
    this.assets[id] = asset;
  }

  /** 結果の文書。何も変わっていなければ元の文書を返す。 */
  finish(): CanvasDocument {
    const nodes = this.nodes && changedRecord(this.base.nodes, this.nodes) ? this.nodes : null;
    const pages =
      this.pages && this.pages.some((page, i) => page !== this.base.pages[i]) ? this.pages : null;
    const assets = this.assets && changedRecord(this.base.assets, this.assets) ? this.assets : null;
    if (!nodes && !pages && !assets) return this.base;
    return {
      ...this.base,
      pages: pages ?? this.base.pages,
      nodes: nodes ?? this.base.nodes,
      assets: assets ?? this.base.assets,
    };
  }
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameExceptChildren(a: CanvasNode, b: CanvasNode): boolean {
  const ka = Object.keys(a) as (keyof CanvasNode)[];
  return (
    ka.length === Object.keys(b).length &&
    ka.every((key) => key === ("children" as keyof CanvasNode) || a[key] === b[key])
  );
}

function changedRecord<T>(base: Record<string, T>, next: Record<string, T>): boolean {
  const baseKeys = Object.keys(base);
  const nextKeys = Object.keys(next);
  if (baseKeys.length !== nextKeys.length) return true;
  return nextKeys.some((key) => !hasOwn(base, key) || base[key] !== next[key]);
}
