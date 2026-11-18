import { useEffect, useSyncExternalStore } from "react";

import { useEditorStore } from "../../state/store";
import {
  getShapeToolSettings,
  resetShapeToolSettings,
  setShapeToolSettings,
  subscribeShapeToolSettings,
} from "../../tools/polygonTool";
import { POLYGON_MAX_SIDES, POLYGON_MIN_SIDES, STAR_MIN_RATIO } from "../../path/polygon";
import { NumberField } from "../fields/NumberField";
import { FieldGrid, Section } from "../fields/Section";

/** 凹みの欄は % で出す (0.382 → 38.2%)。小数第 1 位まで。 */
const RATIO_PERCENT_PRECISION = 1;

/**
 * ツールの設定の節 (§8.8 / §8.13)。多角形・星のツールを選んでいる間だけ出す。
 * 頂点の数 (3〜60) と、星の凹み (内側の半径 ÷ 外側の半径、1〜100 %)。
 *
 * 値はエディタを開いている間だけ覚える (`tools/polygonTool.ts` のモジュールの変数。store にも settings.json にも
 * 入れない)。この節はプロパティパネルと一緒にエディタを開いている間ずっと置かれ、開いたときに既定へ戻す。
 * 文書は変えないので、履歴にも積まない。
 */
export function ToolSettingsSection() {
  const toolId = useEditorStore((s) => s.toolId);
  const settings = useSyncExternalStore(
    subscribeShapeToolSettings,
    getShapeToolSettings,
    getShapeToolSettings,
  );
  useEffect(() => resetShapeToolSettings(), []);

  if (toolId !== "polygon" && toolId !== "star") return null;
  const star = toolId === "star";
  return (
    <Section title="ツールの設定">
      <FieldGrid>
        {/* ツールごとに別の欄にする。ツールバーのボタンは押しても欄からフォーカスを外さないので、同じ欄のままだと
            打ちかけの値と確定先 (多角形の設定) が星の欄に持ち越される。外れる欄は打ちかけの値を自分の設定に確定する */}
        <NumberField
          key={toolId}
          label="頂点"
          ariaLabel="頂点の数"
          value={star ? settings.starPoints : settings.polygonSides}
          min={POLYGON_MIN_SIDES}
          max={POLYGON_MAX_SIDES}
          onCommit={(value) =>
            setShapeToolSettings(star ? { starPoints: value } : { polygonSides: value })
          }
        />
        {star && (
          <NumberField
            label="凹み"
            ariaLabel="星の凹み"
            suffix="%"
            precision={RATIO_PERCENT_PRECISION}
            value={Math.round(settings.starRatio * 1000) / 10}
            min={STAR_MIN_RATIO * 100}
            max={100}
            onCommit={(value) => setShapeToolSettings({ starRatio: value / 100 })}
          />
        )}
      </FieldGrid>
    </Section>
  );
}
