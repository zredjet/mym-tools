/** ツールバーの並びと倍率のメニューの項目。 */
import {
  Circle,
  Frame,
  Hand,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Square,
  Type,
  type LucideIcon,
} from "lucide-react";
import { IS_MAC } from "../canvas/input";
import type { ViewCommand } from "../canvas/viewCommands";
import type { ToolId } from "../state/types";

export interface ToolButtonSpec {
  id: ToolId;
  label: string;
  icon: LucideIcon;
  /** ショートカットのキー (表示用。割当は `canvas/shortcuts.ts`) */
  shortcut?: string;
}

export const TOOLBAR_TOOLS: readonly ToolButtonSpec[] = [
  { id: "select", label: "選択", icon: MousePointer2, shortcut: "V" },
  { id: "frame", label: "フレーム", icon: Frame, shortcut: "F" },
  { id: "rect", label: "矩形", icon: Square, shortcut: "R" },
  { id: "ellipse", label: "楕円", icon: Circle, shortcut: "O" },
  { id: "line", label: "線", icon: Minus, shortcut: "L" },
  { id: "text", label: "テキスト", icon: Type, shortcut: "T" },
  { id: "image", label: "画像", icon: ImageIcon },
  { id: "hand", label: "手のひら", icon: Hand, shortcut: "H" },
];

const MOD = IS_MAC ? "⌘" : "Ctrl+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

export const ZOOM_ITEMS: readonly { command: ViewCommand; label: string; shortcut: string }[] = [
  { command: "zoomIn", label: "ズームイン", shortcut: `${MOD}+` },
  { command: "zoomOut", label: "ズームアウト", shortcut: `${MOD}-` },
  { command: "zoomTo100", label: "100%", shortcut: `${SHIFT}0` },
  { command: "zoomToFit", label: "全体を表示", shortcut: `${SHIFT}1` },
  { command: "zoomToSelection", label: "選択範囲を表示", shortcut: `${SHIFT}2` },
];

/** 倍率の表示 (%)。1% 未満は小数 1 桁。 */
export function formatZoom(zoom: number): string {
  const percent = zoom * 100;
  return percent < 1 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}
