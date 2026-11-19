import { updateNodes } from "../../model/transform";
import type { FillRule, PathNode } from "../../model/types";
import { editorStore } from "../../state/store";
import { Section, Segmented } from "../fields/Section";
import { commonValue, MIXED } from "../fields/values";

const FILL_RULES: readonly { value: FillRule; label: string }[] = [
  { value: "nonzero", label: "ノンゼロ" },
  { value: "evenodd", label: "偶奇" },
];

/**
 * パスの節 (§5.3)。塗りの規則 (`nonzero` / `evenodd`)。対象は選択の中のパス。
 * 複数で違えばどちらも押していない表示にする。
 */
export function PathSection({ paths }: { paths: readonly PathNode[] }) {
  const value = commonValue(paths.map((path) => path.fillRule));
  const ids = paths.map((path) => path.id);
  return (
    <Section title="パス">
      <Segmented
        label="塗りの規則"
        options={FILL_RULES}
        value={value === MIXED ? null : value}
        onChange={(fillRule) =>
          editorStore.getState().apply((doc) => updateNodes(doc, ids, { fillRule }))
        }
      />
    </Section>
  );
}
