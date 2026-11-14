/**
 * 上と左のルーラー。倍率に応じて目盛りの間隔を変え (`rulers.ts`)、選択範囲を帯で示す。
 * `view.rulers` が切のときは出さない。
 *
 * ルーラーの上のポインター操作はツールへ渡さない (`data-canvas-ignore`)。
 * ルーラーを押してキャンバスへ引き出すとガイド線を作る (上のルーラーは横、左のルーラーは縦)。
 * ルーラーの上で離すと作らない。ジェスチャー 1 回で履歴 1 件 (`tools/select/guideDrag.ts`)。
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/shallow";
import { getSelectionBounds } from "../model/geometry";
import type { Guide } from "../model/types";
import { editorStore, useEditorStore } from "../state/store";
import type { Viewport } from "../state/types";
import {
  beginNewGuide,
  endGuideDrag,
  isOverRuler,
  updateGuideDrag,
  type GuideDrag,
} from "../tools/select/guideDrag";
import { isEditableTarget } from "./input";
import { formatRulerValue, RULER_SIZE, rulerTicks } from "./rulerTicks";
import { screenToPage, type Size } from "./viewport";

/** 引き出している途中のガイド線。 */
interface PullState {
  pointerId: number;
  element: Element;
  guide: GuideDrag;
  /** ウィンドウとドキュメントに付けたリスナーを外す */
  detach: () => void;
}

/**
 * ルーラーを押して引き出すガイド線。上のルーラー (`x`) からは横のガイド線 (`y`)。
 * 自分で開いたジェスチャーは自分で閉じる (§4.4): 離したら確定、ポインターの取消・捕捉の喪失・
 * Esc・ウィンドウからのフォーカス喪失・アンマウント (途中で Shift+R など) では取り消す。
 */
function useGuidePull(rulerAxis: "x" | "y") {
  const guideAxis: Guide["axis"] = rulerAxis === "x" ? "y" : "x";
  const pull = useRef<PullState | null>(null);

  /** 引き出しを終える。`cancel` なら開いたジェスチャーを取り消す。 */
  const finish = useCallback((cancel: boolean) => {
    const current = pull.current;
    if (!current) return;
    pull.current = null;
    current.detach();
    if (current.element.hasPointerCapture?.(current.pointerId))
      current.element.releasePointerCapture(current.pointerId);
    if (cancel && editorStore.getState().gestureActive) editorStore.getState().cancelGesture();
  }, []);

  // アンマウントで取り消す (作りかけのガイド線とジェスチャーを残さない)
  useEffect(() => () => finish(true), [finish]);

  const locate = (event: ReactPointerEvent<Element>) => {
    const canvas = event.currentTarget.closest("[data-canvas-view]");
    const rect = canvas?.getBoundingClientRect();
    const screen = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    const state = editorStore.getState();
    return {
      page: screenToPage(state.viewport, screen),
      remove: isOverRuler(guideAxis, screen, state.view.rulers),
    };
  };

  const ownsEvent = (event: ReactPointerEvent<Element>) =>
    pull.current !== null && pull.current.pointerId === event.pointerId;

  return {
    onPointerDown(event: ReactPointerEvent<Element>) {
      if (event.button !== 0 || pull.current) return;
      // 入力欄の値を確定させ、キーをキャンバスが受けられるようにする
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && isEditableTarget(focused)) focused.blur();
      const canvas = event.currentTarget.closest<HTMLElement>("[data-canvas-view]");
      canvas?.focus({ preventScroll: true });
      const guide = beginNewGuide(editorStore, guideAxis);
      if (!guide) return;
      event.preventDefault();
      // Esc はキャンバスより先に受けて取り消す (キャンバスが選択の解除などに使わないように)。
      // 引き出しの間は、Esc のほかのキーもキャンバスのツールとショートカットへ渡さない (§4.4。
      // キャンバスは defaultPrevented のキーを無視する)
      const onKeyDown = (keyEvent: KeyboardEvent) => {
        keyEvent.preventDefault();
        if (keyEvent.key === "Escape") finish(true);
      };
      const onBlur = () => finish(true);
      const onVisibility = () => {
        if (document.visibilityState === "hidden") finish(true);
      };
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onVisibility);
      pull.current = {
        pointerId: event.pointerId,
        element: event.currentTarget,
        guide,
        detach: () => {
          window.removeEventListener("keydown", onKeyDown, true);
          window.removeEventListener("blur", onBlur);
          document.removeEventListener("visibilitychange", onVisibility);
        },
      };
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // 既に離れたポインターはキャプチャできない。追跡は続ける
      }
    },
    onPointerMove(event: ReactPointerEvent<Element>) {
      const current = pull.current;
      if (!current || !ownsEvent(event)) return;
      // Undo などでジェスチャーが閉じられたら、それ以上作らない
      if (!editorStore.getState().gestureActive) {
        finish(false);
        return;
      }
      const { page, remove } = locate(event);
      updateGuideDrag(editorStore, current.guide, page, remove);
    },
    onPointerUp(event: ReactPointerEvent<Element>) {
      const current = pull.current;
      if (!current || !ownsEvent(event)) return;
      const { page, remove } = locate(event);
      finish(false);
      endGuideDrag(editorStore, current.guide, page, remove);
    },
    onPointerCancel(event: ReactPointerEvent<Element>) {
      if (ownsEvent(event)) finish(true);
    },
    onLostPointerCapture(event: ReactPointerEvent<Element>) {
      // pointerup の後にも来るが、そのときは終えているので何もしない
      if (ownsEvent(event)) finish(true);
    },
  };
}

