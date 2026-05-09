/**
 * アプリシェル (`docs/ui-design.md` §3.1 / §6.1)。
 *
 * - TopBar (40px) + Sidebar (240px 可変) + Main の 2 カラム
 * - `Cmd/Ctrl + K` で SearchOverlay 起動 (§8.1)
 * - プロジェクト一覧は React 内 state でキャッシュ。新規作成・削除でリフレッシュ
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Outlet, useNavigate, useParams } from "react-router-dom";

import { SearchOverlay } from "@/components/shell/SearchOverlay";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { listProjects } from "@/ipc/projects";
import { formatInvokeError } from "@/lib/error";
import type { ModuleId, Project } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

export interface AppShellOutletContext {
  projects: Project[];
  refreshProjects: () => Promise<void>;
}

export function AppShell() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
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
  useHotkeys(
    "mod+k",
    (e) => {
      e.preventDefault();
      setSearchOpen(true);
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );

  const currentProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const navigate = useNavigate();
  const setLastProject = useAppStore((s) => s.setLastOpenedProjectId);
  const setLastModule = useAppStore((s) => s.setLastOpenedModuleId);

  // Cmd/Ctrl+1〜4 でサイドバーのモジュール切替 (`docs/ui-design.md` §8.1)
  // 1=Prompts, 2=Links, 3=Colors, 4=Hash。プロジェクト未選択時は Hash のみ可
  const goToModule = useCallback(
    (mod: ModuleId) => {
      setLastModule(mod);
      if (mod === "hash") {
        navigate("/modules/hash");
        return;
      }
      if (currentProject == null) return;
      navigate(`/projects/${currentProject.id}/m/${mod}`);
    },
    [navigate, currentProject, setLastModule],
  );
  useHotkeys("mod+1", (e) => {
    e.preventDefault();
    goToModule("prompt");
  });
  useHotkeys("mod+2", (e) => {
    e.preventDefault();
    goToModule("linkmemo");
  });
  useHotkeys("mod+3", (e) => {
    e.preventDefault();
    goToModule("color");
  });
  useHotkeys("mod+4", (e) => {
    e.preventDefault();
    goToModule("hash");
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
      // 作成したばかりのプロジェクトに自動遷移 (デフォルトモジュール = Prompts)
      const defaultModule: ModuleId = "prompt";
      setLastProject(project.id);
      navigate(`/projects/${project.id}/m/${defaultModule}`);
    },
    [refresh, navigate, setLastProject],
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
    </div>
  );
}
