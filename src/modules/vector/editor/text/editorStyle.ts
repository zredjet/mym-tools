/**
 * 本文の編集欄 (`TextEditOverlay`) の見た目。描画 (`buildNodeShell`) と同じフォント・行の高さ・字間・揃えにし、
 * 文書の大きさのまま作って倍率は `transform: scale` で掛ける (行分割の計測と同じフォントサイズでブラウザが組む)。
 */
import type { CSSProperties } from "react";
import { pageToScreen } from "../canvas/viewport";
import type { Paint, TextNode } from "../model/types";
import { cssFontFamily } from "../render/buildNodeSvg";
import { canvasTextMeasurer } from "../render/measureText";
import { ceilSize, editorLineWidth, layoutText, lineHeightOf } from "./layout";

/** 入力欄の周りの余白 (画面 px)。行末のカーソルが欄の外に出て中身がスクロールしないようにする。 */
const CARET_PAD = 2;

/** 編集欄の文字の色。塗りがなければ (描画では見えない) 薄い前景色で見せる。グラデーションは先頭の色。 */
export function editorTextColor(fill: Paint | null, opacity: number): string {
  if (fill === null) return "var(--fg-muted)";
  const stop = fill.type === "solid" ? fill : fill.stops[0];
  if (!stop) return "var(--fg-muted)";
  const hex = stop.color.replace("#", "");
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const alpha = Math.max(0, Math.min(1, stop.opacity * opacity));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 編集欄の見た目 (画面座標の位置、文書の大きさ、倍率)。 */
export function editorStyle(
  node: TextNode,
  origin: { x: number; y: number },
  viewport: { x: number; y: number; zoom: number },
): CSSProperties {
  const { zoom } = viewport;
  const screen = pageToScreen(viewport, { x: origin.x + node.x, y: origin.y + node.y });
  const pad = CARET_PAD / zoom;
  const layout = layoutText(node, canvasTextMeasurer);
  const color = editorTextColor(node.fill, node.opacity);
  const autoWidth = node.sizing === "auto-width";
  // auto-width は折り返さない。編集欄 (HTML) の行が描画の幅 (ノードの幅) より広く組まれる (WebKit) ときは、
  // 文字が切れないよう入力欄を広げ、揃えの基準 (左端・中心・右端) がノードと同じ位置に来るようにずらす
  const extra = autoWidth
    ? Math.max(0, ceilSize(editorLineWidth(node, canvasTextMeasurer)) - node.width)
    : 0;
  const shift = node.align === "center" ? extra / 2 : node.align === "right" ? extra : 0;
  return {
    position: "absolute",
    left: screen.x - CARET_PAD - shift * zoom,
    top: screen.y - CARET_PAD,
    width: node.width + extra,
    // fixed で本文が高さを超えたときは、描画と同じくはみ出した行も見せる
    height: Math.max(node.height, layout.height),
    padding: pad,
    margin: 0,
    border: 0,
    boxSizing: "content-box",
    transform: `scale(${zoom})`,
    transformOrigin: "0 0",
    background: "transparent",
    outline: "none",
    resize: "none",
    overflow: "hidden",
    pointerEvents: "auto",
    userSelect: "text",
    WebkitUserSelect: "text",
    fontFamily: cssFontFamily(node.fontFamily),
    fontSize: node.fontSize,
    fontWeight: node.fontWeight,
    fontStyle: node.italic ? "italic" : "normal",
    lineHeight: `${lineHeightOf(node)}px`,
    letterSpacing: node.letterSpacing,
    textAlign: node.align,
    textIndent: 0,
    textTransform: "none",
    // 行分割 (`lineBreak.ts`) に合わせる。auto-width は折り返さない
    whiteSpace: autoWidth ? "pre" : "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: "normal",
    lineBreak: "strict",
    // 描画はタブを空白 1 つとして描く
    tabSize: 1,
    color,
    caretColor: node.fill === null ? "var(--fg)" : color,
  };
}
