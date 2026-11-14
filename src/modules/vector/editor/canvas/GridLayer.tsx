/** グリッド (§5.5)。文書の上に画面座標の SVG パターンで描く。条件は `grid.ts`。 */
import { useEditorStore } from "../state/store";
import { gridLevels, gridOffset } from "./grid";

export function GridLayer() {
  const viewport = useEditorStore((state) => state.viewport);
  const grid = useEditorStore((state) => state.view.grid);
  const gridSize = useEditorStore((state) => state.view.gridSize);
  const levels = gridLevels({ grid, gridSize }, viewport.zoom);
  if (levels.length === 0) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        {levels.map((level) => {
          const period = level.step * viewport.zoom;
          const ox = gridOffset(viewport.x, level.step, viewport.zoom);
          const oy = gridOffset(viewport.y, level.step, viewport.zoom);
          return (
            <pattern
              key={level.step}
              id={`canvas-grid-${level.step}`}
              patternUnits="userSpaceOnUse"
              width={period}
              height={period}
              x={ox}
              y={oy}
            >
              <path
                d={`M 0.5 0 V ${period} M 0 0.5 H ${period}`}
                stroke="var(--fg)"
                strokeOpacity={level.strong ? 0.16 : 0.07}
                strokeWidth={1}
                fill="none"
              />
            </pattern>
          );
        })}
      </defs>
      {levels.map((level) => (
        <rect
          key={level.step}
          width="100%"
          height="100%"
          fill={`url(#canvas-grid-${level.step})`}
        />
      ))}
    </svg>
  );
}
