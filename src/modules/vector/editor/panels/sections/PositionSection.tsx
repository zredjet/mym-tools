import { CANVAS_LIMITS } from "../../model/limits";
import { useEditorStore } from "../../state/store";
import { NumberField } from "../fields/NumberField";
import { FieldGrid, Section } from "../fields/Section";
import { applyToSelection, memoBySelection } from "../selection";
import {
  readPosition,
  setBoundsField,
  setLineField,
  type BoundsField,
  type LineField,
} from "./propertyOps";

const COORD = { min: -CANVAS_LIMITS.maxCoordinate, max: CANVAS_LIMITS.maxCoordinate };
const SIZE = { min: 0, max: CANVAS_LIMITS.maxSize };

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

/**
 * 位置と大きさの節 (§5.3)。X、Y、W、H (線は始点と終点)。group は外接矩形。
 * 値は親の座標系で、確定は整数に丸める (§4.6)。
 */
export function PositionSection() {
  const key = useEditorStore((s) => positionKey(s.doc, s.selection));
  const position = JSON.parse(key) as ReturnType<typeof readPosition>;
  if (!position) return null;
  return (
    <Section title="位置と大きさ">
      <FieldGrid>
        {position.mode === "line"
          ? LINE_FIELDS.map(({ field, label, aria }) => (
              <NumberField
                key={field}
                label={label}
                ariaLabel={aria}
                value={position.values[field]}
                {...COORD}
                onCommit={(value) =>
                  applyToSelection((doc, selection) => setLineField(doc, selection, field, value))
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
                onCommit={(value) =>
                  applyToSelection((doc, selection) => setBoundsField(doc, selection, field, value))
                }
              />
            ))}
      </FieldGrid>
    </Section>
  );
}
