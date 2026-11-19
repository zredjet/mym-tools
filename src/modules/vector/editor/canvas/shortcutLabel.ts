/**
 * メニューとツールチップに出すショートカットの表示 (§5.4)。割当は `canvas/shortcuts.ts`。
 * macOS は記号 (⌥⇧⌘ の順)、ほかは文字を + でつなぐ (Ctrl+Alt+Shift の順)。
 */
import { IS_MAC } from "./input";

export interface ShortcutKeys {
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** キーの表示 (`U`、`]`、`⌫` など) */
  key: string;
}

export function shortcutLabel(keys: ShortcutKeys, mac = IS_MAC): string {
  if (mac) return `${keys.alt ? "⌥" : ""}${keys.shift ? "⇧" : ""}${keys.mod ? "⌘" : ""}${keys.key}`;
  return [keys.mod && "Ctrl", keys.alt && "Alt", keys.shift && "Shift", keys.key]
    .filter(Boolean)
    .join("+");
}

/** 削除のキーの表示 (macOS は ⌫、ほかは Delete)。 */
export function deleteKeyLabel(mac = IS_MAC): string {
  return mac ? "⌫" : "Delete";
}
