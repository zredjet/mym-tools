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
import { ArrowLeft, Download, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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
import {
  exportJson,
  importJson,
  type ExportDataMeta,
  type ImportSummary,
  suggestExportFileName,
} from "@/ipc/transfer";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import {
  ROW_DENSITY_PX,
  type RowDensity,
  UI_SCALE_PRESETS,
  useAppStore,
} from "@/store/useAppStore";

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
    <div className="flex h-full flex-col gap-6 px-[var(--page-pad)] py-6">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} aria-label="戻る">
          <ArrowLeft size={14} aria-hidden /> 戻る
        </Button>
        <h1 className="text-lg font-semibold">設定</h1>
      </header>

      <UiScaleSection />

      <RowDensitySection />

      <SidebarWidthInfo />

      <DataTransferSection />

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

/**
 * UI 全体スケール設定セクション (PR-X、案 B)。
 * `body { zoom: var(--ui-scale) }` 経由で文字 / spacing / swatch / モーダル幅まで
 * 一括拡縮。プリセットボタンで段階指定 + 「リセット」で 100% に戻す。
 */
function UiScaleSection() {
  const uiScale = useAppStore((s) => s.uiScale);
  const setUiScale = useAppStore((s) => s.setUiScale);
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-base font-semibold text-[var(--fg)]">表示</h2>
        <p className="text-[12px] text-[var(--fg-muted)]">
          UI 全体のスケール (文字 / spacing / 色見本 / モーダル幅などすべて一緒に拡縮)。 値は
          localStorage に保存され、再起動後も維持されます。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-[var(--fg-subtle)]">UI スケール:</span>
        {UI_SCALE_PRESETS.map((preset) => {
          const selected = Math.abs(uiScale - preset) < 0.001;
          return (
            <button
              key={preset}
              type="button"
              onClick={() => setUiScale(preset)}
              className={cn(
                "h-7 rounded-[var(--radius)] border px-2.5 font-mono text-[12px] transition-colors",
                selected
                  ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--bg-muted)]",
              )}
              aria-pressed={selected}
            >
              {Math.round(preset * 100)}%
            </button>
          );
        })}
        <span className="ml-2 text-[11px] text-[var(--fg-subtle)] tabular-nums">
          現在: {Math.round(uiScale * 100)}%
        </span>
      </div>
    </section>
  );
}

/**
 * 行高密度切替 (`docs/ui-design.md` §2.3、PR-AA)。
 * `--row-h` を 32 / 36 px に切り替える。Sidebar 行高 + Prompt / LinkMemo の
 * リスト行に効く (Color はスウォッチ grid なので影響なし)。
 */
function RowDensitySection() {
  const rowDensity = useAppStore((s) => s.rowDensity);
  const setRowDensity = useAppStore((s) => s.setRowDensity);
  const options: { value: RowDensity; label: string; sub: string }[] = [
    { value: "compact", label: "Compact", sub: `${ROW_DENSITY_PX.compact}px (default)` },
    { value: "comfortable", label: "Comfortable", sub: `${ROW_DENSITY_PX.comfortable}px` },
  ];
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-base font-semibold text-[var(--fg)]">行高 (Density)</h2>
        <p className="text-[12px] text-[var(--fg-muted)]">
          Sidebar / リスト行の高さ。Compact = 32px (Linear 寄り)、Comfortable = 36px
          (タップ・視認性優先)。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {options.map((opt) => {
          const selected = rowDensity === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setRowDensity(opt.value)}
              aria-pressed={selected}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-[var(--radius)] border px-3 text-[12px] transition-colors",
                selected
                  ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--bg-muted)]",
              )}
            >
              <span className="font-medium">{opt.label}</span>
              <span className="font-mono text-[var(--fg-subtle)]">{opt.sub}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * サイドバー幅の表示専用セクション (PR-AA)。
 * 値はサイドバー右端を D&D してリアルタイム調整 (180-320px、`docs/ui-design.md`
 * §2.3)。Settings 側にスライダーを置くより、結果を見ながら掴む方が直感的なので
 * ここでは現在値の表示と「デフォルトに戻す」ボタンのみを提供する。
 */
function SidebarWidthInfo() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const isDefault = sidebarWidth === 240;
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-base font-semibold text-[var(--fg)]">サイドバー幅</h2>
        <p className="text-[12px] text-[var(--fg-muted)]">
          サイドバー右端をドラッグして調整できます (180-320px)。キーボード操作は ←/→ で
          8px、Shift+←/→ で 32px、Home/End で最小/最大に。
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[12px] text-[var(--fg)] tabular-nums">
          現在: {sidebarWidth}px
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSidebarWidth(240)}
          disabled={isDefault}
        >
          デフォルト (240px) に戻す
        </Button>
      </div>
    </section>
  );
}

