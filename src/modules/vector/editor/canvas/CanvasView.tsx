/**
 * キャンバス本体 (§4.3 / §4.4 / §5.5)。下から順に次の層を重ねる。
 *
 * 1. 文書の SVG (`DocumentLayer`): ページ座標の `<g>` を表示位置と倍率で画面へ写す。画面外のページ直下のノードは描かない
 * 2. グリッド (`GridLayer`)
 * 3. 重ね描きの SVG (`OverlayLayer`): ガイド線、frame のラベル、`SelectionOverlay`、現在のツールの `Overlay`
 * 4. HTML の層: 本文の編集欄 (`TextEditOverlay`)。ここのポインター操作はツールへ渡さない
 * 5. ルーラー (`Rulers`)
 *
 * 入力は `useCanvasInput` が受け持つ。キャンバスの大きさは `setCanvasViewSize` で表示の操作に知らせる。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { canvasTextMeasurer } from "../render/measureText";
import { editorStore, useEditorStore } from "../state/store";
import { TextEditOverlay } from "../text/TextEditOverlay";
import { TOOLS } from "../tools/registry";
import { PageLayer } from "./DocumentLayer";
import { GridLayer } from "./GridLayer";
import { OverlayLayer } from "./OverlayLayer";
import { Rulers } from "./Rulers";
import { CANVAS_IGNORE_ATTR, useCanvasInput } from "./useCanvasInput";
import { setCanvasViewSize, zoomToFit } from "./viewCommands";
import { viewportTransform, type Size } from "./viewport";

/**
 * キャンバスの地 (§5.1)。ライトでは `--bg` より一段暗い `--bg-muted`。
 * ダークの `--bg` はほぼ黒でそれより暗い面がないので、同じ `--bg-muted` (パネルより一段明るい) を使う。
 */
const CANVAS_BACKGROUND = "var(--bg-muted)";

function isDefaultViewport() {
  const { x, y, zoom } = editorStore.getState().viewport;
  return x === 0 && y === 0 && zoom === 1;
}

export function CanvasView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const fittedOnce = useRef(false);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setCanvasViewSize(next);
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 開いたとき、表示位置が既定のままなら内容が収まるように表示する (100% まで)
  useEffect(() => {
    if (fittedOnce.current || size.width <= 0 || size.height <= 0) return;
    fittedOnce.current = true;
    if (isDefaultViewport())
      zoomToFit({ store: editorStore, size, measurer: canvasTextMeasurer }, 1);
  }, [size]);

  const { handlers, spaceHeld, panning } = useCanvasInput({
    store: editorStore,
    measurer: canvasTextMeasurer,
    containerRef,
    size,
  });

  const viewport = useEditorStore((state) => state.viewport);
  const rulers = useEditorStore((state) => state.view.rulers);
  const toolId = useEditorStore((state) => state.toolId);
  const cursor = panning ? "grabbing" : spaceHeld ? "grab" : TOOLS[toolId].cursor;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-canvas-view=""
      className="absolute inset-0 overflow-hidden outline-none select-none"
      style={{ background: CANVAS_BACKGROUND, cursor, touchAction: "none" }}
      onContextMenu={(event) => event.preventDefault()}
      {...handlers}
    >
      <svg className="absolute inset-0 h-full w-full" data-canvas-document="">
        <g transform={viewportTransform(viewport)}>
          <PageLayer size={size} />
        </g>
      </svg>
      <GridLayer />
      <OverlayLayer size={size} />
      <div
        {...{ [CANVAS_IGNORE_ATTR]: "" }}
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <TextEditOverlay />
      </div>
      {rulers && <Rulers size={size} />}
    </div>
  );
}
