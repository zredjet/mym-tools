/** React Router v7 のアプリルート。モジュール画面は registry から動的に構成する。 */
import { type ReactNode, Suspense, useEffect } from "react";
import { Navigate, RouterProvider, createHashRouter, useParams } from "react-router-dom";

import { SettingsLifecycle } from "@/components/settings/SettingsLifecycle";
import { AppShell } from "@/components/shell/AppShell";
import { useRowDensityAttribute } from "@/hooks/useRowDensityAttribute";
import { useThemeAttribute } from "@/hooks/useThemeAttribute";
import { useUiScaleAttribute } from "@/hooks/useUiScaleAttribute";
import { enabledModules, isModuleEnabled, modulePath, modules } from "@/modules/registry";
import type { ModuleDefinition } from "@/modules/types";
import { AboutPage } from "@/pages/AboutPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { StartupPage } from "@/pages/StartupPage";
import { WelcomePage } from "@/pages/WelcomePage";
import { useAppStore } from "@/store/useAppStore";

function App() {
  useThemeAttribute();
  useUiScaleAttribute();
  useRowDensityAttribute();

  return (
    <SettingsLifecycle>
      <RouterProvider router={router} />
    </SettingsLifecycle>
  );
}

const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <StartupPage /> },
      { path: "/welcome", element: <WelcomePage /> },
      ...modules.flatMap((module) =>
        module.routes.map((route) => {
          const Component = route.component;
          const suffix = route.path === "/" ? "" : route.path;
          return {
            path: `/projects/:projectId/m/${module.id}${suffix}`,
            element: (
              <ModuleAccess module={module}>
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-[var(--fg-muted)]">
                      モジュールを読み込んでいます...
                    </div>
                  }
                >
                  <Component />
                </Suspense>
              </ModuleAccess>
            ),
          };
        }),
      ),
      { path: "/settings", element: <SettingsPage /> },
      { path: "/about", element: <AboutPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export function ModuleAccess({
  module,
  children,
}: {
  module: ModuleDefinition;
  children: ReactNode;
}) {
  const { projectId } = useParams<{ projectId: string }>();
  const overrides = useAppStore((state) => state.moduleEnabled);
  const setLastProject = useAppStore((state) => state.setLastOpenedProjectId);
  const setLastModule = useAppStore((state) => state.setLastOpenedModuleId);
  const enabled = isModuleEnabled(module, overrides);

  // sidebar 以外 (検索結果、直接 URL、履歴移動) からの遷移も C-05 の復元状態へ反映する。
  useEffect(() => {
    if (!enabled || projectId == null) return;
    setLastProject(projectId);
    setLastModule(module.id);
  }, [enabled, module.id, projectId, setLastProject, setLastModule]);

  if (enabled) return children;
  const fallback = enabledModules(overrides)[0];
  if (fallback == null || projectId == null) return <Navigate to="/settings" replace />;
  return <Navigate to={modulePath(projectId, fallback.id, fallback.defaultRoute)} replace />;
}

export default App;
