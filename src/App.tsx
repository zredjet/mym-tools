/**
 * アプリエントリ。React Router v7 の HashRouter で Shell とモジュールルートを構成する。
 *
 * ルート構造 (`docs/ui-design.md` §3.1):
 * - `/` → `/welcome` (デフォルト)
 * - `/welcome` → C-2 空状態
 * - `/projects/:projectId/m/:moduleId` → モジュール画面 (Prompts / Links / Colors)
 * - `/modules/hash` → M-Hash (stateless、プロジェクト不要)
 *
 * Tauri 環境では HashRouter (`#/...`) を使う方が `tauri dev` の WebView と相性がよく、
 * file:// スキームでも動作する。
 */
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/shell/AppShell";
import { useThemeAttribute } from "@/hooks/useThemeAttribute";
import { HashPage } from "@/modules/hash/HashPage";
import { PromptDetailPage } from "@/modules/prompt/PromptDetailPage";
import { AboutPage } from "@/pages/AboutPage";
import { ModulePage } from "@/pages/ModulePage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WelcomePage } from "@/pages/WelcomePage";

function App() {
  // theme の `<html data-theme>` 属性を Zustand と同期
  useThemeAttribute();

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/welcome" replace />} />
          <Route path="/welcome" element={<WelcomePage />} />
          {/* 個別 prompt の詳細 (より具体的なパス) を先に登録 */}
          <Route path="/projects/:projectId/m/prompt/:itemId" element={<PromptDetailPage />} />
          <Route path="/projects/:projectId/m/:moduleId" element={<ModulePage />} />
          <Route path="/modules/hash" element={<HashPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<Navigate to="/welcome" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

export default App;
