/** settings.json の初期ロードと500msデバウンス保存。 */
import { type ReactNode, useEffect, useRef, useState } from "react";

import { getSettings, updateSettings } from "@/ipc/settings";
import { getBackendModuleIds } from "@/ipc/modules";
import { formatInvokeError } from "@/lib/error";
import { mergeSettingsDocument } from "@/lib/settings";
import { modules } from "@/modules/registry";
import { useAppStore } from "@/store/useAppStore";

const SAVE_DEBOUNCE_MS = 500;

export function SettingsLifecycle({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const hydrated = useAppStore((state) => state.settingsHydrated);
  const error = useAppStore((state) => state.settingsError);
  const hydrate = useAppStore((state) => state.hydrateSettings);
  const setError = useAppStore((state) => state.setSettingsError);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [document, backendModuleIds] = await Promise.all([
          getSettings(),
          getBackendModuleIds(),
        ]);
        const frontendModuleIds = modules.map((module) => module.id).sort();
        const backendSorted = [...backendModuleIds].sort();
        if (JSON.stringify(frontendModuleIds) !== JSON.stringify(backendSorted)) {
          throw new Error(
            `module registry mismatch: frontend=[${frontendModuleIds.join(", ")}], backend=[${backendSorted.join(", ")}]`,
          );
        }
        if (!cancelled) hydrate(document, frontendModuleIds);
      } catch (loadError) {
        if (!cancelled) setError(formatInvokeError(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, hydrate, setError]);

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] p-6 text-[var(--fg)]">
        {error == null ? (
          <p className="text-sm text-[var(--fg-muted)]">設定を読み込んでいます...</p>
        ) : (
          <div className="max-w-lg rounded-[var(--radius)] border border-[var(--destructive)] p-4">
            <h1 className="font-semibold">アプリの初期化に失敗しました</h1>
            <p role="alert" className="mt-2 text-sm text-[var(--destructive)]">
              {error}
            </p>
            <button
              type="button"
              className="mt-3 rounded-[var(--radius)] bg-[var(--accent)] px-3 py-1.5 text-sm text-white"
              onClick={() => {
                setError(null);
                setAttempt((value) => value + 1);
              }}
            >
              再試行
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <SettingsSync />
      {children}
    </>
  );
}

function SettingsSync() {
  const document = useAppStore((state) => state.settingsDocument);
  const theme = useAppStore((state) => state.theme);
  const defaultProjectId = useAppStore((state) => state.defaultProjectId);
  const lastOpenedProjectId = useAppStore((state) => state.lastOpenedProjectId);
  const lastOpenedModuleId = useAppStore((state) => state.lastOpenedModuleId);
  const searchDefaultScope = useAppStore((state) => state.searchDefaultScope);
  const logLevel = useAppStore((state) => state.logLevel);
  const sidebarWidth = useAppStore((state) => state.sidebarWidth);
  const uiScale = useAppStore((state) => state.uiScale);
  const rowDensity = useAppStore((state) => state.rowDensity);
  const moduleEnabled = useAppStore((state) => state.moduleEnabled);
  const setError = useAppStore((state) => state.setSettingsError);
  const lastSaved = useRef<string | null>(null);
  const pendingSave = useRef<{
    settings: Parameters<typeof updateSettings>[0];
    serialized: string;
  } | null>(null);
  const pendingTimeout = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pendingTimeout.current != null) {
        window.clearTimeout(pendingTimeout.current);
        pendingTimeout.current = null;
      }

      const pending = pendingSave.current;
      if (pending == null) return;
      pendingSave.current = null;
      void updateSettings(pending.settings).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (document == null) return;
    const next = mergeSettingsDocument(document, {
      theme,
      defaultProjectId,
      lastOpenedProjectId,
      lastOpenedModuleId,
      searchDefaultScope,
      logLevel,
      sidebarWidth,
      uiScale,
      rowDensity,
      moduleEnabled,
    });
    const serialized = JSON.stringify(next);
    if (lastSaved.current == null) {
      lastSaved.current = serialized;
      return;
    }
    if (lastSaved.current === serialized) return;

    pendingSave.current = { settings: next, serialized };
    const timeout = window.setTimeout(() => {
      pendingTimeout.current = null;
      const pending = pendingSave.current;
      if (pending == null || pending.serialized !== serialized) return;

      void updateSettings(pending.settings)
        .then(() => {
          lastSaved.current = serialized;
          if (pendingSave.current?.serialized === serialized) {
            pendingSave.current = null;
          }
          setError(null);
        })
        .catch((saveError: unknown) => setError(formatInvokeError(saveError)));
    }, SAVE_DEBOUNCE_MS);
    pendingTimeout.current = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (pendingTimeout.current === timeout) pendingTimeout.current = null;
    };
  }, [
    document,
    theme,
    defaultProjectId,
    lastOpenedProjectId,
    lastOpenedModuleId,
    searchDefaultScope,
    logLevel,
    sidebarWidth,
    uiScale,
    rowDensity,
    moduleEnabled,
    setError,
  ]);

  return null;
}
