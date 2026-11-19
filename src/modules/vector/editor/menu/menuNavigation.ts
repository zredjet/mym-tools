/**
 * メニューの部品 (`MenuList.tsx`) のキーの移り方と、フォーカスを取らない押下。
 */
import type { MouseEvent } from "react";

import type { MenuEntry } from "./MenuList";

/** マウスで押したときにフォーカスを取らない。 */
export function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

function enabledIndices(entries: readonly MenuEntry[]): number[] {
  return entries.flatMap((entry, index) =>
    entry.type === "item" && !entry.disabled ? [index] : [],
  );
}

/** `from` から `step` (±1) の向きにある次の使える項目。端では反対の端へ回る。 */
export function nextEnabledIndex(
  entries: readonly MenuEntry[],
  from: number,
  step: 1 | -1,
): number {
  const enabled = enabledIndices(entries);
  if (enabled.length === 0) return -1;
  if (from < 0)
    return step === 1 ? (enabled[0] as number) : (enabled[enabled.length - 1] as number);
  const position = enabled.findIndex((index) => (step === 1 ? index > from : index >= from));
  if (step === 1) return position < 0 ? (enabled[0] as number) : (enabled[position] as number);
  const before = (position < 0 ? enabled.length : position) - 1;
  return before < 0 ? (enabled[enabled.length - 1] as number) : (enabled[before] as number);
}
