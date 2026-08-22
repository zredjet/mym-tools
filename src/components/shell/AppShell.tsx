/**
 * アプリシェル (`docs/ui-design.md` §3.1 / §6.1)。
 *
 * - TopBar (40px) + Sidebar (240px 可変) + Main の 2 カラム
 * - `Cmd/Ctrl + K` で SearchOverlay 起動 (§8.1)
 * - `Cmd/Ctrl + Shift + P` で ProjectSwitcher 起動 (C-3、§8.1)
 * - プロジェクト一覧は React 内 state でキャッシュ。新規作成・削除でリフレッシュ
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Outlet, useNavigate, useParams } from "react-router-dom";

import { ProjectSwitcher } from "@/components/projects/ProjectSwitcher";
import { SearchOverlay } from "@/components/shell/SearchOverlay";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { listProjects } from "@/ipc/projects";
import { formatInvokeError } from "@/lib/error";
import type { ModuleId, Project } from "@/lib/types";
import { enabledModules, getModuleDefinition, modulePath } from "@/modules/registry";
import { useAppStore } from "@/store/useAppStore";

export interface AppShellOutletContext {
  projects: Project[];
  refreshProjects: () => Promise<void>;
}

export function AppShell() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { projectId } = useParams<{ projectId?: string }>();

  const refresh = useCallback(async () => {
    try {
      const list = await listProjects();
      setProjects(list);
      setError(null);
    } catch (e) {
      setError(formatInvokeError(e));
    }
  }, []);

  // 初回マウントでプロジェクト一覧を取得 (Tauri IPC との同期 = react-hooks/set-state-in-effect の
  // 公式例外の一つ「外部システムとの同期」に該当)。`cancelled` で unmount 後の setState を防止
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await listProjects();
        if (!cancelled) {
          setProjects(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cmd/Ctrl+K で検索 (`docs/ui-design.md` §8.1)
  // hotkey で別の overlay を起動する時は、相互に閉じてモーダル二重表示を防ぐ
  useHotkeys(
    "mod+k",
    (e) => {
      e.preventDefault();
      setSwitcherOpen(false);
      setSearchOpen(true);
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );

  // Cmd/Ctrl+Shift+P でプロジェクト切替 (C-3、`docs/ui-design.md` §8.1)
  useHotkeys(
    "mod+shift+p",
    (e) => {
      e.preventDefault();
      setSearchOpen(false);
      setSwitcherOpen(true);
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );

  const navigate = useNavigate();
  const setLastProject = useAppStore((s) => s.setLastOpenedProjectId);
  const setLastModule = useAppStore((s) => s.setLastOpenedModuleId);
  const lastOpenedProjectId = useAppStore((s) => s.lastOpenedProjectId);
  const moduleEnabled = useAppStore((s) => s.moduleEnabled);
  const visibleModules = enabledModules(moduleEnabled);

  // Settings / About では lastOpenedProjectId を TopBar / ショートカットの基準にする。
  const currentProject = useMemo(() => {
    const explicit = projects.find((p) => p.id === projectId);
    if (explicit != null) return explicit;
    if (lastOpenedProjectId != null) {
      return projects.find((p) => p.id === lastOpenedProjectId) ?? null;
    }
    return null;
  }, [projects, projectId, lastOpenedProjectId]);

  // Cmd/Ctrl+1〜4 で現在有効なモジュールを registry 順に切替 (`docs/ui-design.md` §8.1)
  const goToModule = useCallback(
    (mod: ModuleId) => {
      if (currentProject == null) return;
      const definition = getModuleDefinition(mod);
      if (definition == null || !visibleModules.some((module) => module.id === mod)) return;
      setLastModule(mod);
      navigate(modulePath(currentProject.id, mod, definition.defaultRoute));
    },
    [navigate, currentProject, setLastModule, visibleModules],
  );
  useHotkeys("mod+1", (e) => {
    e.preventDefault();
    if (visibleModules[0] != null) goToModule(visibleModules[0].id);
  });
  useHotkeys("mod+2", (e) => {
    e.preventDefault();
    if (visibleModules[1] != null) goToModule(visibleModules[1].id);
  });
  useHotkeys("mod+3", (e) => {
    e.preventDefault();
    if (visibleModules[2] != null) goToModule(visibleModules[2].id);
  });
  useHotkeys("mod+4", (e) => {
    e.preventDefault();
    if (visibleModules[3] != null) goToModule(visibleModules[3].id);
  });

  // Cmd/Ctrl+, で設定ページ (`docs/ui-design.md` §8.1)
  useHotkeys(
    "mod+comma",
    (e) => {
      e.preventDefault();
      navigate("/settings");
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );

  const handleProjectCreated = useCallback(
    (project: Project) => {
      void refresh();
      const defaultModule = visibleModules[0];
      setLastProject(project.id);
      if (defaultModule == null) navigate("/settings");
      else {
        setLastModule(defaultModule.id);
        navigate(modulePath(project.id, defaultModule.id, defaultModule.defaultRoute));
      }
    },
    [refresh, navigate, setLastProject, setLastModule, visibleModules],
  );

  return (
    <div className="flex h-screen w-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <TopBar currentProject={currentProject} onOpenSearch={() => setSearchOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          projects={projects}
          onProjectCreated={handleProjectCreated}
          onProjectChanged={() => void refresh()}
        />
        <main className="min-w-0 flex-1 overflow-auto">
          {error != null ? (
            <div className="m-6 rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-4 text-sm text-[var(--destructive)]">
              プロジェクト一覧の取得に失敗: {error}
            </div>
          ) : (
            <Outlet
              context={
                {
                  projects,
                  refreshProjects: refresh,
                } satisfies AppShellOutletContext
              }
            />
          )}
        </main>
      </div>
      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        currentProjectId={currentProject?.id ?? null}
        currentProjectName={currentProject?.name ?? null}
      />
      <ProjectSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        projects={projects}
      />
    </div>
  );
}
