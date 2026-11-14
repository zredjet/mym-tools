/** 書き出しの入口 (§4.9)。切替 PR は `setExportWriter` で保存先の関数を登録する。 */
export { DEFAULT_EXPORT_FILE_NAME, sanitizeFileStem, uniqueFileNames } from "./fileName";
export {
  DEFAULT_PAGE_EXPORT_NAME,
  isEffectivelyVisible,
  planExport,
  SELECTION_EXPORT_NAME,
  snapRectOutward,
} from "./plan";
export {
  MAX_PNG_BYTES,
  MAX_PNG_PIXELS,
  MAX_PNG_SIDE,
  pngSize,
  renderPng,
  type PngSize,
} from "./png";
export { buildExportFiles, ExportError, runExport, type BuildFilesOptions } from "./run";
export {
  buildExportSvg,
  buildExportSvgEl,
  checkExportSvg,
  EXPORT_ID_PREFIX,
  MAX_EXPORT_SVG_BYTES,
  utf8ByteLength,
  type ExportSvgOptions,
} from "./svg";
export {
  EXPORT_SCALES,
  type ExportFile,
  type ExportFormat,
  type ExportKind,
  type ExportPlan,
  type ExportScale,
  type ExportTarget,
  type ExportWriteResult,
  type ExportWriter,
} from "./types";
export { getExportWriter, setExportWriter, useExportWriter } from "./writer";
