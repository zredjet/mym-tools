import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  type LucideIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import {
  alignNodes,
  canAlign,
  canDistribute,
  distributeNodes,
  type AlignKind,
  type DistributeAxis,
} from "../../model/align";
import { useEditorStore } from "../../state/store";
import { IconButton, Section } from "../fields/Section";
import { withinLimitsOrSame } from "../limits";
import { applyToSelection, memoBySelection } from "../selection";

const ALIGN_BUTTONS: readonly { kind: AlignKind; label: string; icon: LucideIcon }[] = [
  { kind: "left", label: "左揃え", icon: AlignStartVertical },
  { kind: "hcenter", label: "左右中央揃え", icon: AlignCenterVertical },
  { kind: "right", label: "右揃え", icon: AlignEndVertical },
  { kind: "top", label: "上揃え", icon: AlignStartHorizontal },
  { kind: "vcenter", label: "上下中央揃え", icon: AlignCenterHorizontal },
  { kind: "bottom", label: "下揃え", icon: AlignEndHorizontal },
];

const DISTRIBUTE_BUTTONS: readonly { axis: DistributeAxis; label: string; icon: LucideIcon }[] = [
  { axis: "horizontal", label: "横に等間隔", icon: AlignHorizontalDistributeCenter },
  { axis: "vertical", label: "縦に等間隔", icon: AlignVerticalDistributeCenter },
];

const alignState = memoBySelection((doc, selection) => ({
  align: canAlign(doc, selection),
  distribute: canDistribute(doc, selection),
}));

/**
 * 整列の節 (§5.3)。2 個以上を選んでいるか、frame の中の 1 個を選んでいるときに出す。
 * ボタンの有効・無効は `canAlign` / `canDistribute` で決める。
 */
export function AlignSection() {
  const { align, distribute, count } = useEditorStore(
    useShallow((s) => ({ ...alignState(s.doc, s.selection), count: s.selection.length })),
  );
  if (count < 2 && !align) return null;
  return (
    <Section title="整列">
      <div className="flex items-center justify-between">
        <div className="flex">
          {ALIGN_BUTTONS.map(({ kind, label, icon: Icon }) => (
            <IconButton
              key={kind}
              label={label}
              disabled={!align}
              onClick={() =>
                applyToSelection((doc, selection) =>
                  withinLimitsOrSame(doc, selection, alignNodes(doc, selection, kind)),
                )
              }
            >
              <Icon size={15} />
            </IconButton>
          ))}
        </div>
      </div>
      <div className="flex">
        {DISTRIBUTE_BUTTONS.map(({ axis, label, icon: Icon }) => (
          <IconButton
            key={axis}
            label={label}
            disabled={!distribute}
            onClick={() =>
              applyToSelection((doc, selection) =>
                withinLimitsOrSame(doc, selection, distributeNodes(doc, selection, axis)),
              )
            }
          >
            <Icon size={15} />
          </IconButton>
        ))}
      </div>
    </Section>
  );
}
