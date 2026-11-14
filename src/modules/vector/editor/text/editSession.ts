/**
 * 本文の編集のセッション (§4.7)。編集欄 (`TextEditOverlay`) とテキストツールが使い、store だけを通して文書を変える。
 * React に依存しないので、履歴の扱いを store だけでテストできる。
 *
 * 履歴の規則:
 * - 開始から終了までで履歴 1 件。入力のたびに積まず、1 つのジェスチャー (`beginGesture` 〜 `commitGesture`)
 *   の中で文書を入力に追従させる。大きさは同じ変更の中で `fitTextNodes` を通す
 * - ジェスチャーは最初の入力で始める (本文を変えずに終えたら、履歴も `revision` も増えない)。
 *   テキストツールで作ったときは、作成からジェスチャーに含める
 * - 作ってすぐ空のまま終えたら、ジェスチャーを取り消す (履歴にも `revision` にも残らない)。
 *   既存のテキストを空にして終えたら、削除として履歴 1 件
 * - 途中でほかの操作 (`apply` など) がジェスチャーを確定したら、次の入力から新しいジェスチャーにする
 * - ウィンドウのフォーカスが外れると、キャンバスは開いているジェスチャーを取り消す。本文の編集は
 *   続けるので、そのときだけは取り消された直後に同じ内容でジェスチャーを開き直す
 *   (`markInterrupted`。ほかの理由の取消、たとえば Undo はそのまま受け入れる)
 *
 * 上限 (`maxTextLength`、`maxTotalTextBytes`) を超える本文と、対になっていないサロゲートを含む本文は
 * 文書に入れない (`setText` が false を返し、編集欄が元に戻す)。
 */
import type { StoreApi } from "zustand";
import { utf8Length } from "../model/assets";
import { CANVAS_LIMITS } from "../model/limits";
import { deleteNodes, insertNode } from "../model/structure";
import { updateNode } from "../model/transform";
import { getNode, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, TextNode } from "../model/types";
import { hasLoneSurrogate } from "../model/validate";
import { codePointLength } from "../render/measureText";
import type { TextMeasurer } from "../render/types";
import type { DocRecipe, EditorStore } from "../state/types";
import { fitTextNodes } from "./fit";

type Store = StoreApi<EditorStore>;

/** 本文を文書に入れられるか。入れられなければ理由。 */
export type TextRejection = "lone-surrogate" | "too-long" | "total-too-large";

export function checkText(text: string, otherTextBytes: number): TextRejection | null {
  if (hasLoneSurrogate(text)) return "lone-surrogate";
  if (
    text.length > CANVAS_LIMITS.maxTextLength &&
    codePointLength(text) > CANVAS_LIMITS.maxTextLength
  )
    return "too-long";
  if (otherTextBytes + utf8Length(text) > CANVAS_LIMITS.maxTotalTextBytes) return "total-too-large";
  return null;
}

/** `id` 以外のテキストの本文の UTF-8 の合計。 */
function otherTextBytes(doc: CanvasDocument, id: NodeId): number {
  let total = 0;
  for (const node of Object.values(doc.nodes))
    if (node.type === "text" && node.id !== id) total += utf8Length(node.text);
  return total;
}

export class TextEditSession {
  readonly nodeId: NodeId;
  /** 編集を始めた時点の本文 */
  readonly initialText: string;
  /** 文書に入れた最後の本文 */
  text: string;
  /** 本文が変わったことを編集欄に知らせる (Undo などで文書の側が変わったとき) */
  onExternalText: ((text: string) => void) | null = null;

