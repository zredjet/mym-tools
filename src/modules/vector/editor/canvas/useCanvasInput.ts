/**
 * キャンバスの入力 (§4.4)。DOM のイベントを `CanvasPointerEvent` / `CanvasKeyEvent` に直して
 * 現在のツールへ渡し、ホイール・ピンチ・ショートカット・Space の手のひらを受け持つ。
 *
 * - ポインターは `setPointerCapture` で追う。同時に追うのは 1 本だけ
 * - Space を押している間と中ボタンのドラッグは、どのツールでも手のひら (`handTool`) へ渡す
 * - ツールの切替、Esc、ウィンドウのフォーカス喪失でツールの `onCancel` を呼ぶ
 * - キーは window の keydown 1 か所で受け、入力欄にフォーカスがある間と変換中は何もしない
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
  isComposing,
  isEditableTarget,
  nextClick,
  toCanvasKeyEvent,
  toCanvasPointerEvent,
  type ClickRecord,
  type KeyInput,
} from "./input";
import { runShortcut, type Shortcut } from "./shortcuts";
import { applyWheel, zoomAt, type Size } from "./viewport";

/** ツールへ渡さない要素 (ルーラー、本文の編集欄など) に付ける属性。 */
export const CANVAS_IGNORE_ATTR = "data-canvas-ignore";

function isIgnoredTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${CANVAS_IGNORE_ATTR}]`) !== null;
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
}

export function useCanvasInput(options: CanvasInputOptions): CanvasInput {
  const { store, measurer, containerRef, size, shortcuts } = options;
  const sizeRef = useRef(size);
  const shortcutsRef = useRef(shortcuts);
  useEffect(() => {
    sizeRef.current = size;
    shortcutsRef.current = shortcuts;
  });

  const ctx: ToolContext = useMemo(() => ({ store, measurer }), [store, measurer]);
  const active = useRef<ActivePointer | null>(null);
  const lastClick = useRef<ClickRecord | null>(null);
  const lastClient = useRef<{ clientX: number; clientY: number } | null>(null);
  const spaceRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  const origin = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.top ?? 0 };
  }, [containerRef]);

  /** 今のドラッグを捨てる (ツールの onCancel を呼び、キャプチャを外す)。 */
  const cancelActive = useCallback(() => {
    const pointer = active.current;
    if (!pointer) return false;
    active.current = null;
    setPanning(false);
    const element = containerRef.current;
    if (element?.hasPointerCapture?.(pointer.id)) element.releasePointerCapture(pointer.id);
    pointer.tool.onCancel?.(ctx);
    return true;
  }, [containerRef, ctx]);

  // ---- ツールの切替で onCancel ----
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.toolId === previous.toolId) return;
        const pointer = active.current;
        if (pointer && pointer.tool === TOOLS[previous.toolId]) cancelActive();
        else TOOLS[previous.toolId].onCancel?.(ctx);
      }),
    [store, ctx, cancelActive],
  );

  // ---- フォーカス喪失 ----
  useEffect(() => {
    const onBlur = () => {
      const current = TOOLS[store.getState().toolId];
      const pointerTool = active.current?.tool;
      cancelActive();
      if (pointerTool !== current) current.onCancel?.(ctx);
      spaceRef.current = false;
      setSpaceHeld(false);
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
  }, [store, ctx, cancelActive]);

  // ---- キー ----
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposing(event) || isEditableTarget(event.target)) return;
      if (event.code === "Space" || event.key === " ") {
        // 押している間は手のひら。ボタンのクリックやページのスクロールにしない
        event.preventDefault();
        if (!spaceRef.current) {
          spaceRef.current = true;
          setSpaceHeld(true);
        }
        return;
      }
      const state = store.getState();
      if (event.key === "Escape" && (active.current || state.gestureActive)) {
        event.preventDefault();
        if (!cancelActive()) TOOLS[state.toolId].onCancel?.(ctx);
        if (store.getState().gestureActive) store.getState().cancelGesture();
        return;
      }
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
      if ((event.code === "Space" || event.key === " ") && spaceRef.current) {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [store, ctx, measurer, cancelActive]);

  /** ドラッグ中のツールへ、表示位置が変わった後の位置で移動を知らせる (ドラッグ中のホイール)。 */
  const notifyMoveAfterViewportChange = useCallback(() => {
    const pointer = active.current;
    const client = lastClient.current;
    if (!pointer || !client || pointer.tool === handTool) return;
    pointer.tool.onPointerMove?.(
      toCanvasPointerEvent(
        { ...client, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false },
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

  const handlers: CanvasInput["handlers"] = {
    onPointerDown(event) {
      if (isIgnoredTarget(event.target) || active.current) return;
      // パネルの入力欄からフォーカスを外し、キーのショートカットが効くようにする
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
      lastClient.current = { clientX: event.clientX, clientY: event.clientY };
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
        lastClient.current = { clientX: event.clientX, clientY: event.clientY };
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

  return { handlers, spaceHeld, panning };
}
