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
import { useRowDensityAttribute } from "@/hooks/useRowDensityAttribute";
import { useThemeAttribute } from "@/hooks/useThemeAttribute";
import { useUiScaleAttribute } from "@/hooks/useUiScaleAttribute";
import { HashPage } from "@/modules/hash/HashPage";
import { PromptDetailPage } from "@/modules/prompt/PromptDetailPage";
import { AboutPage } from "@/pages/AboutPage";
import { ModulePage } from "@/pages/ModulePage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WelcomePage } from "@/pages/WelcomePage";

function App() {
  // theme / UI scale / 行高密度 を Zustand と DOM 属性 / CSS 変数で同期
  useThemeAttribute();
  useUiScaleAttribute();
  useRowDensityAttribute();

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
