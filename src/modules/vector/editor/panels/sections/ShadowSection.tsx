import { CANVAS_LIMITS } from "../../model/limits";
import { mapNodes, updateNodes } from "../../model/transform";
import type { CanvasDocument, NodeId, Shadow } from "../../model/types";
import { editorStore } from "../../state/store";
import { ColorField } from "../fields/ColorField";
import { NumberField } from "../fields/NumberField";
import { CheckboxField, FieldGrid, Section } from "../fields/Section";
import { commonValue, fromPercent, PERCENT, toPercent } from "../fields/values";
import { DEFAULT_SHADOW, type ShadowNode } from "./propertyOps";

const OFFSET = { min: -CANVAS_LIMITS.maxShadowOffset, max: CANVAS_LIMITS.maxShadowOffset };

function apply(recipe: (doc: CanvasDocument) => CanvasDocument) {
  editorStore.getState().apply(recipe);
}

/**
 * 影の節 (§5.3)。対象は frame・矩形・楕円・テキスト・画像。
 * 入切と、X、Y、ぼかし、色、不透明度。欄の変更は影のあるノードだけに当てる。
 */
export function ShadowSection({ nodes }: { nodes: readonly ShadowNode[] }) {
  const shadows = nodes.map((node) => node.shadow).filter((s): s is Shadow => s !== null);
  const on = commonValue(nodes.map((node) => node.shadow !== null));
  const withShadow = nodes.filter((node) => node.shadow !== null).map((node) => node.id);
  const withoutShadow = nodes.filter((node) => node.shadow === null).map((node) => node.id);

  const patchShadow =
    (patch: Partial<Shadow>, targets: readonly NodeId[]) => (doc: CanvasDocument) =>
      mapNodes(doc, targets, (node) =>
        "shadow" in node && node.shadow ? { shadow: { ...node.shadow, ...patch } } : null,
      );

  const toggle = (checked: boolean) =>
    apply((doc) =>
      checked
        ? updateNodes(doc, withoutShadow, { shadow: { ...DEFAULT_SHADOW } })
        : updateNodes(doc, withShadow, { shadow: null }),
    );

  return (
    <Section title="影">
      <CheckboxField label="ドロップシャドウ" checked={on} onChange={toggle} />
      {shadows.length > 0 && (
        <>
          <FieldGrid>
            <NumberField
              label="X"
              ariaLabel="影の X"
              precision={2}
              value={commonValue(shadows.map((s) => s.x))}
              {...OFFSET}
              targets={withShadow}
              onCommit={(value, targets) => apply(patchShadow({ x: value }, targets))}
            />
            <NumberField
              label="Y"
              ariaLabel="影の Y"
              precision={2}
              value={commonValue(shadows.map((s) => s.y))}
              {...OFFSET}
              targets={withShadow}
              onCommit={(value, targets) => apply(patchShadow({ y: value }, targets))}
            />
            <NumberField
              label="ぼかし"
              ariaLabel="影のぼかし"
              precision={2}
              value={commonValue(shadows.map((s) => s.blur))}
              min={0}
              max={CANVAS_LIMITS.maxShadowBlur}
              targets={withShadow}
              onCommit={(value, targets) => apply(patchShadow({ blur: value }, targets))}
            />
          </FieldGrid>
          <FieldGrid>
            <ColorField
              ariaLabel="影の色"
              value={commonValue(shadows.map((s) => s.color.toUpperCase()))}
              targets={withShadow}
              toRecipe={(color, targets) => patchShadow({ color }, targets)}
            />
            <NumberField
              label=""
              ariaLabel="影の不透明度"
              suffix="%"
              value={toPercent(commonValue(shadows.map((s) => s.opacity)))}
              {...PERCENT}
              targets={withShadow}
              onCommit={(value, targets) =>
                apply(patchShadow({ opacity: fromPercent(value) }, targets))
              }
            />
          </FieldGrid>
        </>
      )}
    </Section>
  );
}
