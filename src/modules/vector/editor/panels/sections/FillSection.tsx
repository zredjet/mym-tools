import { Plus, X } from "lucide-react";
import { useRef } from "react";

import { CANVAS_LIMITS } from "../../model/limits";
import { jsonEqual, mapNodes } from "../../model/transform";
import type { CanvasDocument, GradientStop, NodeId, Paint } from "../../model/types";
import { editorStore } from "../../state/store";
import { ColorField } from "../fields/ColorField";
import { NumberField } from "../fields/NumberField";
import { FieldGrid, IconButton, Section, Segmented } from "../fields/Section";
import { commonValue, fromPercent, MIXED, PERCENT, toPercent } from "../fields/values";
import {
  addGradientStop,
  patchGradient,
  patchStop,
  type Gradient,
  convertPaint,
  linearAngle,
  MAX_GRADIENT_COORD,
  PAINT_KIND_LABELS,
  paintKind,
  removeGradientStop,
  withLinearAngle,
  withRadial,
  type PaintKind,
} from "./paint";
import type { FillNode } from "./propertyOps";

const KIND_OPTIONS = (["none", "solid", "linear", "radial"] as const).map((value) => ({
  value,
  label: PAINT_KIND_LABELS[value],
}));

/** 正規化した座標 (0〜1) を % で出す欄の範囲。 */
const GRADIENT_COORD = { min: -MAX_GRADIENT_COORD * 100, max: MAX_GRADIENT_COORD * 100 };

function apply(recipe: (doc: CanvasDocument) => CanvasDocument) {
  editorStore.getState().apply(recipe);
}

/**
 * 塗りの節 (§5.3)。対象は frame・矩形・楕円・テキスト。
 * 種類 (なし / 単色 / 線形 / 円形) を切り替え、単色は色と不透明度、グラデーションは停止点と向きを編集する。
 * 複数選択で塗りが違うときは「混在」と出し、種類の切替と単色の各欄はそれぞれのノードに当てる。
 */
export function FillSection({ nodes }: { nodes: readonly FillNode[] }) {
  const ids = nodes.map((node) => node.id);
  const fills = nodes.map((node) => node.fill);
  const kind = commonValue(fills.map(paintKind));
  const fill = commonValue(fills, jsonEqual);

  const setKind = (next: PaintKind) =>
    apply((doc) =>
      mapNodes(doc, ids, (node) =>
        "fill" in node ? { fill: convertPaint(node.fill, next) } : null,
      ),
    );

  return (
    <Section title="塗り">
      <Segmented
        label="塗りの種類"
        options={KIND_OPTIONS}
        value={kind === MIXED ? null : kind}
        onChange={setKind}
      />
      {kind === MIXED && <p className="text-[12px] text-[var(--fg-muted)]">混在</p>}
      {kind === "solid" && <SolidFields ids={ids} fills={fills} />}
      {(kind === "linear" || kind === "radial") &&
        (fill === MIXED || fill === null || fill.type === "solid" ? (
          <p className="text-[12px] text-[var(--fg-muted)]">グラデーションが混在しています</p>
        ) : (
          <GradientFields ids={ids} paint={fill} />
        ))}
    </Section>
  );
}

/** 単色の色と不透明度。欄ごとに「混在」を出し、入力した欄だけをそれぞれのノードに当てる。 */
function SolidFields({ ids, fills }: { ids: NodeId[]; fills: (Paint | null)[] }) {
  const solids = fills.filter((paint) => paint?.type === "solid");
  const patchSolid =
    (patch: { color?: string; opacity?: number }, targets: readonly NodeId[]) =>
    (doc: CanvasDocument) =>
      mapNodes(doc, targets, (node) =>
        "fill" in node && node.fill?.type === "solid" ? { fill: { ...node.fill, ...patch } } : null,
      );
  return (
    <FieldGrid>
      <ColorField
        ariaLabel="塗りの色"
        value={commonValue(solids.map((paint) => paint.color.toUpperCase()))}
        targets={ids}
        toRecipe={(color, targets) => patchSolid({ color }, targets)}
      />
      <NumberField
        label=""
        ariaLabel="塗りの不透明度"
        suffix="%"
        value={toPercent(commonValue(solids.map((paint) => paint.opacity)))}
        {...PERCENT}
        targets={ids}
        onCommit={(value, targets) => apply(patchSolid({ opacity: fromPercent(value) }, targets))}
      />
    </FieldGrid>
  );
}

