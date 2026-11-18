/**
 * 本文の編集欄 (§4.3 / §4.7)。store の `editingTextId` があるとき、テキストの位置に `<textarea>` を重ねる。
 * 日本語入力はブラウザに任せる。履歴と文書の扱いは `editSession.ts`。
 *
 * - キャンバスの HTML の層 (`pointer-events: none`、ポインター操作はツールへ渡さない) に、画面座標で置く。
 *   入力欄は文書の大きさのまま作り、倍率は `transform: scale` で掛ける。行分割の計測 (canvas) と同じ
 *   フォントサイズでブラウザが組むので、折り返しの位置が描画とそろいやすい
 * - 見た目は描画 (`buildNodeShell`) と同じフォント・行の高さ・字間・揃え。編集中のテキストは文書の層では
 *   描かない (`DocumentLayer`)。入力欄の文字をそのまま見せる
 * - 表示位置や倍率、ノードの位置・大きさが変わったら追従する
 * - 回転したテキストと回転した frame の中のテキストは、入力欄も同じ角度 (ページ上の角度 φ) で回し、
 *   回転した箱の左上の角に合わせる (§4.11.7。CSS の `transform` に `rotate` を足す)。回転していなければ第 1 段階と同じ
 * - 終了は Esc と、入力欄からフォーカスが外れたとき。日本語入力の変換中の Enter と Esc は変換の操作として扱う。
 *   ウィンドウのフォーカスが外れただけ (アプリの切替) なら終えない。Chromium は入力欄に focusout も送るので
 *   `document.hasFocus()` で見分ける。WebKit (Safari 15〜17.5 相当) は blur だけで focusout を送らないので、
 *   React の onBlur は呼ばれない。どちらでもキャンバスは開いているジェスチャーに触らない (§4.4)
 * - 入力欄の中の Cmd/Ctrl+Z は入力欄の取り消しとして働く (キャンバスは入力欄にフォーカスがある間のキーを取らない)
 * - StrictMode の effect の後片付けが表示の直後に 1 回余分に走っても、編集を終えない
 *   (後片付けで終えるのは次のマイクロタスクで、すぐに effect が走り直したら取りやめる)
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import type { CSSProperties } from "react";
import { isComposing } from "../canvas/input";
import { pageToScreen } from "../canvas/viewport";
import { applyToPoint, cosSinDeg } from "../geometry/matrix";
import { coordinateMatrix, isTranslation, nodePageMatrix, pageRotation } from "../model/geometry";
import { getNode } from "../model/tree";
import type { CanvasDocument, NodeId, Point, TextNode } from "../model/types";
import type { Viewport } from "../state/types";
import { canvasTextMeasurer } from "../render/measureText";
import { editorStore, useEditorStore } from "../state/store";
import {
  finishTextEditSession,
  getTextEditSession,
  openTextEditSession,
  type TextEditSession,
} from "./editSession";
import { documentZoom, editorStyle } from "./editorStyle";

/** 変換を確定した直後の Esc を変換の操作とみなす時間 (ms)。Safari は compositionend の後に keydown を送る。 */
const COMPOSITION_GRACE_MS = 50;

/**
 * 入力欄の置き方。`rotation` が null なら回転していない (`origin` は親の座標系の原点のページ座標。第 1 段階と同じ)。
 * 回転していれば `origin` は回転した箱の左上の角 (ページ座標)、`rotation` はページ上の角度 (度)。
 */
interface Placement {
  originX: number;
  originY: number;
  rotation: number | null;
}

function placementOf(doc: CanvasDocument, id: NodeId): Placement {
  const node = getNode(doc, id);
  const space = coordinateMatrix(doc, id);
  if (!node || node.type !== "text" || (node.rotation === 0 && isTranslation(space)))
    return { originX: space.e, originY: space.f, rotation: null };
  const corner = applyToPoint(nodePageMatrix(doc, id), { x: 0, y: 0 });
  return { originX: corner.x, originY: corner.y, rotation: pageRotation(doc, id) };
}

/**
 * 回転したテキストの入力欄の見た目。`editorStyle` を回転した箱の左上の角に置いて求め、入力欄の左上からその角
 * までのずれ (余白と揃えのずらし) を同じ角度で回して置き直し、`transform` に `rotate` を足す
 * (`transform-origin` は入力欄の左上のまま)。
 */
function rotatedEditorStyle(
  node: TextNode,
  corner: Point,
  rotation: number,
  viewport: Viewport,
  uiZoom: number,
): CSSProperties {
  const ui = Number.isFinite(uiZoom) && uiZoom > 0 ? uiZoom : 1;
  // `editorStyle` はノードの左上を origin + (x, y) に置くので、角がそこに来る origin を渡す
  const style = editorStyle(node, { x: corner.x - node.x, y: corner.y - node.y }, viewport, ui);
  if (rotation === 0) return style;
  const screen = pageToScreen(viewport, corner);
  const left = typeof style.left === "number" ? style.left : 0;
  const top = typeof style.top === "number" ? style.top : 0;
  // 入力欄の左上から角へのずれ (画面 px)。回していない欄では左上 = 角 + ずれ
  const offset = { x: left / ui - screen.x, y: top / ui - screen.y };
  const { cos, sin } = cosSinDeg(rotation);
  const turned = { x: offset.x * cos - offset.y * sin, y: offset.x * sin + offset.y * cos };
  return {
    ...style,
    left: (screen.x + turned.x) * ui,
    top: (screen.y + turned.y) * ui,
    transform: `rotate(${rotation}deg) ${String(style.transform ?? "")}`.trim(),
  };
}

