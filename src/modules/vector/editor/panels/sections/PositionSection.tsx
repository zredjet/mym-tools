import { FlipHorizontal2, FlipVertical2, RotateCw } from "lucide-react";

import { IS_MAC } from "../../canvas/input";
import { CANVAS_LIMITS } from "../../model/limits";
import { canFlip, flipNodes, type FlipAxis } from "../../model/rotate";
import { editorStore, useEditorStore } from "../../state/store";
import { NumberField } from "../fields/NumberField";
import { FieldGrid, IconButton, Section } from "../fields/Section";
import { MIXED, type Mixed } from "../fields/values";
import { withinLimitsOrSame } from "../limits";
import { applyToSelection, memoBySelection } from "../selection";
import {
  readPosition,
  readRotation,
  setBoundsField,
  setLineField,
  setRotationField,
  type BoundsField,
  type LineField,
} from "./propertyOps";

const COORD = { min: -CANVAS_LIMITS.maxCoordinate, max: CANVAS_LIMITS.maxCoordinate };
const SIZE = { min: 0, max: CANVAS_LIMITS.maxSize };
/** 回転の欄の範囲。-180 より大きく 180 以下へそろえて当てるので、1 周分の外まで受け付ける (§4.11.5) */
const ROTATION = { min: -360, max: 360 };

const BOX_FIELDS: readonly { field: BoundsField; label: string; aria: string }[] = [
  { field: "x", label: "X", aria: "X 座標" },
  { field: "y", label: "Y", aria: "Y 座標" },
  { field: "width", label: "W", aria: "幅" },
  { field: "height", label: "H", aria: "高さ" },
];

const LINE_FIELDS: readonly { field: LineField; label: string; aria: string }[] = [
  { field: "x1", label: "X1", aria: "始点の X 座標" },
  { field: "y1", label: "Y1", aria: "始点の Y 座標" },
  { field: "x2", label: "X2", aria: "終点の X 座標" },
  { field: "y2", label: "Y2", aria: "終点の Y 座標" },
];

/** 表示する値を文字列にして比べる (group の子が動いたときも描き直すため、文書から求める)。 */
const positionKey = memoBySelection((doc, selection) =>
  JSON.stringify(readPosition(doc, selection)),
);

/** 回転の欄の値 (数値か「混在」、出さないなら null) を文字列にして比べる。 */
const rotationKey = memoBySelection((doc, selection) => {
  const value = readRotation(doc, selection);
  return value === null ? "" : String(value);
});

const flippable = memoBySelection(canFlip);

/** 反転する (左右・上下)。結果が §3.5 の範囲を超えるなら当てない。 */
function flip(axis: FlipAxis): void {
  applyToSelection((doc, selection) =>
    withinLimitsOrSame(doc, selection, flipNodes(doc, selection, axis)),
  );
}

/**
 * 位置と大きさの節 (§5.3)。X、Y、W、H (線は始点と終点)。group は外接矩形。
 * 値は親の座標系で、確定は整数に丸める (§4.6)。1 個の回転した箱を持つノードの X / Y / W / H は §4.11.5。
 * 箱を持つノードだけの選択には回転の欄 (度。全部同じならその値、違えば「混在」) を出す。
 * 見出しの右に左右反転・上下反転のボタン (反転できない選択では押せない。§4.11.6)。
 */
export function PositionSection() {
  const key = useEditorStore((s) => positionKey(s.doc, s.selection));
  const selection = useEditorStore((s) => s.selection);
  const apply = editorStore.getState().apply;
  const rotationText = useEditorStore((s) => rotationKey(s.doc, s.selection));
  const canFlipSelection = useEditorStore((s) => flippable(s.doc, s.selection));
  const position = JSON.parse(key) as ReturnType<typeof readPosition>;
  if (!position) return null;
  const rotation: number | Mixed | null =
    rotationText === "" ? null : rotationText === MIXED ? MIXED : Number(rotationText);
  const actions = (
    <>
      <IconButton
        label="左右反転"
        title={`左右反転 (${IS_MAC ? "⇧H" : "Shift+H"})`}
        disabled={!canFlipSelection}
        onClick={() => flip("horizontal")}
      >
        <FlipHorizontal2 size={14} />
      </IconButton>
      <IconButton
        label="上下反転"
        title={`上下反転 (${IS_MAC ? "⇧V" : "Shift+V"})`}
        disabled={!canFlipSelection}
        onClick={() => flip("vertical")}
      >
        <FlipVertical2 size={14} />
      </IconButton>
    </>
  );
  return (
    <Section title="位置と大きさ" actions={actions}>
      <FieldGrid>
        {position.mode === "line"
          ? LINE_FIELDS.map(({ field, label, aria }) => (
              <NumberField
                key={field}
                label={label}
                ariaLabel={aria}
                value={position.values[field]}
                {...COORD}
                targets={selection}
                onCommit={(value, targets) =>
                  apply((doc) => setLineField(doc, targets, field, value))
                }
              />
            ))
          : BOX_FIELDS.map(({ field, label, aria }) => (
              <NumberField
                key={field}
                label={label}
                ariaLabel={aria}
                value={position.values[field]}
                {...(field === "x" || field === "y" ? COORD : SIZE)}
                targets={selection}
                onCommit={(value, targets) =>
                  apply((doc) => setBoundsField(doc, targets, field, value))
                }
              />
            ))}
      </FieldGrid>
      {rotation !== null && (
        <FieldGrid>
          <NumberField
            label={<RotateCw size={13} />}
            ariaLabel="回転"
            suffix="°"
            precision={2}
            value={rotation}
            {...ROTATION}
            targets={selection}
            onCommit={(value, targets) =>
              apply((doc) =>
                withinLimitsOrSame(doc, targets, setRotationField(doc, targets, value)),
              )
            }
          />
        </FieldGrid>
      )}
    </Section>
  );
}