/** CSS のグラデーションで停止点の並びを見せる。 */
function stopsPreview(stops: readonly GradientStop[]): string {
  const parts = stops.map((stop) => {
    const alpha = Math.round(stop.opacity * 255)
      .toString(16)
      .padStart(2, "0");
    return `${stop.color}${alpha} ${stop.offset * 100}%`;
  });
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** グラデーションの停止点と向き。選んだノードの塗りがすべて同じときだけ出す。 */
function GradientFields({ ids, paint }: { ids: NodeId[]; paint: Gradient }) {
  const canAdd = paint.stops.length < CANVAS_LIMITS.maxGradientStops;
  const canRemove = paint.stops.length > CANVAS_LIMITS.minGradientStops;
  /**
   * 削除ボタンを押し始めた時点の停止点。位置の欄に打ったまま削除を押すと、先に位置が確定して
   * 並びが変わる。押し始めた時点と同じ停止点がその位置になければ消さない (別の停止点を消さない)
   */
  const pressed = useRef<{ index: number; stop: GradientStop } | null>(null);

  const remove = (index: number, stop: GradientStop) => {
    const expected = pressed.current?.index === index ? pressed.current.stop : stop;
    pressed.current = null;
    apply(
      patchGradient(ids, (current) => {
        if (!jsonEqual(current.stops[index], expected)) return null;
        const stops = removeGradientStop(current.stops, index);
        return stops ? { ...current, stops } : null;
      }),
    );
  };

  return (
    <>
      <div
        aria-hidden="true"
        className="h-3 rounded-[var(--radius-sm)] border border-[var(--border)]"
        style={{ backgroundImage: stopsPreview(paint.stops) }}
      />
      <div className="flex h-6 items-center justify-between">
        <span className="text-[11px] text-[var(--fg-muted)]">停止点</span>
        <IconButton
          label="停止点を追加"
          disabled={!canAdd}
          onClick={() =>
            apply(
              patchGradient(ids, (current) => {
                const stops = addGradientStop(current.stops);
                return stops ? { ...current, stops } : null;
              }),
            )
          }
        >
          <Plus size={14} />
        </IconButton>
      </div>
      <div
        aria-hidden="true"
        className="grid grid-cols-[40px_minmax(0,1fr)_40px_20px] gap-1 text-[10px] whitespace-nowrap text-[var(--fg-subtle)]"
      >
        <span>位置 %</span>
        <span>色</span>
        <span>不透明度 %</span>
      </div>
      <ul className="flex flex-col gap-1" aria-label="停止点">
        {paint.stops.map((stop, index) => (
          <li
            // 停止点は ID を持たないので位置で区別する。確定は位置で対象の停止点を引き直す
            key={index}
            className="grid grid-cols-[40px_minmax(0,1fr)_40px_20px] items-center gap-1"
          >
            <NumberField
              label=""
              ariaLabel={`停止点 ${index + 1} の位置`}
              precision={1}
              value={stop.offset * 100}
              {...PERCENT}
              targets={ids}
              onCommit={(value, targets) =>
                apply(patchGradient(targets, patchStop(index, { offset: fromPercent(value) })))
              }
            />
            <ColorField
              ariaLabel={`停止点 ${index + 1} の色`}
              value={stop.color.toUpperCase()}
              targets={ids}
              toRecipe={(color, targets) => patchGradient(targets, patchStop(index, { color }))}
            />
            <NumberField
              label=""
              ariaLabel={`停止点 ${index + 1} の不透明度`}
              value={toPercent(stop.opacity)}
              {...PERCENT}
              targets={ids}
              onCommit={(value, targets) =>
                apply(patchGradient(targets, patchStop(index, { opacity: fromPercent(value) })))
              }
            />
            <span onPointerDown={() => (pressed.current = { index, stop })}>
              <IconButton
                compact
                label={`停止点 ${index + 1} を削除`}
                disabled={!canRemove}
                onClick={() => remove(index, stop)}
              >
                <X size={14} />
              </IconButton>
            </span>
          </li>
        ))}
      </ul>
      {paint.type === "linear" ? (
        <FieldGrid>
          <NumberField
            label="角度"
            ariaLabel="グラデーションの向き"
            suffix="°"
            precision={1}
            value={linearAngle(paint)}
            min={-360}
            max={360}
            targets={ids}
            onCommit={(value, targets) =>
              apply(
                patchGradient(targets, (current) =>
                  current.type === "linear" ? withLinearAngle(current, value) : null,
                ),
              )
            }
          />
        </FieldGrid>
      ) : (
        <FieldGrid>
          <NumberField
            label="中心 X"
            ariaLabel="グラデーションの中心の X (%)"
            suffix="%"
            precision={1}
            value={paint.center.x * 100}
            {...GRADIENT_COORD}
            targets={ids}
            onCommit={(value, targets) =>
              apply(
                patchGradient(targets, (current) =>
                  current.type === "radial"
                    ? withRadial(current, { center: { ...current.center, x: fromPercent(value) } })
                    : null,
                ),
              )
            }
          />
          <NumberField
            label="中心 Y"
            ariaLabel="グラデーションの中心の Y (%)"
            suffix="%"
            precision={1}
            value={paint.center.y * 100}
            {...GRADIENT_COORD}
            targets={ids}
            onCommit={(value, targets) =>
              apply(
                patchGradient(targets, (current) =>
                  current.type === "radial"
                    ? withRadial(current, { center: { ...current.center, y: fromPercent(value) } })
                    : null,
                ),
              )
            }
          />
          <NumberField
            label="半径"
            ariaLabel="グラデーションの半径 (%)"
            suffix="%"
            precision={1}
            value={paint.radius * 100}
            min={0}
            minExclusive
            max={MAX_GRADIENT_COORD * 100}
            targets={ids}
            onCommit={(value, targets) =>
              apply(
                patchGradient(targets, (current) =>
                  current.type === "radial"
                    ? withRadial(current, { radius: fromPercent(value) })
                    : null,
                ),
              )
            }
          />
        </FieldGrid>
      )}
    </>
  );
}
