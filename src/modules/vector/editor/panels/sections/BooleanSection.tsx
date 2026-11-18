import { TriangleAlert } from "lucide-react";

import { getBooleanEvaluation } from "../../boolean/result";
import { setBooleanOp } from "../../model/booleanOps";
import { BOOLEAN_OP_NAMES } from "../../model/create";
import type { BooleanNode, BooleanOp } from "../../model/types";
import { editorStore, useEditorStore } from "../../state/store";
import { Section, Segmented } from "../fields/Section";
import { commonValue, MIXED } from "../fields/values";

const OPS: readonly { value: BooleanOp; label: string }[] = (
  ["union", "subtract", "intersect", "exclude"] as const
).map((op) => ({ value: op, label: BOOLEAN_OP_NAMES[op] }));

/**
 * ブーリアンの節 (§8.13)。演算の切替 (押すたびに履歴 1 件)。対象は選択の中のブーリアン。
 * 結果を求められなかったブーリアンがあれば、その旨を出す (§8.9.3)。
 */
export function BooleanSection({ booleans }: { booleans: readonly BooleanNode[] }) {
  const value = commonValue(booleans.map((node) => node.op));
  const ids = booleans.map((node) => node.id);
  const failed = useEditorStore((s) =>
    ids.some((id) => getBooleanEvaluation(s.doc, id)?.result === null),
  );
  return (
    <Section title="ブーリアン">
      <Segmented
        label="演算"
        options={OPS}
        value={value === MIXED ? null : value}
        onChange={(op) => editorStore.getState().apply((doc) => setBooleanOp(doc, ids, op))}
      />
      {failed && (
        <p className="flex items-start gap-1.5 text-[12px] text-[var(--fg-muted)]">
          <TriangleAlert
            size={13}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-[var(--destructive)]"
          />
          結果の形を求められませんでした。子の形をそのまま重ねて描いています。
        </p>
      )}
    </Section>
  );
}
