/**
 * 設定ページ (`docs/ui-design.md` §6.9 C-7 / C-8)。
 *
 * Phase 1 PR-N (本 PR): バックアップ管理 (C-8) のみ実装。
 * - 「今すぐバックアップ」(manual)
 * - 全バックアップ一覧 (auto / pre-op / manual を created_at DESC で混在)
 * - 各行: 作成日時 / 種別 / data_revision / サイズ / リストア / 削除
 * - 削除 / リストアは `ConfirmDeleteDialog` で type-to-confirm
 * - リストア成功で「アプリを再起動してください」モーダル
 *
 * About (C-9) / Markdown 表示 / 設定可変項目 (theme は Sidebar から既存) は別 PR。
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { Modal } from "@/components/ui/Modal";
import {
  type BackupRecord,
  deleteBackup,
  listBackups,
  restoreBackup,
  takeManualBackup,
} from "@/ipc/backup";
import { formatInvokeError } from "@/lib/error";

export function SettingsPage() {
  const navigate = useNavigate();
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [taking, setTaking] = useState(false);
  const [deletingBackup, setDeletingBackup] = useState<BackupRecord | null>(null);
  const [restoringBackup, setRestoringBackup] = useState<BackupRecord | null>(null);
  const [restartPrompt, setRestartPrompt] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const list = await listBackups();
      setBackups(list);
      setError(null);
    } catch (e) {
      setError(formatInvokeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listBackups();
        if (!cancelled) {
          setBackups(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleManualTake = async () => {
    setTaking(true);
    setActionMsg(null);
    setError(null);
    try {
      const record = await takeManualBackup();
      setActionMsg(`バックアップを取得しました (r${record.data_revision})`);
      await refresh();
    } catch (e) {
      setError(formatInvokeError(e));
    } finally {
      setTaking(false);
    }
  };

  const handleConfirmDelete = useCallback(async () => {
    if (deletingBackup == null) return;
    await deleteBackup(deletingBackup.path);
    await refresh();
    setActionMsg("バックアップを削除しました");
  }, [deletingBackup, refresh]);

  const handleConfirmRestore = useCallback(async () => {
    if (restoringBackup == null) return;
    await restoreBackup(restoringBackup.path);
    setRestartPrompt(true);
  }, [restoringBackup]);

  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} aria-label="戻る">
          <ArrowLeft size={14} aria-hidden /> 戻る
        </Button>
        <h1 className="text-lg font-semibold">設定</h1>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--fg)]">バックアップ</h2>
            <p className="text-[12px] text-[var(--fg-muted)]">
              SQLite Online Backup API で `&lt;userdata&gt;/backups/` 以下に保存 (auto: 起動時 24h
              ゲート、最新 10 / pre-op: 破壊操作直前、最新 30 / manual:
              下のボタンから、自動削除なし)
            </p>
          </div>
          <Button variant="primary" onClick={() => void handleManualTake()} disabled={taking}>
            <Plus size={14} aria-hidden />
            {taking ? "取得中..." : "今すぐバックアップ"}
          </Button>
        </div>

        {error != null && (
          <div
            role="alert"
            className="rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-2 text-[13px] text-[var(--destructive)]"
          >
            {error}
          </div>
        )}
        {actionMsg != null && (
          <div className="rounded-[var(--radius)] bg-[var(--bg-accent-soft)] p-2 text-[12px] text-[var(--accent)]">
            {actionMsg}
          </div>
        )}

        {loading ? (
          <p className="text-[13px] text-[var(--fg-subtle)]">読込中...</p>
        ) : backups.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-center text-[13px] text-[var(--fg-subtle)]">
            まだバックアップはありません。
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
            {backups.map((b) => (
              <BackupRow
                key={b.path}
                backup={b}
                onRestore={() => setRestoringBackup(b)}
                onDelete={() => setDeletingBackup(b)}
              />
            ))}
          </ul>
        )}
      </section>

      <ConfirmDeleteDialog
        open={deletingBackup != null}
        entityLabel="バックアップ"
        name={fileNameOf(deletingBackup?.path)}
        description={
          <>
            このバックアップファイルを物理削除します (auto / pre-op
            はローテーション対象から外れます)。
          </>
        }
        onClose={() => setDeletingBackup(null)}
        onConfirm={handleConfirmDelete}
      />
      <ConfirmDeleteDialog
        open={restoringBackup != null}
        entityLabel="リストア"
        name={fileNameOf(restoringBackup?.path)}
        description={
          <>
            <strong>このバックアップで現在の DB を上書きします。</strong>
            実行前に pre-restore バックアップが自動取得され、戻れる状態は確保されますが、
            完了後はアプリの再起動が必要です。
          </>
        }
        onClose={() => setRestoringBackup(null)}
        onConfirm={handleConfirmRestore}
      />

      {/* リストア完了後の再起動プロンプト (data-model.md §13.6 step 7) */}
      <Modal
        open={restartPrompt}
        onClose={() => {}}
        title="アプリを再起動してください"
        widthClassName="w-full max-w-md"
      >
        {restartPrompt && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-[var(--fg)]">
              バックアップからのリストアが完了しました。DB 接続をクリーンに作り直すため、 アプリを
              **手動で再起動** してください (Phase 1 では自動再起動を提供しません)。
            </p>
            <p className="text-[12px] text-[var(--fg-muted)]">
              戻る前の状態は <code className="font-mono">pre-restore-...</code>{" "}
              として保存されており、 必要なら再起動後にそのファイルからもう一度リストアできます。
            </p>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setRestartPrompt(false)}>
                了解
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function BackupRow({
  backup,
  onRestore,
  onDelete,
}: {
  backup: BackupRecord;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const kindLabel =
    backup.kind.type === "auto"
      ? "auto"
      : backup.kind.type === "manual"
        ? "manual"
        : `pre-op (${backup.kind.prefix})`;
  return (
    <li className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--bg-muted)]">
      <span className="rounded-full bg-[var(--bg-muted)] px-2 py-0.5 font-mono text-[11px] text-[var(--fg-muted)]">
        {kindLabel}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--fg)]" title={backup.path}>
          {fileNameOf(backup.path)}
        </p>
        <p className="text-[11px] text-[var(--fg-subtle)] tabular-nums">
          {backup.created_at.replace("T", " ").slice(0, 19)} · r{backup.data_revision} ·{" "}
          {formatBytes(backup.size_bytes)}
        </p>
      </div>
      <button
        type="button"
        aria-label="このバックアップに戻す"
        title="このバックアップに戻す"
        onClick={onRestore}
        className="inline-flex h-6 items-center gap-1 rounded-[var(--radius)] px-2 text-[12px] text-[var(--fg-muted)] hover:bg-[var(--bg)] hover:text-[var(--accent)]"
      >
        <RotateCcw size={13} aria-hidden /> 戻す
      </button>
      <button
        type="button"
        aria-label="削除"
        title="削除"
        onClick={onDelete}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg)] hover:text-[var(--destructive)]"
      >
        <Trash2 size={13} aria-hidden />
      </button>
    </li>
  );
}

function fileNameOf(path: string | undefined): string {
  if (path == null) return "";
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