/**
 * Export / Import JSON セクション (`docs/data-model.md` §12、PR-Z)。
 *
 * - **Export**: save ダイアログ → `core_export_json(path)` → メタ表示
 * - **Import**: open ダイアログ → `core_import_json(path)` → サマリ表示
 *   (バックエンドが自動で pre-import バックアップを取る)
 *
 * 部分成功方式 (`data-model.md` §12.3) の結果は失敗件数 + 失敗内訳の畳んだリストで表示。
 */
function DataTransferSection() {
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportMeta, setExportMeta] = useState<ExportDataMeta | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  const handleExport = async () => {
    setError(null);
    setExportMeta(null);
    setImportSummary(null);
    try {
      const path = await saveDialog({
        title: "MyMyTools エクスポート先",
        defaultPath: suggestExportFileName(),
        filters: [{ name: "MyMyTools JSON", extensions: ["mymtools.json", "json"] }],
      });
      if (path == null) return; // ユーザーキャンセル
      setBusy("export");
      const meta = await exportJson(path);
      setExportMeta(meta);
    } catch (e) {
      setError(formatInvokeError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    setError(null);
    setExportMeta(null);
    setImportSummary(null);
    try {
      const path = await openDialog({
        title: "MyMyTools インポート元",
        multiple: false,
        filters: [{ name: "MyMyTools JSON", extensions: ["mymtools.json", "json"] }],
      });
      if (path == null || Array.isArray(path)) return; // ユーザーキャンセル / 想定外
      setBusy("import");
      const summary = await importJson(path);
      setImportSummary(summary);
    } catch (e) {
      setError(formatInvokeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-[var(--fg)]">データの可搬</h2>
        <p className="text-[12px] text-[var(--fg-muted)]">
          全プロジェクト + 全モジュールアイテム (Prompts / Links / Colors) を 1 つの JSON
          ファイルに出し入れします (D-05 / <code className="font-mono">.mymtools.json</code>)。Hash
          は stateless のため対象外。 インポートは <strong>部分成功方式</strong>:
          衝突や個別失敗はスキップ + 集計に 記録し、残りは継続。実行前に{" "}
          <code className="font-mono">pre-import</code> バックアップが自動取得されます。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => void handleExport()} disabled={busy != null}>
          <Download size={14} aria-hidden />
          {busy === "export" ? "エクスポート中..." : "JSON にエクスポート"}
        </Button>
        <Button variant="secondary" onClick={() => void handleImport()} disabled={busy != null}>
          <Upload size={14} aria-hidden />
          {busy === "import" ? "インポート中..." : "JSON からインポート"}
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

      {exportMeta != null && (
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-[12px] text-[var(--fg)]">
          <p className="font-medium">エクスポート完了</p>
          <p className="text-[var(--fg-muted)] tabular-nums">
            プロジェクト {exportMeta.projects.length} 件 / アイテム合計{" "}
            {exportMeta.projects.reduce((n, p) => n + p.items.length, 0)} 件 (
            {exportMeta.exported_at.slice(0, 19).replace("T", " ")} JST)
          </p>
        </div>
      )}

      {importSummary != null && <ImportSummaryView summary={importSummary} />}
    </section>
  );
}

function ImportSummaryView({ summary }: { summary: ImportSummary }) {
  const [showFailures, setShowFailures] = useState(false);
  const totalFailed = summary.projects_failed + summary.items_failed;
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-[12px] text-[var(--fg)]">
      <p className="font-medium">インポート完了</p>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[var(--fg-muted)] tabular-nums">
        <span>
          プロジェクト: 投入 {summary.projects_inserted} / スキップ {summary.projects_skipped} /
          失敗 {summary.projects_failed}
        </span>
        <span>
          アイテム: 投入 {summary.items_inserted} / スキップ {summary.items_skipped} / 失敗{" "}
          {summary.items_failed}
        </span>
      </div>
      {totalFailed > 0 && summary.failures.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            className="text-[12px] text-[var(--accent)] underline"
            onClick={() => setShowFailures((v) => !v)}
          >
            {showFailures ? "▼ 失敗内訳を隠す" : `▶ 失敗内訳を表示 (${summary.failures.length})`}
          </button>
          {showFailures && (
            <ul className="mt-1 max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[11px] text-[var(--fg)]">
              {summary.failures.map((f, idx) => (
                <li
                  key={`${f.entity}-${f.id}-${idx}`}
                  className="border-b border-dashed border-[var(--border)] py-1 last:border-0"
                >
                  [{f.entity}
                  {f.module_id != null && `/${f.module_id}`}] {f.id}: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
