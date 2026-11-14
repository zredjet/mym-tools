/**
 * エディタ内のクリップボード (§4.10)。OS のクリップボードは使わない (§2.4)。
 * コピーした時点のノード・子孫・アセットを断片 (`Fragment`) として持つので、
 * 元の文書を変えたり別の作品を開いたりした後でも貼り付けられる。
 */
import { extractFragment, fragmentBounds, insertFragment, type Fragment } from "../model/fragment";
import { getPageBounds, rectsIntersect } from "../model/geometry";
import type { DocChange } from "../model/structure";
import { getNode, getParent, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, Point } from "../model/types";

/** 貼り付けるたびにずらす量 (px)。 */
export const PASTE_OFFSET = 10;

/** コピー元の情報。貼り付け先を決めるのに使う (§4.10)。 */
export interface ClipboardSource {
  /**
   * コピー元の親 (根の親がばらばらなら、最も前面の根の親)。
   * 別の文書に貼るときは、同じ ID の親があるときだけ使われる
   */
  parent: ParentRef | null;
  /** コピーしたノード (根) の元の ID と、これまでに貼り付けた根の ID */
  rootIds: ReadonlySet<NodeId>;
}

export class EditorClipboard {
  private fragment: Fragment | null = null;
  private pasteCount = 0;
  private parent: ParentRef | null = null;
  private roots = new Set<NodeId>();

  /** 選んだノードをコピーする。何もコピーできなければ false で、前の内容を残す。 */
  copy(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
    const fragment = extractFragment(doc, ids);
    if (!fragment) return false;
    // 根の親がばらばらなら、最も前面の根の親を使う (根は背面から並んでいる)
    const roots = fragment.roots;
    this.fragment = fragment;
    this.pasteCount = 0;
    this.parent = getParent(doc, roots[roots.length - 1] ?? "") ?? null;
    this.roots = new Set(fragment.roots);
    return true;
  }

  hasContent(): boolean {
    return this.fragment !== null;
  }

  /** コピーした内容 (読み取り専用として扱う)。 */
  get content(): Fragment | null {
    return this.fragment;
  }

  /** コピー元の親と根の ID。何も入っていなければ null。 */
  get source(): ClipboardSource | null {
    return this.fragment ? { parent: this.parent, rootIds: this.roots } : null;
  }

  /**
   * 次に `parent` へ貼るときのずらす量 (ページ座標)。元の位置から右下へ `PASTE_OFFSET` ずつ、
   * 貼るたびにさらにずらす。貼り付け先が frame で、その矩形と重ならない位置になるなら、
   * frame の中央に置く (§4.10)。
   */
  pasteOffset(doc: CanvasDocument, parent: ParentRef): Point | null {
    if (!this.fragment) return null;
    const step = (this.pasteCount + 1) * PASTE_OFFSET;
    const offset = { x: step, y: step };
    const bounds = fragmentBounds(this.fragment);
    if (parent.kind !== "node" || getNode(doc, parent.id)?.type !== "frame" || !bounds)
      return offset;
    const frame = getPageBounds(doc, parent.id);
    if (!frame) return offset;
    const placed = { ...bounds, x: bounds.x + step, y: bounds.y + step };
    if (rectsIntersect(placed, frame)) return offset;
    return {
      x: Math.round(frame.x + frame.width / 2 - (bounds.x + bounds.width / 2)),
      y: Math.round(frame.y + frame.height / 2 - (bounds.y + bounds.height / 2)),
    };
  }

  /**
   * `parent` の最前面に新しい ID で貼り付ける (位置は `pasteOffset`)。
   * 何も入っていないか上限を超えるなら、文書をそのまま返し `ids` は空。
   */
  paste(doc: CanvasDocument, parent: ParentRef): DocChange {
    const offset = this.pasteOffset(doc, parent);
    if (!this.fragment || !offset) return { doc, ids: [] };
    const result = insertFragment(doc, this.fragment, parent, { offset });
    if (result.ids.length > 0) {
      this.pasteCount++;
      for (const id of result.ids) this.roots.add(id);
    }
    return result;
  }

  clear(): void {
    this.fragment = null;
    this.pasteCount = 0;
    this.parent = null;
    this.roots = new Set();
  }
}

/** エディタで使うクリップボード。store と同じく 1 つだけ。 */
export const editorClipboard = new EditorClipboard();
