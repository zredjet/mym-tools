import { codePointLength } from "./measureText";
import type { TextMeasurer } from "./types";

/**
 * テスト用の計測。1 文字 (コードポイント) の幅を フォントサイズ × `ratio` とし、字間を足す。
 * 後続のセッションのテストでも使えるように公開する。
 */
export function fixedWidthMeasurer(ratio = 0.5): TextMeasurer {
  return {
    measure(text, font) {
      return codePointLength(text) * (font.size * ratio + font.letterSpacing);
    },
  };
}
