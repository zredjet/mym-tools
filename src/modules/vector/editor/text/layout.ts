import type { TextNode } from "../model/types";
import type { LayoutText, TextLayout, TextMeasurer } from "../render/types";

/** `lineHeight` が null のときの行の高さ (フォントサイズに対する倍率)。 */
export const AUTO_LINE_HEIGHT = 1.4;

/**
 * 仮の行分割。改行でだけ行を分け、幅に合わせた折り返しはしない。
 * 「テキスト」のセッションで、折り返し・揃え・禁則を含む実装に置き換える。
 * 描画層はこの関数だけを通して行の位置を得る。
 */
export const layoutText: LayoutText = (node: TextNode, measurer: TextMeasurer): TextLayout => {
  const lineHeight = node.lineHeight ?? node.fontSize * AUTO_LINE_HEIGHT;
  const font = {
    family: node.fontFamily,
    size: node.fontSize,
    weight: node.fontWeight,
    italic: node.italic,
    letterSpacing: node.letterSpacing,
  };
  const lines = node.text.split("\n").map((text, index) => ({
    text,
    x: 0,
    y: index * lineHeight + (lineHeight + node.fontSize * 0.7) / 2,
    width: measurer.measure(text, font),
  }));
  return {
    lines,
    width: lines.reduce((max, line) => Math.max(max, line.width), 0),
    height: lines.length * lineHeight,
  };
};
