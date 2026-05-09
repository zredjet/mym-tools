/**
 * About ページ (`docs/ui-design.md` §6.10 C-9 / ADR-0008 §2.7)。
 *
 * - アプリ名 / バージョン (`@tauri-apps/api/app` の `getVersion()` で `tauri.conf.json` から)
 * - 「最新版を確認」リンク (OS 既定ブラウザで GitHub Releases を開く、ADR-0008)
 * - 自動更新は実装しない (ADR-0008): ユーザーが Releases ページから手動 DL → 差し替え
 */
import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Code2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/Button";
import { formatInvokeError } from "@/lib/error";

const RELEASES_URL = "https://github.com/zredjet/mym-tools/releases";
const REPO_URL = "https://github.com/zredjet/mym-tools";

export function AboutPage() {
  const navigate = useNavigate();
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = await getVersion();
        if (!cancelled) setVersion(v);
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
            個人用ローカルツールの集合体 — プロンプト / リンク・メモ / カラー / ハッシュ
          </p>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-[var(--fg-subtle)]">バージョン</dt>
          <dd className="font-mono text-[var(--fg)]">{version ?? "..."}</dd>
          <dt className="text-[var(--fg-subtle)]">配布</dt>
          <dd className="text-[var(--fg)]">portable 差し替え方式 (自動更新なし、ADR-0008)</dd>
          <dt className="text-[var(--fg-subtle)]">対応 OS</dt>
          <dd className="text-[var(--fg)]">macOS / Windows</dd>
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
          <Button variant="secondary" onClick={() => void openExternal(REPO_URL)}>
            <Code2 size={14} aria-hidden /> リポジトリを開く
          </Button>
        </div>

        <p className="text-[12px] text-[var(--fg-subtle)]">
          新しい版は GitHub Releases から手動でダウンロードして、現行のアプリを差し替え
          てください。データ (`{`<userdata>/data.sqlite`}`) は維持されます。
        </p>
      </div>
    </div>
  );
}
