import { Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";

import { CANVAS_LIMITS } from "../../model/limits";
import { mapNodes, updateNodes } from "../../model/transform";
import type { CanvasDocument, NodeId, Stroke, StrokeCap, StrokeJoin } from "../../model/types";
import { editorStore } from "../../state/store";
import { ColorField } from "../fields/ColorField";
import { DashField } from "../fields/DashField";
import { NumberField } from "../fields/NumberField";
import { FieldGrid, IconButton, Section, Segmented } from "../fields/Section";
import { commonValue, fromPercent, MIXED, PERCENT, toPercent } from "../fields/values";
import { DEFAULT_STROKE, type StrokeNode } from "./propertyOps";

function apply(recipe: (doc: CanvasDocument) => CanvasDocument) {
  editorStore.getState().apply(recipe);
}

const CAPS: readonly { value: StrokeCap; label: string }[] = [
  { value: "butt", label: "なし" },
  { value: "round", label: "丸" },
  { value: "square", label: "四角" },
];

const JOINS: readonly { value: StrokeJoin; label: string }[] = [
  { value: "miter", label: "マイター" },
  { value: "round", label: "丸" },
  { value: "bevel", label: "ベベル" },
];

const sameDash = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** 「混在」はどれも押していない表示 (null) にする。 */
function nonMixed<T>(value: T | typeof MIXED): T | null {
  return value === MIXED ? null : value;
}

/** 短い見出しと欄を 1 行に並べる (端・角・破線)。 */
function LabeledRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="w-7 shrink-0 text-[11px] text-[var(--fg-muted)]">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * 線の節 (§5.3、§8.11)。対象は線を持てるすべてのノード (frame・矩形・楕円・線・パス・ブーリアン)。
 * 色、不透明度、太さ、端 (なし・丸・四角)、角 (マイター・丸・ベベル)、破線 (数値をスペースかカンマで区切る。空は実線)。
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

  const patchStroke =
    (patch: Partial<Stroke>, targets: readonly NodeId[]) => (doc: CanvasDocument) =>
      mapNodes(doc, targets, (node) =>
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
              targets={withStroke}
              toRecipe={(color, targets) => patchStroke({ color }, targets)}
            />
            <NumberField
              label=""
              ariaLabel="線の不透明度"
              suffix="%"
              value={toPercent(commonValue(strokes.map((s) => s.opacity)))}
              {...PERCENT}
              targets={withStroke}
              onCommit={(value, targets) =>
                apply(patchStroke({ opacity: fromPercent(value) }, targets))
              }
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
              targets={withStroke}
              onCommit={(value, targets) => apply(patchStroke({ width: value }, targets))}
            />
          </FieldGrid>
          <LabeledRow label="端">
            <Segmented
              label="線の端"
              options={CAPS}
              value={nonMixed(commonValue(strokes.map((s) => s.cap)))}
              onChange={(cap) => apply(patchStroke({ cap }, withStroke))}
            />
          </LabeledRow>
          <LabeledRow label="角">
            <Segmented
              label="線の角"
              options={JOINS}
              value={nonMixed(commonValue(strokes.map((s) => s.join)))}
              onChange={(join) => apply(patchStroke({ join }, withStroke))}
            />
          </LabeledRow>
          <LabeledRow label="破線">
            <DashField
              ariaLabel="破線"
              value={commonValue(
                strokes.map((s) => s.dash),
                sameDash,
              )}
              targets={withStroke}
              onCommit={(dash, targets) => apply(patchStroke({ dash }, targets))}
            />
          </LabeledRow>
        </>
      ) : undefined}
    </Section>
  );
}
