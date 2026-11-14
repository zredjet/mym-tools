import type { KeyboardEvent } from "react";

/** 日本語入力の変換中のキー操作か (変換中の Enter と Esc は変換の操作として扱う)。 */
export function isComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