/** 入力欄の中身を `text` に戻す。カーソルは入力が始まった位置のあたりに置く。 */
function revertValue(element: HTMLTextAreaElement, text: string): void {
  const removed = element.value.length - text.length;
  const caret = Math.max(0, Math.min(text.length, element.selectionStart - Math.max(0, removed)));
  element.value = text;
  element.setSelectionRange(caret, caret);
}

function TextEditor({ id }: { id: NodeId }) {
  const node = useEditorStore((state) => {
    const found = getNode(state.doc, id);
    return found?.type === "text" ? found : undefined;
  });
  const originX = useEditorStore((state) => placementOf(state.doc, id).originX);
  const originY = useEditorStore((state) => placementOf(state.doc, id).originY);
  const rotation = useEditorStore((state) => placementOf(state.doc, id).rotation);
  const viewport = useEditorStore((state) => state.viewport);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [initialText] = useState(() => node?.text ?? "");
  const composing = useRef(false);
  const compositionEndedAt = useRef(Number.NEGATIVE_INFINITY);
  const pendingClose = useRef<{ canceled: boolean } | null>(null);

  // セッションを開く。後片付けで終えるのは次のマイクロタスクで、走り直したら取りやめる (StrictMode)
  useEffect(() => {
    if (pendingClose.current) pendingClose.current.canceled = true;
    pendingClose.current = null;
    const session = openTextEditSession(editorStore, id, canvasTextMeasurer);
    session.onExternalText = (text) => {
      const element = ref.current;
      if (element && !composing.current && element.value !== text) element.value = text;
    };
    return () => {
      session.onExternalText = null;
      const token = { canceled: false };
      pendingClose.current = token;
      queueMicrotask(() => {
        if (token.canceled) return;
        // ほかの操作が編集を終えた (Undo、削除、別の文書の読み込みなど) か、キャンバスが閉じる
        if (getTextEditSession() === session) finishTextEditSession(true);
        else session.finish(true);
      });
    };
  }, [id]);

  // 開いたら入力欄にフォーカスを移す。既存の本文は全体を選ぶ
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    if (element.value !== "") element.select();
  }, []);

  // 入力欄と祖先 (overflow: hidden) が、カーソルを見せるためにスクロールしたら戻す
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const targets: HTMLElement[] = [element];
    const canvas = element.closest<HTMLElement>("[data-canvas-view]");
    if (canvas)
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        targets.push(parent);
        if (parent === canvas) break;
      }
    const reset = (event: Event) => {
      const target = event.currentTarget as HTMLElement;
      if (target.scrollTop !== 0) target.scrollTop = 0;
      if (target.scrollLeft !== 0) target.scrollLeft = 0;
    };
    for (const target of targets) target.addEventListener("scroll", reset);
    return () => {
      for (const target of targets) target.removeEventListener("scroll", reset);
    };
  }, []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.scrollTop !== 0) element.scrollTop = 0;
    if (element.scrollLeft !== 0) element.scrollLeft = 0;
  });

  if (!node) return null;

  const session = (): TextEditSession | null => {
    const current = getTextEditSession();
    return current?.nodeId === id ? current : null;
  };

  const push = (element: HTMLTextAreaElement) => {
    const current = session();
    if (!current) return;
    if (current.setText(element.value)) return;
    // 上限を超える・対になっていないサロゲートを含む入力は入れずに戻す (変換中は確定してから戻す)
    if (!composing.current) revertValue(element, current.text);
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => push(event.currentTarget);

  const onCompositionStart = () => {
    composing.current = true;
  };

  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false;
    compositionEndedAt.current = event.timeStamp;
    push(event.currentTarget);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
    if (
      isComposing(event.nativeEvent) ||
      composing.current ||
      event.timeStamp - compositionEndedAt.current < COMPOSITION_GRACE_MS
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest<HTMLElement>("[data-canvas-view]");
    finishTextEditSession();
    // 続けてキャンバスのショートカットが効くよう、フォーカスをキャンバスへ戻す
    canvas?.focus({ preventScroll: true });
  };

  const onBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    // ウィンドウのフォーカスが外れただけ (アプリの切替) なら終えない。入力欄は戻ったときにまたフォーカスを持つ
    if (!document.hasFocus() && document.activeElement === event.currentTarget) return;
    if (session()) finishTextEditSession();
  };

  return (
    <textarea
      ref={ref}
      data-canvas-text-editor=""
      aria-label="テキストの本文"
      // 禁則 (line-break: strict) は内容の言語で変わる。ページの言語に関係なく行分割 (lineBreak.ts) とそろえる
      lang="ja"
      defaultValue={initialText}
      wrap={node.sizing === "auto-width" ? "off" : "soft"}
      rows={1}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      style={
        rotation === null
          ? editorStyle(node, { x: originX, y: originY }, viewport, documentZoom())
          : rotatedEditorStyle(node, { x: originX, y: originY }, rotation, viewport, documentZoom())
      }
      onChange={onChange}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}

/** 本文の編集中だけキャンバスに重ねる入力欄。 */
export function TextEditOverlay() {
  const editingId = useEditorStore((state) => state.editingTextId);
  if (editingId === null) return null;
  return <TextEditor key={editingId} id={editingId} />;
}
