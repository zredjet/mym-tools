/**
 * 上と左のルーラー。倍率に応じて目盛りの間隔を変え (`rulers.ts`)、選択範囲を帯で示す。
 * `view.rulers` が切のときは出さない。
 *
 * ルーラーの上のポインター操作はツールへ渡さない (`data-canvas-ignore`)。
 * ガイド線の引き出しは「選択と変形」のセッションがここに足す。
 */
import { useShallow } from "zustand/shallow";
import { getSelectionBounds } from "../model/geometry";
import { useEditorStore } from "../state/store";
import type { Viewport } from "../state/types";
import { formatRulerValue, RULER_SIZE, rulerTicks } from "./rulerTicks";
import type { Size } from "./viewport";

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
          ? { left: 0, top: 0, width: length, height: RULER_SIZE }
          : { left: 0, top: 0, width: RULER_SIZE, height: length }
      }
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
