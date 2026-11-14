import { updateNodes } from "../../model/transform";
import type { FrameNode } from "../../model/types";
import { editorStore } from "../../state/store";
import { rememberFrameSize } from "../../tools/create/frameSize";
import { CheckboxField, Section } from "../fields/Section";
import { commonValue, MIXED } from "../fields/values";
import {
  FRAME_PRESET_CATEGORIES,
  FRAME_PRESETS,
  findFramePresetBySize,
  framePresetLabel,
  getFramePreset,
} from "./framePresets";

const CUSTOM = "custom";

/**
 * フレームの節 (§5.3)。プリセット (§5.6) と、はみ出しを切り抜くか。
 * プリセットを選ぶと左上を保って大きさだけを変える (frame の子は動かさない)。
 */
export function FrameSection({ frames }: { frames: readonly FrameNode[] }) {
  const ids = frames.map((frame) => frame.id);
  const size = commonValue(frames.map((frame) => `${frame.width}x${frame.height}`));
  const current =
    size === MIXED
      ? ""
      : (findFramePresetBySize(frames[0]?.width ?? 0, frames[0]?.height ?? 0)?.id ?? CUSTOM);

  return (
    <Section title="フレーム">
      <select
        aria-label="フレームのプリセット"
        className="h-7 w-full rounded-[var(--radius-sm)] border border-transparent bg-[var(--bg-muted)] px-1.5 text-[12px] text-[var(--fg)] outline-none hover:border-[var(--border)] focus:border-[var(--accent)]"
        value={current}
        onChange={(event) => {
          const preset = getFramePreset(event.target.value);
          if (!preset) return;
          // フレームツールのクリックで作る大きさとして覚える (§5.6)
          rememberFrameSize(preset);
          editorStore
            .getState()
            .apply((doc) => updateNodes(doc, ids, { width: preset.width, height: preset.height }));
        }}
      >
        {current === "" && (
          <option value="" disabled>
            混在
          </option>
        )}
        <option value={CUSTOM} disabled>
          カスタム
        </option>
        {FRAME_PRESET_CATEGORIES.map((category) => (
          <optgroup key={category} label={category}>
            {FRAME_PRESETS.filter((preset) => preset.category === category).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {framePresetLabel(preset)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <CheckboxField
        label="はみ出しを切り抜く"
        checked={commonValue(frames.map((frame) => frame.clip))}
        onChange={(clip) => editorStore.getState().apply((doc) => updateNodes(doc, ids, { clip }))}
      />
    </Section>
  );
}