const LABEL_STYLE = { fontFamily: "var(--font-ui)", fontSize: 10 } as const;

interface RulerProps {
  axis: "x" | "y";
  viewport: Viewport;
  length: number;
  /** 選択範囲の始点と終点 (ページ座標) */
  highlight: readonly [number, number] | null;
}

function Ruler({ axis, viewport, length, highlight }: RulerProps) {
  const start = axis === "x" ? viewport.x : viewport.y;
  const { zoom } = viewport;
  // ルーラーの始点はキャンバスの左上の角を飛ばした位置 (RULER_SIZE) から
  const offset = RULER_SIZE;
  const ticks = rulerTicks(start + offset / zoom, zoom, Math.max(0, length - offset));
  const horizontal = axis === "x";
  const pull = useGuidePull(axis);
  const pos = (screen: number) => Math.round(screen + offset) + 0.5;
  const tickPath = (screen: number, tickLength: number) =>
    horizontal
      ? `M ${pos(screen)} ${RULER_SIZE} V ${RULER_SIZE - tickLength}`
      : `M ${RULER_SIZE} ${pos(screen)} H ${RULER_SIZE - tickLength}`;
  const band =
    highlight &&
    (() => {
      const from = (highlight[0] - start) * zoom;
      const to = (highlight[1] - start) * zoom;
      return horizontal
        ? { x: from, y: 0, width: Math.max(1, to - from), height: RULER_SIZE }
        : { x: 0, y: from, width: RULER_SIZE, height: Math.max(1, to - from) };
    })();

  return (
    <svg
      data-canvas-ignore=""
      data-canvas-ruler={axis}
      aria-hidden="true"
      className="absolute bg-[var(--bg)]"
      style={
        horizontal
          ? { left: 0, top: 0, width: length, height: RULER_SIZE, cursor: "ns-resize" }
          : { left: 0, top: 0, width: RULER_SIZE, height: length, cursor: "ew-resize" }
      }
      {...pull}
    >
      {band && <rect {...band} fill="var(--accent)" fillOpacity={0.15} />}
      <path
        d={[
          ...ticks.major.map((tick) => tickPath(tick.screen, 8)),
          ...ticks.minor.map((tick) => tickPath(tick.screen, 4)),
        ].join(" ")}
        stroke="var(--fg-subtle)"
        strokeWidth={1}
        fill="none"
      />
      {ticks.major.map((tick) =>
        horizontal ? (
          <text
            key={tick.value}
            x={pos(tick.screen) + 3}
            y={10}
            fill="var(--fg-muted)"
            style={LABEL_STYLE}
          >
            {formatRulerValue(tick.value)}
          </text>
        ) : (
          <text
            key={tick.value}
            x={0}
            y={0}
            transform={`translate(10 ${pos(tick.screen) - 3}) rotate(-90)`}
            fill="var(--fg-muted)"
            style={LABEL_STYLE}
          >
            {formatRulerValue(tick.value)}
          </text>
        ),
      )}
      <path
        d={
          horizontal ? `M 0 ${RULER_SIZE - 0.5} H ${length}` : `M ${RULER_SIZE - 0.5} 0 V ${length}`
        }
        stroke="var(--border)"
        strokeWidth={1}
      />
    </svg>
  );
}

export function Rulers({ size }: { size: Size }) {
  const viewport = useEditorStore((state) => state.viewport);
  const bounds = useEditorStore(
    useShallow((state) => {
      const rect = getSelectionBounds(state.doc, state.selection);
      return rect ? [rect.x, rect.y, rect.width, rect.height] : [];
    }),
  );
  const [bx, by, bw, bh] = bounds;
  const hasBounds = bx !== undefined && by !== undefined && bw !== undefined && bh !== undefined;
  return (
    <>
      <Ruler
        axis="x"
        viewport={viewport}
        length={size.width}
        highlight={hasBounds ? [bx, bx + bw] : null}
      />
      <Ruler
        axis="y"
        viewport={viewport}
        length={size.height}
        highlight={hasBounds ? [by, by + bh] : null}
      />
      <div
        data-canvas-ignore=""
        className="absolute top-0 left-0 border-r border-b border-[var(--border)] bg-[var(--bg)]"
        style={{ width: RULER_SIZE, height: RULER_SIZE }}
      />
    </>
  );
}
