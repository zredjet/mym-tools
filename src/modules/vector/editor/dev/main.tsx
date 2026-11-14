/**
 * 開発用の画面の入口 (`canvas-harness.html`、§6.2)。アプリの画面からは参照しない。
 * Tauri の IPC は使わない。`vite build` の入力に入れないので配布物には含まれない。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { exposeHarness, harnessDocument, initialDocument } from "./documents";
import { EditorHarness } from "./EditorHarness";
import { editorStore } from "../state/store";
import { setExportWriter } from "../export/writer";
import { downloadWriter } from "./downloadWriter";
import { setImportFileReader } from "../assets/reader";
import { exposeImportHarness, harnessFileReader } from "./fileReader";

exposeHarness();
// 書き出しはブラウザのダウンロードで保存する (アプリでは切替 PR が保存ダイアログと `vector_write_file` につなぐ)
setExportWriter(downloadWriter);
// 画像と SVG の取込は <input type="file"> で読む (アプリでは切替 PR が plugin-dialog と vector_read_* につなぐ)
setImportFileReader(harnessFileReader);
exposeImportHarness();
// 最初の描画より前に読み込む (キャンバスは開いたときに内容が収まるよう表示する)
editorStore.getState().load(harnessDocument(initialDocument()));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <EditorHarness />
  </React.StrictMode>,
);
