import { Minus, Plus } from "lucide-react";

import { CANVAS_LIMITS } from "../../model/limits";
import { mapNodes, updateNodes } from "../../model/transform";
import type { CanvasDocument, Stroke } from "../../model/types";
import { editorStore } from "../../state/store";
import { ColorField } from "../fields/ColorField";
import { NumberField } from "../fields/NumberField";
import { FieldGrid, IconButton, Section } from "../fields/Section";
import { commonValue, fromPercent, PERCENT, toPercent } from "../fields/values";
import { DEFAULT_STROKE, type StrokeNode } from "./propertyOps";

function apply(recipe: (doc: CanvasDocument) => CanvasDocument) {
  editorStore.getState().apply(recipe);
}

/**
 * 線の節 (§5.3)。対象は frame・矩形・楕円・線。色、不透明度、太さ。
 * 「線なし」(stroke を null にする) は線のノードには出さない。線のノードと一緒に選んでいるときは、
 * 線のノードを対象から外して当てる (§4.6)。
 */
export function StrokeSection({ nodes }: { nodes: readonly StrokeNode[] }) {
  const strokes = nodes.map((node) => node.stroke).filter((s): s is Stroke => s !== null);
  const withStroke = nodes.filter((node) => node.stroke !== null).map((node) => node.id);
  const withoutStroke = nodes.filter((node) => node.stroke === null).map((node) => node.id);
  const removable = nodes
    .filter((node) => node.type !== "line" && node.stroke !== null)
    .map((node) => node.id);

  const patchStroke = (patch: Partial<Stroke>) => (doc: CanvasDocument) =>
    mapNodes(doc, withStroke, (node) =>
      "stroke" in node && node.stroke ? { stroke: { ...node.stroke, ...patch } } : null,
    );

  const actions = (
    <>
      {withoutStroke.length > 0 && (
        <IconButton
          label="線を追加"
          onClick={() =>
            apply((doc) => updateNodes(doc, withoutStroke, { stroke: { ...DEFAULT_STROKE } }))
          }
        >
          <Plus size={14} />
        </IconButton>
      )}
      {removable.length > 0 && (
        <IconButton
          label="線なし"
          onClick={() => apply((doc) => updateNodes(doc, removable, { stroke: null }))}
        >
          <Minus size={14} />
        </IconButton>
      )}
    </>
  );

  return (
    <Section title="線" actions={actions}>
      {strokes.length > 0 ? (
        <>
          <FieldGrid>
            <ColorField
              ariaLabel="線の色"
              value={commonValue(strokes.map((s) => s.color.toUpperCase()))}
              toRecipe={(color) => patchStroke({ color })}
            />
            <NumberField
              label=""
              ariaLabel="線の不透明度"
              suffix="%"
              value={toPercent(commonValue(strokes.map((s) => s.opacity)))}
              {...PERCENT}
              onCommit={(value) => apply(patchStroke({ opacity: fromPercent(value) }))}
            />
          </FieldGrid>
          <FieldGrid>
            <NumberField
              label="太さ"
              ariaLabel="線の太さ"
              precision={2}
              value={commonValue(strokes.map((s) => s.width))}
              min={0}
              minExclusive
              max={CANVAS_LIMITS.maxStrokeWidth}
              onCommit={(value) => apply(patchStroke({ width: value }))}
            />
          </FieldGrid>
        </>
      ) : undefined}
    </Section>
  );
}
