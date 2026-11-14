/** 描画層の入口。契約の型は `./types`。 */
export {
  assetDataUrl,
  assetOf,
  TEXT_INK_OVERFLOW,
  textInkExtent,
  buildNodeShell,
  buildNodeSvg,
  cssFont,
  cssFontFamily,
  defId,
  fontSpecOf,
  utf8ToBase64,
  type DefKind,
  type ShellContext,
} from "./buildNodeSvg";
export {
  canvasTextMeasurer,
  codePointLength,
  createCanvasTextMeasurer,
  letterSpacingWidth,
} from "./measureText";
export {
  CHILDREN_SLOT,
  el,
  escapeXmlAttr,
  escapeXmlText,
  fillSlot,
  formatNumber,
  isSvgEl,
  reactAttrName,
  stripInvalidXmlChars,
  SVG_NS,
  svgElToReact,
  svgElToString,
  type ToReactOptions,
} from "./svgEl";
