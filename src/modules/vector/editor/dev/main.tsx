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

exposeHarness();
// 書き出しはブラウザのダウンロードで保存する (アプリでは切替 PR が保存ダイアログと `vector_write_file` につなぐ)
setExportWriter(downloadWriter);
// 最初の描画より前に読み込む (キャンバスは開いたときに内容が収まるよう表示する)
editorStore.getState().load(harnessDocument(initialDocument()));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <EditorHarness />
  </React.StrictMode>,
);
