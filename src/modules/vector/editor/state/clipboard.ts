/**
 * エディタ内のクリップボード (§2.3)。OS のクリップボードは使わない (§2.4)。
 * コピーした時点のノード・子孫・アセットを断片 (`Fragment`) として持つので、
 * 元の文書を変えたり別の作品を開いたりした後でも貼り付けられる。
 */
import { extractFragment, insertFragment, type Fragment } from "../model/fragment";
import type { DocChange } from "../model/structure";
import type { ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId } from "../model/types";

/** 貼り付けるたびにずらす量 (px)。 */
export const PASTE_OFFSET = 10;

export class EditorClipboard {
  private fragment: Fragment | null = null;
  private pasteCount = 0;

  /** 選んだノードをコピーする。何もコピーできなければ false で、前の内容を残す。 */
  copy(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
    const fragment = extractFragment(doc, ids);
    if (!fragment) return false;
    this.fragment = fragment;
    this.pasteCount = 0;
    return true;
  }

  hasContent(): boolean {
    return this.fragment !== null;
  }

  /** コピーした内容 (読み取り専用として扱う)。 */
  get content(): Fragment | null {
    return this.fragment;
  }

  /**
   * `parent` の最前面に新しい ID で貼り付ける。貼り付けるたびに `PASTE_OFFSET` ずつ右下へずらす。
   * 何も入っていないか上限を超えるなら、文書をそのまま返し `ids` は空。
   */
  paste(doc: CanvasDocument, parent: ParentRef): DocChange {
    if (!this.fragment) return { doc, ids: [] };
    const step = (this.pasteCount + 1) * PASTE_OFFSET;
    const result = insertFragment(doc, this.fragment, parent, { offset: { x: step, y: step } });
    if (result.ids.length > 0) this.pasteCount++;
    return result;
  }

  clear(): void {
    this.fragment = null;
    this.pasteCount = 0;
  }
}

/** エディタで使うクリップボード。store と同じく 1 つだけ。 */
export const editorClipboard = new EditorClipboard();
