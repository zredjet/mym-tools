import { useSyncExternalStore } from "react";
import { OVERLAY_COLORS, OVERLAY_LINE } from "../canvas/overlayKit";
import { rectFromPoints } from "../model/geometry";
import { getTextToolDrag, subscribeTextToolDrag } from "./creation";

/** テキストツールでドラッグ中の矩形 (ページ座標)。幅がテキストの幅になる。 */
export function TextToolOverlay() {
  const drag = useSyncExternalStore(subscribeTextToolDrag, getTextToolDrag, getTextToolDrag);
  if (!drag?.dragged) return null;
  const rect = rectFromPoints(drag.start, drag.current);
  return (
    <rect
      data-text-tool-preview=""
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      stroke={OVERLAY_COLORS.selection}
      {...OVERLAY_LINE}
    />
  );
}
