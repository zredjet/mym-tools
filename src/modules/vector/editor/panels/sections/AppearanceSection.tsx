import { Blend, SquareRoundCorner } from "lucide-react";

import { CANVAS_LIMITS } from "../../model/limits";
import { updateNodes } from "../../model/transform";
import type { CanvasNode } from "../../model/types";
import { editorStore } from "../../state/store";
import { NumberField } from "../fields/NumberField";
import { FieldGrid, Section } from "../fields/Section";
import { commonValue, fromPercent, PERCENT, toPercent } from "../fields/values";
import { hasRadius } from "./propertyOps";

/**
 * 見た目の節 (§5.3)。不透明度と、角丸 (frame・矩形・画像)。
 */
export function AppearanceSection({ nodes }: { nodes: readonly CanvasNode[] }) {
  const ids = nodes.map((node) => node.id);
  const rounded = nodes.filter(hasRadius);
  const radiusIds = rounded.map((node) => node.id);
  const apply = editorStore.getState().apply;
  return (
    <Section title="見た目">
      <FieldGrid>
        <NumberField
          label={<Blend size={13} />}
          ariaLabel="不透明度"
          suffix="%"
          value={toPercent(commonValue(nodes.map((node) => node.opacity)))}
          {...PERCENT}
          targets={ids}
          onCommit={(value, targets) =>
            apply((doc) => updateNodes(doc, targets, { opacity: fromPercent(value) }))
          }
        />
        {rounded.length > 0 && (
          <NumberField
            label={<SquareRoundCorner size={13} />}
            ariaLabel="角丸"
            precision={2}
            value={commonValue(rounded.map((node) => node.radius))}
            min={0}
            max={CANVAS_LIMITS.maxRadius}
            targets={radiusIds}
            onCommit={(value, targets) =>
              apply((doc) => updateNodes(doc, targets, { radius: value }))
            }
          />
        )}
      </FieldGrid>
    </Section>
  );
}