  private readonly store: Store;
  private readonly measurer: TextMeasurer;
  /** テキストツールで作ったとき、ノードを入れる変更。文書にノードがなければ本文より先に当てる */
  private readonly insert: DocRecipe | null;
  private readonly otherBytes: number;
  /** このセッションが開いたジェスチャーの開始時点の文書。開いていなければ null */
  private base: CanvasDocument | null = null;
  private interrupted = false;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(store: Store, nodeId: NodeId, measurer: TextMeasurer, insert: DocRecipe | null) {
    this.store = store;
    this.nodeId = nodeId;
    this.measurer = measurer;
    this.insert = insert;
    const { doc } = store.getState();
    const node = getNode(doc, nodeId);
    this.initialText = node?.type === "text" ? node.text : "";
    this.text = this.initialText;
    this.otherBytes = otherTextBytes(doc, nodeId);
    this.unsubscribe = store.subscribe((state, previous) => {
      if (previous.gestureActive && !state.gestureActive) this.onGestureEnded();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 本文を `text` にする変更 (ジェスチャーの開始時点の文書に当てる)。 */
  private recipe(text: string): DocRecipe {
    const { nodeId, insert, measurer } = this;
    return (doc) => {
      let next = doc;
      if (!getNode(next, nodeId)) {
        if (!insert) return doc;
        next = insert(next);
        if (!getNode(next, nodeId)) return doc;
      }
      next = updateNode(next, nodeId, { text });
      return fitTextNodes(next, [nodeId], measurer);
    };
  }

  private ensureGesture(): void {
    if (this.base !== null) return;
    const state = this.store.getState();
    state.beginGesture();
    this.base = this.store.getState().doc;
  }

  /** ジェスチャーを開いて本文を当てる (開いていれば当て直すだけ)。 */
  private push(text: string): void {
    this.ensureGesture();
    this.store.getState().updateGesture(this.recipe(text));
  }

  /** 作成を含めて始める (テキストツール)。ノードが入らなければ false。 */
  startCreation(): boolean {
    this.push(this.text);
    if (getNode(this.store.getState().doc, this.nodeId)) return true;
    this.store.getState().cancelGesture();
    this.base = null;
    return false;
  }

  /**
   * 入力欄の本文を文書に入れる。上限を超える・対になっていないサロゲートを含むなら入れずに false を返す
   * (呼び出し側が入力欄を元に戻す)。
   */
  setText(text: string): boolean {
    if (this.closed) return false;
    if (checkText(text, this.otherBytes) !== null) return false;
    this.interrupted = false;
    this.text = text;
    const node = getNode(this.store.getState().doc, this.nodeId);
    if (this.base === null && node?.type === "text" && node.text === text) return true;
    this.push(text);
    return true;
  }

  /**
   * ウィンドウのフォーカスが外れた (入力欄の blur のうち、文書がフォーカスを失ったもの)。
   * 直後にキャンバスがジェスチャーを取り消すので、開き直す。入力欄にフォーカスが戻ったら解除する。
   */
  markInterrupted(): void {
    this.interrupted = true;
  }

  clearInterrupted(): void {
    this.interrupted = false;
  }

  /** 開いていたジェスチャーが閉じた (自分で閉じた、ほかの操作が確定した、取り消された)。 */
  private onGestureEnded(): void {
    const base = this.base;
    if (base === null || this.closed) return;
    this.base = null;
    const state = this.store.getState();
    const canceled = state.doc === base;
    if (!canceled) return; // 確定された。次の入力から新しいジェスチャーにする
    if (this.interrupted) {
      // ウィンドウのフォーカス喪失による取消。同じ内容で開き直し、編集を続ける
      this.push(this.text);
      if (this.store.getState().editingTextId !== this.nodeId)
        this.store.getState().startTextEdit(this.nodeId);
      return;
    }
    // Undo などによる取消は受け入れる。ノードが残っていれば、その本文から編集を続ける
    const node = getNode(state.doc, this.nodeId);
    if (node?.type === "text" && node.text !== this.text) {
      this.text = node.text;
      this.onExternalText?.(node.text);
    }
  }

  /**
   * 編集を終える (Esc、入力欄からフォーカスが外れたとき)。空なら消し (作った直後なら何も残さない)、
   * 変わっていれば履歴 1 件として確定する。何度呼んでもよい。
   *
   * `byOthers` は、ほかの操作が本文の編集を終えた (`endTextEdit`、ノードの削除、`load`) 後に、
   * 編集欄が閉じるときに呼ぶ場合。そのときは自分の開いているジェスチャーを閉じるだけにし、
   * 閉じた後の文書 (別の文書を読み込んだ後かもしれない) には本文を入れ直さない。
   */
  finish(byOthers = false): void {
    if (this.closed) return;
    this.closed = true;
    const store = this.store;
    const node = getNode(store.getState().doc, this.nodeId);
    if (node?.type === "text" && (!byOthers || this.base !== null)) {
      // ほかの操作がジェスチャーを閉じた後に、本文が文書とずれていれば入れ直す
      if (!byOthers && node.text !== this.text) this.push(this.text);
      if (this.text === "") {
        this.ensureGesture();
        const nodeId = this.nodeId;
        store
          .getState()
          .updateGesture((doc) => (getNode(doc, nodeId) ? deleteNodes(doc, [nodeId]) : doc));
      }
    }
    const base = this.base;
    this.base = null;
    if (base !== null) {
      // 文書が開始時点と同じなら取り消す (選択も開始時点へ戻る。作った直後に空で終えた場合など)
      if (store.getState().doc === base) store.getState().cancelGesture();
      else store.getState().commitGesture();
    }
    this.unsubscribe();
    if (store.getState().editingTextId === this.nodeId) store.getState().endTextEdit();
  }

  /** 何もせずに閉じる (ノードが消えたなど)。開いているジェスチャーは確定する。 */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const base = this.base;
    this.base = null;
    if (base !== null && this.store.getState().gestureActive) this.store.getState().commitGesture();
    this.unsubscribe();
  }
}

// ---------------------------------------------------------------------------
// 今のセッション (エディタは同時に 1 つしか開かないので、モジュールに 1 つだけ持つ)
// ---------------------------------------------------------------------------

let current: TextEditSession | null = null;

/** 今のセッション。閉じていれば null。 */
export function getTextEditSession(): TextEditSession | null {
  if (current?.isClosed) current = null;
  return current;
}

/**
 * `id` のテキストの編集のセッションを返す。なければ作る (選択ツールが `startTextEdit` を呼んだ場合)。
 * 別のノードのセッションが開いていれば、先に終える。
 */
export function openTextEditSession(
  store: Store,
  id: NodeId,
  measurer: TextMeasurer,
): TextEditSession {
  const existing = getTextEditSession();
  if (existing && existing.nodeId === id) return existing;
  existing?.finish();
  current = new TextEditSession(store, id, measurer, null);
  return current;
}

/**
 * 新しいテキストを入れて、すぐに本文の編集を始める (テキストツール)。作成は編集と同じジェスチャーに含め、
 * 空のまま終えたら何も残さない。入れられなければ false (上限など)。
 */
export function startTextCreation(
  store: Store,
  node: TextNode,
  parent: ParentRef,
  measurer: TextMeasurer,
): boolean {
  getTextEditSession()?.finish();
  const insert: DocRecipe = (doc) => insertNode(doc, node, parent);
  const session = new TextEditSession(store, node.id, measurer, insert);
  session.text = node.text;
  if (!session.startCreation()) {
    session.dispose();
    return false;
  }
  current = session;
  store.getState().startTextEdit(node.id);
  return true;
}

/** 今のセッションを終える。`byOthers` は `TextEditSession.finish` と同じ。 */
export function finishTextEditSession(byOthers = false): void {
  getTextEditSession()?.finish(byOthers);
  current = null;
}
