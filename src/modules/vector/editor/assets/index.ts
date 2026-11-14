/**
 * 画像と SVG の取込 (§4.8)。切替 PR が使う入口。
 *
 * - `setImportFileReader(reader)`: ファイル選択と読み込みの関数を登録する (登録がない間は「画像」のボタンが無効)
 * - `importFile(store, file, { at })`: 読んだファイルを指定した位置 (ページ座標) に置く。OS からのドロップ用
 * - `importFromPicker(store, { at })`: 登録された関数でファイル選択を開いて置く
 */
export { importFile, importFromPicker, canImport, type ImportOptions } from "./importFile";
export { ImportNotice } from "./ImportNotice";
export { getImportFileReader, setImportFileReader, useImportFileReader } from "./reader";
export { useImportStatus } from "./status";
export type { ImportedFile, ImportedImage, ImportedSvg, ImportFileReader } from "./types";
