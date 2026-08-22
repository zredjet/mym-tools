/**
 * About ページ (`docs/ui-design.md` §6.10 C-9 / ADR-0008 §2.7)。
 *
 * 表示項目 (`docs/ui-design.md` §6.10 スケルトン準拠):
 * - アプリ名 / バージョン (`@tauri-apps/api/app::getVersion`)
 * - Platform (OS / arch / version、`@tauri-apps/plugin-os`)
 * - 「最新版を確認」(GitHub Releases、ADR-0008 §2.7 — 自動更新なし)
 * - 「ユーザーデータフォルダを開く」(`@tauri-apps/api/path::appDataDir` +
 *   `@tauri-apps/plugin-opener::openPath`)
 * - 「リポジトリを開く」
 * - payload schema 表示 (`core_module_versions` IPC、`docs/ui-design.md` §6.10 末尾)
 *
 * **未対応 (Phase 2 候補)**:
 * - Build date / commit hash 表示 (`build.rs` で env var を埋め込む方式、CI と整合性
 *   検証が要るため Phase 1 では見送り)
 * - 専用ログフォルダ (現状 tracing は stdout のみ、ファイル出力は未実装)
 */
import { useEffect, useState } from "react";
import { ArrowLeft, Code2, ExternalLink, FolderOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { arch, platform, version as osVersion } from "@tauri-apps/plugin-os";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/Button";
import { formatInvokeError } from "@/lib/error";

const RELEASES_URL = "https://github.com/zredjet/mym-tools/releases";
const REPO_URL = "https://github.com/zredjet/mym-tools";

interface ModuleVersionInfo {
  module_id: string;
  current_payload_version: number;
}

interface PlatformInfo {
  platform: string;
  arch: string;
  version: string;
}

export function AboutPage() {
  const navigate = useNavigate();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [moduleVersions, setModuleVersions] = useState<ModuleVersionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 各メタ情報を並列ロード。1 つが失敗しても他は表示できるよう、エラーは集約せず
  // 個別に握る方針 (どれも fatal ではない、About 画面は最悪空でも害なし)。
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const v = await getVersion();
        if (!cancelled) setAppVersion(v);
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      }
    })();

    void (async () => {
      try {
        // plugin-os の API は **同期** (Tauri 内部の OS 情報なので即返る)
        const p = platform();
        const a = arch();
        const v = osVersion();
        if (!cancelled) setPlatformInfo({ platform: p, arch: a, version: v });
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      }
    })();

    void (async () => {
      try {
        const d = await appDataDir();
        if (!cancelled) setDataDir(d);
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      }
    })();

    void (async () => {
      try {
        const list = await invoke<ModuleVersionInfo[]>("core_module_versions");
        if (!cancelled) setModuleVersions(list);
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const openExternal = async (url: string) => {
    try {
      await openUrl(url);
    } catch (e) {
      setError(formatInvokeError(e));
    }
  };

  const openDataDir = async () => {
    if (dataDir == null) return;
    try {
      // `openPath` は OS の関連付け既定アプリで開く (ディレクトリなら Finder / Explorer)
      await openPath(dataDir);
    } catch (e) {
      setError(formatInvokeError(e));
    }
  };

  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} aria-label="戻る">
          <ArrowLeft size={14} aria-hidden /> 戻る
        </Button>
        <h1 className="text-lg font-semibold">About</h1>
      </header>

      <div className="flex max-w-xl flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] p-6">
        <div>
          <h2 className="text-2xl font-bold text-[var(--fg)]">MyMyTools</h2>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
            個人用ローカルツールの集合体 — プロンプト / リンク・メモ / カラー / ハッシュ / パレット
          </p>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-[var(--fg-subtle)]">Version</dt>
          <dd className="font-mono text-[var(--fg)]">{appVersion ?? "..."}</dd>

          <dt className="text-[var(--fg-subtle)]">Platform</dt>
          <dd className="font-mono text-[var(--fg)]">
            {platformInfo != null
              ? `${platformInfo.platform} ${platformInfo.version} · ${platformInfo.arch}`
              : "..."}
          </dd>

          <dt className="text-[var(--fg-subtle)]">配布</dt>
          <dd className="text-[var(--fg)]">portable 差し替え方式 (自動更新なし、ADR-0008)</dd>

          {dataDir != null && (
            <>
              <dt className="text-[var(--fg-subtle)]">データ</dt>
              <dd className="truncate font-mono text-[12px] text-[var(--fg-muted)]" title={dataDir}>
                {dataDir}
              </dd>
            </>
          )}
        </dl>

        {error != null && (
          <p role="alert" className="text-[12px] text-[var(--destructive)]">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
          <Button variant="primary" onClick={() => void openExternal(RELEASES_URL)}>
            <ExternalLink size={14} aria-hidden /> 最新版を確認
          </Button>
          <Button
            variant="secondary"
            onClick={() => void openDataDir()}
            disabled={dataDir == null}
            title={dataDir ?? ""}
          >
            <FolderOpen size={14} aria-hidden /> データフォルダを開く
          </Button>
          <Button variant="secondary" onClick={() => void openExternal(REPO_URL)}>
            <Code2 size={14} aria-hidden /> リポジトリを開く
          </Button>
        </div>

        <p className="text-[12px] text-[var(--fg-subtle)]">
          新しい版は GitHub Releases から手動でダウンロードして、現行のアプリを差し替え
          てください。データ (<code className="font-mono">data.sqlite</code>) は維持されます (DB
          schema v2 自動 migration あり、ADR-0011)。
        </p>

        {/* payload schema 表示 (docs/ui-design.md §6.10 末尾)。
            障害発生時のサポート連絡時に「どのバージョンを認識しているか」確認用 */}
        {moduleVersions != null && moduleVersions.length > 0 && (
          <section className="border-t border-[var(--border)] pt-4">
            <h3 className="mb-2 text-[11px] font-semibold tracking-[0.05em] text-[var(--fg-subtle)] uppercase">
              payload schema (現在認識)
            </h3>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[12px] text-[var(--fg)]">
              {moduleVersions.map((m) => (
                <li key={m.module_id}>
                  <span className="text-[var(--fg-muted)]">
                    {canonicalModuleLabel(m.module_id)}
                  </span>{" "}
                  <span className="text-[var(--accent)]">v{m.current_payload_version}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * payload schema 表示用の **正典モジュール名** (`docs/ui-design.md` §6.10 / docs 全般)。
 *
 * `module_id` (英小文字、`module-contract.md` §3.2) → 表示用ラベルへの写像。
 * 単純な `capitalize` だと `linkmemo` → `Linkmemo` となり正典 `M-LinkMemo` と乖離する
 * (codex PR-AF P3)。未知 ID は `M-<Id>` の generic ケースにフォールバックする。
 */
function canonicalModuleLabel(moduleId: string): string {
  const canonical: Record<string, string> = {
    prompt: "M-Prompt",
    linkmemo: "M-LinkMemo",
    color: "M-Color",
    hash: "M-Hash",
  };
  return canonical[moduleId] ?? `M-${moduleId.charAt(0).toUpperCase()}${moduleId.slice(1)}`;
}
