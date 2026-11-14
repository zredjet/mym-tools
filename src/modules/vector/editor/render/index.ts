/** 描画層の入口。契約の型は `./types`。 */
export {
  assetDataUrl,
  assetOf,
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
  SVG_NS,
  svgElToReact,
  svgElToString,
  type ToReactOptions,
} from "./svgEl";
