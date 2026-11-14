/**
 * 開発用の画面の入口 (`canvas-harness.html`、§6.2)。アプリの画面からは参照しない。
 * Tauri の IPC は使わない。`vite build` の入力に入れないので配布物には含まれない。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { exposeHarness, initialDocument, HARNESS_DOCUMENTS } from "./documents";
import { EditorHarness } from "./EditorHarness";
import { editorStore } from "../state/store";

exposeHarness();
// 最初の描画より前に読み込む (キャンバスは開いたときに内容が収まるよう表示する)
editorStore.getState().load(HARNESS_DOCUMENTS[initialDocument()]());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <EditorHarness />
  </React.StrictMode>,
);
