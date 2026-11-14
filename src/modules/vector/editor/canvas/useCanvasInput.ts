/**
 * キャンバスの入力 (§4.4)。DOM のイベントを `CanvasPointerEvent` / `CanvasKeyEvent` に直して
 * 現在のツールへ渡し、ホイール・ピンチ・ショートカット・Space の手のひらを受け持つ。
 *
 * - ポインターは `setPointerCapture` で追う。同時に追うのは 1 本だけ
 * - Space を押している間と中ボタンのドラッグは、どのツールでも手のひら (`handTool`) へ渡す
 * - `onCancel` は、ドラッグの途中の Esc、ツールの切替、ポインターの取消、ウィンドウからのフォーカス喪失、
 *   キャンバスが画面から外れるときに呼ぶ。呼んだらカーソルの上書きを戻す
 * - キーは window の keydown 1 か所で受け、`canvasKeyScope` の範囲だけを取る
 *   (エディタの外とモーダルの間は何もしない。入力欄と変換中は文字キーを効かせない。
 *   エディタの中のボタンでは Space・Enter・矢印を部品に任せる)
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { StoreApi } from "zustand";
import type { TextMeasurer } from "../render/types";
import type { EditorStore } from "../state/types";
import { handTool } from "../tools/handTool";
import { TOOLS } from "../tools/registry";
import type { Tool, ToolContext } from "../tools/types";
import {
  canvasKeyScope,
  CONTROL_KEYS,
  isComposing,
  isEditableTarget,
  movedFromPress,
  nextClick,
  toCanvasKeyEvent,
  toCanvasPointerEvent,
  type ClickRecord,
  type KeyInput,
  type PointerInput,
} from "./input";
import { runShortcut, type Shortcut } from "./shortcuts";
import { applyWheel, zoomAt, type Size } from "./viewport";

/** ツールへ渡さない要素 (ルーラー、本文の編集欄など) に付ける属性。 */
export const CANVAS_IGNORE_ATTR = "data-canvas-ignore";

function isIgnoredTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${CANVAS_IGNORE_ATTR}]`) !== null;
}

function isSpaceKey(event: { key: string; code: string }): boolean {
  return event.code === "Space" || event.key === " ";
}

interface ActivePointer {
  id: number;
  button: number;
  clickCount: number;
  tool: Tool;
}

export interface CanvasInputOptions {
  store: StoreApi<EditorStore>;
  measurer: TextMeasurer;
  containerRef: RefObject<HTMLElement | null>;
  size: Size;
  shortcuts?: readonly Shortcut[];
}

export interface CanvasInput {
  /** キャンバスの要素に付けるハンドラ */
  handlers: {
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
    onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
    onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
    onPointerCancel(event: ReactPointerEvent<HTMLElement>): void;
    onLostPointerCapture(event: ReactPointerEvent<HTMLElement>): void;
    onPointerLeave(event: ReactPointerEvent<HTMLElement>): void;
  };
  /** Space を押している間 (一時的な手のひら) */
  spaceHeld: boolean;
  /** 手のひらでドラッグ中 */
  panning: boolean;
  /** ツールが `ToolContext.setCursor` で上書きしたカーソル。null ならツールの `cursor` */
  cursorOverride: string | null;
}

export function useCanvasInput(options: CanvasInputOptions): CanvasInput {
  const { store, measurer, containerRef, size, shortcuts } = options;
  const sizeRef = useRef(size);
  const shortcutsRef = useRef(shortcuts);
  useEffect(() => {
    sizeRef.current = size;
    shortcutsRef.current = shortcuts;
  });

  const [cursorOverride, setCursorOverride] = useState<string | null>(null);
  const ctx: ToolContext = useMemo(
    () => ({ store, measurer, setCursor: setCursorOverride }),
    [store, measurer],
  );
  const active = useRef<ActivePointer | null>(null);
  const lastClick = useRef<ClickRecord | null>(null);
  /** 直前のポインターの位置と修飾キー (ドラッグ中のホイールで移動を合成するため) */
  const lastPointer = useRef<PointerInput | null>(null);
  const spaceRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  const origin = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.top ?? 0 };
  }, [containerRef]);

  /** ツールの `onCancel` を呼び、カーソルの上書きを戻す。 */
  const cancelTool = useCallback(
    (tool: Tool) => {
      tool.onCancel?.(ctx);
      setCursorOverride(null);
    },
    [ctx],
  );

  /** 今のドラッグを捨てる (ツールの onCancel を呼び、キャプチャを外す)。ドラッグがなければ false。 */
  const cancelActive = useCallback(() => {
    const pointer = active.current;
    if (!pointer) return false;
    active.current = null;
    setPanning(false);
    const element = containerRef.current;
    if (element?.hasPointerCapture?.(pointer.id)) element.releasePointerCapture(pointer.id);
    cancelTool(pointer.tool);
    return true;
  }, [containerRef, cancelTool]);

  /**
   * ドラッグと現在のツールの操作を捨てる。
   * ジェスチャーを取り消すのは、ポインターのドラッグの途中だったときだけ (§4.4)。
   * パネルや本文の編集が開いているジェスチャーは、開いた側が閉じる。
   */
  const cancelAll = useCallback(() => {
    const current = TOOLS[store.getState().toolId];
    const pointerTool = active.current?.tool;
    const dragging = cancelActive();
    if (pointerTool !== current) cancelTool(current);
    if (dragging && store.getState().gestureActive) store.getState().cancelGesture();
  }, [store, cancelActive, cancelTool]);

  const releaseSpace = useCallback(() => {
    if (!spaceRef.current) return;
    spaceRef.current = false;
    setSpaceHeld(false);
  }, []);

  // ---- ツールの切替で onCancel (ツールが自分のハンドラの中で setTool を呼んでもその場で呼ぶ) ----
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.toolId === previous.toolId) return;
        const pointer = active.current;
        if (pointer && pointer.tool === TOOLS[previous.toolId]) cancelActive();
        else cancelTool(TOOLS[previous.toolId]);
      }),
    [store, cancelActive, cancelTool],
  );

  // ---- 画面から外れるとき ----
  useEffect(() => cancelAll, [cancelAll]);

  // ---- フォーカス喪失 ----
  useEffect(() => {
    const onBlur = () => {
      cancelAll();
      releaseSpace();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onBlur();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancelAll, releaseSpace]);

  // ---- キー ----
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposing(event)) return;
      const scope = canvasKeyScope(event.target);
      if (scope === "none" || scope === "editable") return;
      if (scope === "control" && (CONTROL_KEYS.has(event.key) || isSpaceKey(event))) return;
      if (isSpaceKey(event)) {
        // Cmd/Ctrl と一緒の Space は手のひらにしない (OS の入力切替などに使われる)
        if (event.metaKey || event.ctrlKey) return;
        // 押している間は手のひら。ページのスクロールにしない
        event.preventDefault();
        if (!spaceRef.current) {
          spaceRef.current = true;
          setSpaceHeld(true);
        }
        return;
      }
      const state = store.getState();
      // ドラッグの途中の Esc は、ツールの onCancel だけに渡す。ツールが取り消さなくても文書を戻す
      if (event.key === "Escape" && cancelActive()) {
        event.preventDefault();
        if (store.getState().gestureActive) store.getState().cancelGesture();
        return;
      }
      // ポインターのドラッグの途中は、Esc のほかのキーをツールにもショートカットにも渡さない
      // (作成のドラッグ中の Delete や矢印が、途中の文書を確定したり履歴を増やしたりしないように)
      if (active.current) return;
      const tool = TOOLS[state.toolId];
      if (tool.onKeyDown?.(toCanvasKeyEvent(event), ctx)) {
        event.preventDefault();
        return;
      }
      const handled = runShortcut(
        event as KeyInput,
        { store, size: sizeRef.current, measurer },
        shortcutsRef.current,
      );
      if (handled) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      // macOS は Cmd を押している間ほかのキーの keyup を送らないので、修飾キーを離したときにも解除する
      if (isSpaceKey(event) || event.key === "Meta" || event.key === "Control") releaseSpace();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [store, ctx, measurer, cancelActive, cancelTool, releaseSpace]);

  /** ドラッグ中のツールへ、表示位置が変わった後の位置で移動を知らせる (ドラッグ中のホイール)。 */
  const notifyMoveAfterViewportChange = useCallback(() => {
    const pointer = active.current;
    const last = lastPointer.current;
    if (!pointer || !last || pointer.tool === handTool) return;
    pointer.tool.onPointerMove?.(
      toCanvasPointerEvent(
        last,
        origin(),
        store.getState().viewport,
        pointer.button,
        pointer.clickCount,
      ),
      ctx,
    );
  }, [store, ctx, origin]);

  // ---- ホイールとピンチ (React の onWheel は passive で preventDefault できないので直接付ける) ----
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let gesture: { zoom: number } | null = null;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Safari / WKWebView のピンチは gesture* で受けるので、その間の ctrl 付き wheel は無視する
      if (gesture && event.ctrlKey) return;
      const state = store.getState();
      const o = origin();
      state.setViewport(
        applyWheel(
          state.viewport,
          {
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            zoom: event.ctrlKey || event.metaKey,
            shift: event.shiftKey,
            anchor: { x: event.clientX - o.x, y: event.clientY - o.y },
          },
          sizeRef.current,
        ),
      );
      notifyMoveAfterViewportChange();
    };

    // Safari / WKWebView (macOS の Tauri) はトラックパッドのピンチを GestureEvent で送る
    type GestureLike = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gesture = { zoom: store.getState().viewport.zoom };
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (!gesture) return;
      const { scale, clientX, clientY } = event as GestureLike;
      const state = store.getState();
      const o = origin();
      state.setViewport(
        zoomAt(state.viewport, { x: clientX - o.x, y: clientY - o.y }, gesture.zoom * scale),
      );
      notifyMoveAfterViewportChange();
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gesture = null;
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gesturechange", onGestureChange);
    element.addEventListener("gestureend", onGestureEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
    };
  }, [containerRef, store, origin, notifyMoveAfterViewportChange]);

  // ---- ポインター ----
  const toEvent = (event: ReactPointerEvent<HTMLElement>, button: number, clickCount: number) =>
    toCanvasPointerEvent(event, origin(), store.getState().viewport, button, clickCount);

  const remember = (event: ReactPointerEvent<HTMLElement>) => {
    lastPointer.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    };
  };

  const handlers: CanvasInput["handlers"] = {
    onPointerDown(event) {
      if (isIgnoredTarget(event.target) || active.current) return;
      // 入力欄の値を確定させてから (選択が変わる前に) ツールへ渡す。フォーカスはキャンバスへ移す
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && isEditableTarget(focused)) focused.blur();
      containerRef.current?.focus({ preventScroll: true });
      const temporaryHand = event.button === 1 || spaceRef.current;
      const tool = temporaryHand ? handTool : TOOLS[store.getState().toolId];
      const o = origin();
      const click = nextClick(lastClick.current, {
        time: event.timeStamp,
        x: event.clientX - o.x,
        y: event.clientY - o.y,
        button: event.button,
      });
      lastClick.current = click;
      active.current = { id: event.pointerId, button: event.button, clickCount: click.count, tool };
      remember(event);
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // 既に離れたポインター (合成したイベントなど) はキャプチャできない。追跡は続ける
      }
      // 中ボタンの自動スクロールと、文字の選択を始めない
      event.preventDefault();
      if (tool === handTool) setPanning(true);
      tool.onPointerDown?.(toEvent(event, event.button, click.count), ctx);
    },
    onPointerMove(event) {
      const pointer = active.current;
      if (pointer) {
        if (event.pointerId !== pointer.id) return;
        // 押したまま動かしたら、次の押下をダブルクリックに数えない
        const o = lastClick.current ? origin() : null;
        if (o && movedFromPress(lastClick.current, event.clientX - o.x, event.clientY - o.y)) {
          lastClick.current = null;
        }
        remember(event);
        pointer.tool.onPointerMove?.(toEvent(event, pointer.button, pointer.clickCount), ctx);
        return;
      }
      if (isIgnoredTarget(event.target)) return;
      const tool = spaceRef.current ? handTool : TOOLS[store.getState().toolId];
      tool.onPointerMove?.(toEvent(event, 0, 0), ctx);
    },
    onPointerUp(event) {
      const pointer = active.current;
      if (!pointer || event.pointerId !== pointer.id) return;
      active.current = null;
      setPanning(false);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      pointer.tool.onPointerUp?.(toEvent(event, pointer.button, pointer.clickCount), ctx);
    },
    onPointerCancel(event) {
      if (active.current?.id === event.pointerId) cancelActive();
    },
    onLostPointerCapture(event) {
      // pointerup の後にも来るが、そのときは active が空なので何もしない
      if (active.current?.id === event.pointerId) cancelActive();
    },
    onPointerLeave() {
      if (!active.current) store.getState().setHovered(null);
    },
  };

  return { handlers, spaceHeld, panning, cursorOverride };
}
