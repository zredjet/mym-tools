import { useShallow } from "zustand/react/shallow";

import { editorStore, useEditorStore } from "../../state/store";
import { NumberField } from "../fields/NumberField";
import { CheckboxField, FieldGrid, Section } from "../fields/Section";

/** グリッドの間隔 (px) の範囲。 */
const GRID_SIZE_RANGE = { min: 1, max: 1000 };

/**
 * 何も選んでいないときのページの設定 (§5.3)。ルーラー、グリッド、グリッドの間隔、グリッドへのスナップ。
 * 表示の設定は文書に保存しない (§5.5) ので、履歴にも積まない。
 */
export function PageSection() {
  const view = useEditorStore(
    useShallow((s) => ({
      rulers: s.view.rulers,
      grid: s.view.grid,
      gridSize: s.view.gridSize,
      snapToGrid: s.view.snapToGrid,
    })),
  );
  const setView = editorStore.getState().setView;
  return (
    <Section title="ページ">
      <CheckboxField
        label="ルーラー"
        checked={view.rulers}
        onChange={(rulers) => setView({ rulers })}
      />
      <CheckboxField label="グリッド" checked={view.grid} onChange={(grid) => setView({ grid })} />
      <FieldGrid>
        <NumberField
          label="間隔"
          ariaLabel="グリッドの間隔"
          suffix="px"
          value={view.gridSize}
          {...GRID_SIZE_RANGE}
          onCommit={(gridSize) => setView({ gridSize })}
        />
      </FieldGrid>
      <CheckboxField
        label="グリッドにスナップ"
        checked={view.snapToGrid}
        onChange={(snapToGrid) => setView({ snapToGrid })}
      />
    </Section>
  );
}
