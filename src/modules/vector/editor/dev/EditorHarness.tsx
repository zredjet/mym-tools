/**
 * 開発用の画面 (§6.2)。契約データの `full` を `editorStore.load` に渡して `EditorRoot` をウィンドウいっぱいに出す。
 * 上の細い帯で、読み込む文書とライト / ダークを切り替えられる。
 *
 * 検証用に `window.__canvasHarness` から store と文書の読み込みを触れる (この画面の中だけ)。
 *   __canvasHarness.store.getState()            状態
 *   __canvasHarness.load("stress")              文書を読み込む ("full" / "empty" / "sample" / "stress")
 *   __canvasHarness.setTheme("dark")            テーマ
 */
import { useEffect, useState } from "react";
import { EditorRoot } from "../EditorRoot";
import {
  applyTheme,
  HARNESS_DOCUMENTS,
  initialDocument,
  initialTheme,
  loadDocument,
  type HarnessDocumentName,
  type Theme,
} from "./documents";

export function EditorHarness() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [docName, setDocName] = useState<HarnessDocumentName>(initialDocument);

  useEffect(() => applyTheme(theme), [theme]);

  return (
    <div className="flex h-screen w-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-[var(--border)] px-3 text-[12px] text-[var(--fg-muted)]">
        <span className="font-medium text-[var(--fg)]">Canvas harness</span>
        <label className="flex items-center gap-1">
          文書
          <select
            className="h-6 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-1 text-[var(--fg)]"
            value={docName}
            onChange={(event) => {
              const name = event.target.value as HarnessDocumentName;
              setDocName(name);
              loadDocument(name);
            }}
          >
            {Object.keys(HARNESS_DOCUMENTS).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          テーマ
          <select
            className="h-6 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-1 text-[var(--fg)]"
            value={theme}
            onChange={(event) => setTheme(event.target.value as Theme)}
          >
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1">
        <EditorRoot />
      </div>
    </div>
  );
}
