/**
 * クラス名連結ヘルパ。`undefined` / `false` / `null` は除外する。
 *
 * shadcn の cn() に近いが、tailwind-merge は Phase 1 では入れない (依存最小化)。
 * 競合する Tailwind クラスを書きそうな箇所はスタイル設計で避ける方針。
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}
