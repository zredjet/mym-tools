/**
 * 重ね描き用の SVG。文書の SVG とは別の層で、書き出しには含まれない (§4.3)。
 *
 * - 画面座標: ページのガイド線、ページ直下の frame の名前のラベル
 * - ページ座標の `<g>`: `SelectionOverlay` (どのツールでも) と現在のツールの `Overlay`。
 *   線の太さは `overlayKit.ts` の `OVERLAY_LINE` で倍率に関係なく一定にする
 */
import { useState } from "react";
import { useShallow } from "zustand/shallow";
import { getPage } from "../model/tree";
import type { Guide } from "../model/types";
import { useEditorStore } from "../state/store";
import type { Viewport } from "../state/types";
import { SelectionOverlay } from "../tools/select/SelectionOverlay";
import { TOOLS } from "../tools/registry";
import { FRAME_LABEL_FONT, FRAME_LABEL_GAP } from "./frameLabels";
import { OVERLAY_COLORS } from "./overlayKit";
import { createFrameLabelsSelector } from "./selectors";
import { pageRectToScreen, viewportTransform, type Size } from "./viewport";

const EMPTY_GUIDES: readonly Guide[] = [];

function Guides({ viewport, size }: { viewport: Viewport; size: Size }) {
  const guides = useEditorStore(
    (state) => getPage(state.doc, state.pageId)?.guides ?? EMPTY_GUIDES,
  );
  if (guides.length === 0) return null;
  const d = guides
    .map((guide) => {
      if (guide.axis === "x") {
        const x = Math.round((guide.position - viewport.x) * viewport.zoom) + 0.5;
        return x < 0 || x > size.width ? "" : `M ${x} 0 V ${size.height}`;
      }
      const y = Math.round((guide.position - viewport.y) * viewport.zoom) + 0.5;
      return y < 0 || y > size.height ? "" : `M 0 ${y} H ${size.width}`;
    })
    .join(" ");
  return (
    <path d={d} stroke={OVERLAY_COLORS.guide} strokeWidth={1} fill="none" data-canvas-guides="" />
  );
}

function FrameLabels({ viewport, size }: { viewport: Viewport; size: Size }) {
  const [selectLabels] = useState(createFrameLabelsSelector);
  const labels = useEditorStore((state) => selectLabels(state, size));
  const highlighted = useEditorStore(
    useShallow((state) => [...state.selection, ...(state.hoveredId ? [state.hoveredId] : [])]),
  );
  return (
    <g data-canvas-frame-labels="">
      {labels.map((label) => {
        const rect = pageRectToScreen(viewport, label.rect);
        return (
          <text
            key={label.id}
            x={rect.x}
            y={rect.y + rect.height - FRAME_LABEL_GAP - 1}
            fill={highlighted.includes(label.id) ? OVERLAY_COLORS.selection : OVERLAY_COLORS.label}
            style={{
              fontFamily: FRAME_LABEL_FONT.family,
              fontSize: FRAME_LABEL_FONT.size,
              fontWeight: FRAME_LABEL_FONT.weight,
            }}
          >
            {label.text}
          </text>
        );
      })}
    </g>
  );
}

function ToolOverlay() {
  const toolId = useEditorStore((state) => state.toolId);
  const Overlay = TOOLS[toolId].Overlay;
  return Overlay ? <Overlay /> : null;
}

export function OverlayLayer({ size }: { size: Size }) {
  const viewport = useEditorStore((state) => state.viewport);
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      <Guides viewport={viewport} size={size} />
      <FrameLabels viewport={viewport} size={size} />
      <g transform={viewportTransform(viewport)}>
        <SelectionOverlay />
        <ToolOverlay />
      </g>
    </svg>
  );
}
