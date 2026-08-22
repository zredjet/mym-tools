/** C-05: settings.json から前回のプロジェクト／モジュールを復元する起動専用画面。 */
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { listProjects } from "@/ipc/projects";
import { formatInvokeError } from "@/lib/error";
import { resolveStartupTarget } from "@/lib/startup";
import { useAppStore } from "@/store/useAppStore";

export function StartupPage() {
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastProjectId = useAppStore((state) => state.lastOpenedProjectId);
  const defaultProjectId = useAppStore((state) => state.defaultProjectId);
  const lastModuleId = useAppStore((state) => state.lastOpenedModuleId);
  const moduleEnabled = useAppStore((state) => state.moduleEnabled);
  const setLastProject = useAppStore((state) => state.setLastOpenedProjectId);
  const setDefaultProject = useAppStore((state) => state.setDefaultProjectId);
  const setLastModule = useAppStore((state) => state.setLastOpenedModuleId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const projects = await listProjects();
        if (cancelled) return;
        const resolved = resolveStartupTarget({
          projects,
          lastProjectId,
          defaultProjectId,
          lastModuleId,
          moduleEnabled,
        });
        const match = resolved.match(/^\/projects\/([^/]+)\/m\/([^/]+)/);
        if (match != null) {
          setLastProject(decodeURIComponent(match[1]!));
          setLastModule(match[2]!);
        } else if (projects.length === 0) {
          setLastProject(null);
        }
        if (
          defaultProjectId != null &&
          !projects.some((project) => project.id === defaultProjectId)
        ) {
          setDefaultProject(null);
        }
        setTarget(resolved);
      } catch (loadError) {
        if (!cancelled) setError(formatInvokeError(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    lastProjectId,
    defaultProjectId,
    lastModuleId,
    moduleEnabled,
    setLastProject,
    setDefaultProject,
    setLastModule,
  ]);

  if (error != null) {
    return (
      <div role="alert" className="m-6 text-sm text-[var(--destructive)]">
        起動状態の復元に失敗しました: {error}
      </div>
    );
  }
  return target == null ? (
    <p className="m-6 text-sm text-[var(--fg-muted)]">前回の画面を復元しています...</p>
  ) : (
    <Navigate to={target} replace />
  );
}
