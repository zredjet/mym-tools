/**
 * 上と左のルーラー。倍率に応じて目盛りの間隔を変え (`rulers.ts`)、選択範囲を帯で示す。
 * `view.rulers` が切のときは出さない。
 *
 * ルーラーの上のポインター操作はツールへ渡さない (`data-canvas-ignore`)。
 * ルーラーを押してキャンバスへ引き出すとガイド線を作る (上のルーラーは横、左のルーラーは縦)。
 * ルーラーの上で離すと作らない。ジェスチャー 1 回で履歴 1 件 (`tools/select/guideDrag.ts`)。
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
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

/** ルーラーを押して引き出すガイド線。上のルーラー (`x`) からは横のガイド線 (`y`)。 */
function useGuidePull(rulerAxis: "x" | "y") {
  const guideAxis: Guide["axis"] = rulerAxis === "x" ? "y" : "x";
  const drag = useRef<{ id: number; guide: GuideDrag } | null>(null);

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

  const release = (event: ReactPointerEvent<Element>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return {
    onPointerDown(event: ReactPointerEvent<Element>) {
      if (event.button !== 0 || drag.current) return;
      // 入力欄の値を確定させ、キーを (Esc での取消を含め) キャンバスが受けられるようにする
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && isEditableTarget(focused)) focused.blur();
      const canvas = event.currentTarget.closest<HTMLElement>("[data-canvas-view]");
      canvas?.focus({ preventScroll: true });
      const guide = beginNewGuide(editorStore, guideAxis);
      if (!guide) return;
      event.preventDefault();
      drag.current = { id: event.pointerId, guide };
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // 既に離れたポインターはキャプチャできない。追跡は続ける
      }
    },
    onPointerMove(event: ReactPointerEvent<Element>) {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      // Esc やフォーカス喪失でジェスチャーが取り消されたら、それ以上作らない
      if (!editorStore.getState().gestureActive) {
        drag.current = null;
        release(event);
        return;
      }
      const { page, remove } = locate(event);
      updateGuideDrag(editorStore, current.guide, page, remove);
    },
    onPointerUp(event: ReactPointerEvent<Element>) {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      drag.current = null;
      release(event);
      const { page, remove } = locate(event);
      endGuideDrag(editorStore, current.guide, page, remove);
    },
    onPointerCancel(event: ReactPointerEvent<Element>) {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      drag.current = null;
      if (editorStore.getState().gestureActive) editorStore.getState().cancelGesture();
    },
    onLostPointerCapture(event: ReactPointerEvent<Element>) {
      // pointerup の後にも来るが、そのときは drag が空なので何もしない
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      drag.current = null;
      if (editorStore.getState().gestureActive) editorStore.getState().cancelGesture();
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
