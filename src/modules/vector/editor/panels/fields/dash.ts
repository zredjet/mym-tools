/**
 * 破線の欄の値 (§8.11、§8.3.2)。数値をスペースかカンマ (全角を含む) で区切った 1 つの文字列。空は実線。
 */
import { CANVAS_LIMITS } from "../../model/limits";
import { parseNumberInput } from "./values";

/** 区切り: 空白 (全角を含む) とカンマ (全角・読点を含む)。 */
const SEPARATORS = /[\s,，、]+/u;

/**
 * 破線の入力を長さと間隔の並びにする。空 (空白だけ) は実線 (`[]`)。
 * §8.3.2 に合わない入力 (数値でない、`maxDashCount` 個を超える、`maxDashLength` を超えるか負の値、合計が 0)
 * は null。値は小数第 2 位に丸める。
 */
export function parseDashInput(text: string): number[] | null {
  const trimmed = text.normalize("NFKC").trim();
  if (trimmed === "") return [];
  const parts = trimmed.split(SEPARATORS).filter((part) => part !== "");
  if (parts.length === 0) return [];
  if (parts.length > CANVAS_LIMITS.maxDashCount) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = parseNumberInput(part);
    if (value === null) return null;
    const rounded = Math.round(value * 100) / 100;
    if (rounded < 0 || rounded > CANVAS_LIMITS.maxDashLength) return null;
    values.push(rounded === 0 ? 0 : rounded);
  }
  return values.reduce((sum, v) => sum + v, 0) > 0 ? values : null;
}

/** 破線の表示 (値をスペースで区切る)。実線は空。 */
export function formatDash(dash: readonly number[]): string {
  return dash.map((v) => String(v)).join(" ");
}
