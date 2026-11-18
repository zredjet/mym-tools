/** ツールバーの並びと倍率のメニューの項目。 */
import {
  Circle,
  Frame,
  Hand,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Pencil,
  PenTool,
  Square,
  Star,
  Triangle,
  Type,
  type LucideIcon,
} from "lucide-react";
import { IS_MAC } from "../canvas/input";
import type { ViewCommand } from "../canvas/viewCommands";
import type { ToolId } from "../state/types";

/**
 * ツールバーのまとまり。まとまりの間に区切りの線を置く。
 * 選択 / 形を作る / パスを描く / 文字と画像 / 表示
 */
export type ToolGroup = "select" | "shape" | "path" | "content" | "view";

export interface ToolButtonSpec {
  id: ToolId;
  label: string;
  icon: LucideIcon;
  group: ToolGroup;
  /** ショートカットのキー (表示用。割当は `canvas/shortcuts.ts`) */
  shortcut?: string;
}

const MOD = IS_MAC ? "⌘" : "Ctrl+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

/**
 * ツールバーのボタン (§5.1)。並びは 選択、フレーム、矩形、楕円、多角形、星、線、ペン、鉛筆、
 * テキスト、画像、手のひら (この後に倍率)。メニューにまとめず、どれも 1 回で選べるように並べる。
 * 点の編集のツール (`pathEdit`) は出さない (パスを選んで Enter かダブルクリックで入る)。
 */
export const TOOLBAR_TOOLS: readonly ToolButtonSpec[] = [
  { id: "select", label: "選択", icon: MousePointer2, group: "select", shortcut: "V" },
  { id: "frame", label: "フレーム", icon: Frame, group: "shape", shortcut: "F" },
  { id: "rect", label: "矩形", icon: Square, group: "shape", shortcut: "R" },
  { id: "ellipse", label: "楕円", icon: Circle, group: "shape", shortcut: "O" },
  { id: "polygon", label: "多角形", icon: Triangle, group: "shape" },
  { id: "star", label: "星", icon: Star, group: "shape" },
  { id: "line", label: "線", icon: Minus, group: "shape", shortcut: "L" },
  { id: "pen", label: "ペン", icon: PenTool, group: "path", shortcut: "P" },
  { id: "pencil", label: "鉛筆", icon: Pencil, group: "path", shortcut: `${SHIFT}P` },
  { id: "text", label: "テキスト", icon: Type, group: "content", shortcut: "T" },
  { id: "image", label: "画像", icon: ImageIcon, group: "content" },
  { id: "hand", label: "手のひら", icon: Hand, group: "view", shortcut: "H" },
];

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
