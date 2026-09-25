import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileImage, FolderOpen, ImageDown, Loader2, RotateCcw } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { inputClass, ToolPage, ToolPanel } from "@/components/ui/ToolPage";
import {
  DEFAULT_QUALITY_MAX,
  DEFAULT_QUALITY_MIN,
  DEFAULT_SPEED,
  MAX_PNG_FOLDER_FILES,
  type PngOptFileResult,
  type PngOptFolderResult,
  type PngOptOutputMode,
  type PngOptProgress,
  type PngOptScanResult,
  type PngOptSettings,
  cancelPngOptOperation,
  pngOptOptimizeFile,
  pngOptOptimizeFolder,
  pngOptScanFolder,
} from "@/ipc/pngopt";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";

import { defaultOutputPath, statusMessage, validateSettings } from "./format";

type Tab = "file" | "folder";

type FileEvent = Extract<PngOptProgress, { type: "file" }>;

interface ActiveOperation {
  id: string;
  kind: "file" | "folder";
  completed: number;
  total: number;
  current: string | null;
  cancelling: boolean;
}

interface PendingConfirmation {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  run: () => void;
}

const DEFAULT_SETTINGS: PngOptSettings = {
  qualityMin: DEFAULT_QUALITY_MIN,
  qualityMax: DEFAULT_QUALITY_MAX,
  speed: DEFAULT_SPEED,
};

/** 一覧に出す「元のまま・失敗」のファイル数の上限 (残りは件数だけ示す) */
const MAX_LISTED_ISSUES = 200;

export function PngOptPage() {
  const [tab, setTab] = useState<Tab>("file");
  const [settings, setSettings] = useState<PngOptSettings>(DEFAULT_SETTINGS);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileMode, setFileMode] = useState<PngOptOutputMode>("separate");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderMode, setFolderMode] = useState<PngOptOutputMode>("separate");
  const [outputFolder, setOutputFolder] = useState<string | null>(null);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [fileResult, setFileResult] = useState<PngOptFileResult | null>(null);
  const [folderResult, setFolderResult] = useState<PngOptFolderResult | null>(null);
  const [folderEvents, setFolderEvents] = useState<FileEvent[]>([]);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef(operation);
  const tabRef = useRef(tab);
  const mountedRef = useRef(true);

  const replaceOperation = useCallback((next: ActiveOperation | null) => {
    operationRef.current = next;
    setOperation(next);
  }, []);

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = operationRef.current;
      if (active != null) void cancelPngOptOperation(active.id).catch(() => undefined);
    };
  }, []);

  const clearResults = useCallback(() => {
    setError(null);
    setFileResult(null);
    setFolderResult(null);
    setFolderEvents([]);
  }, []);

  const acceptDroppedPath = useCallback(
    (path: string) => {
      if (operationRef.current != null) return;
      clearResults();
      if (tabRef.current === "file") setFilePath(path);
      else setFolderPath(path);
    },
    [clearResults],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setDragOver(true);
        } else if (event.payload.type === "drop") {
          setDragOver(false);
          const [first] = event.payload.paths;
          if (first != null) acceptDroppedPath(first);
        } else {
          setDragOver(false);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(formatPngOptError(cause));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [acceptDroppedPath]);

  const chooseFile = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (typeof selected === "string" && mountedRef.current) {
        clearResults();
        setFilePath(selected);
      }
    } catch (cause) {
      if (mountedRef.current) setError(formatPngOptError(cause));
    }
  }, [clearResults]);

  const chooseFolder = useCallback(
    async (target: "input" | "output") => {
      try {
        const selected = await openDialog({ multiple: false, directory: true });
        if (typeof selected !== "string" || !mountedRef.current) return;
        clearResults();
        if (target === "input") setFolderPath(selected);
        else setOutputFolder(selected);
      } catch (cause) {
        if (mountedRef.current) setError(formatPngOptError(cause));
      }
    },
    [clearResults],
  );

  const cancelActive = useCallback(async () => {
    const active = operationRef.current;
    if (active == null) return;
    replaceOperation({ ...active, cancelling: true });
    try {
      await cancelPngOptOperation(active.id);
    } catch (cause) {
      if (mountedRef.current && isCurrentOperation(operationRef.current, active.id)) {
        replaceOperation({ ...active, cancelling: false });
        setError(formatPngOptError(cause));
      }
    }
  }, [replaceOperation]);

  const runFile = useCallback(
    async (inputPath: string, outputPath: string) => {
      if (operationRef.current != null) return;
      const operationId = crypto.randomUUID();
      replaceOperation({
        id: operationId,
        kind: "file",
        completed: 0,
        total: 1,
        current: fileNameOf(inputPath),
        cancelling: false,
      });
      clearResults();
      try {
        const result = await pngOptOptimizeFile({ operationId, inputPath, outputPath, settings });
        if (mountedRef.current && isCurrentOperation(operationRef.current, operationId))
          setFileResult(result);
      } catch (cause) {
        if (!isCancelledError(cause) && mountedRef.current) setError(formatPngOptError(cause));
      } finally {
        if (mountedRef.current && isCurrentOperation(operationRef.current, operationId))
          replaceOperation(null);
      }
    },
    [clearResults, replaceOperation, settings],
  );

  const startFile = useCallback(async () => {
    if (filePath == null || operationRef.current != null) return;
    if (fileMode === "overwrite") {
      setConfirmation({
        title: "元のファイルを上書きしますか？",
        body: (
          <p>
            <span className="font-medium">{fileNameOf(filePath)}</span>{" "}
            を最適化したPNGで置き換えます。非可逆の圧縮なので、元には戻せません。
          </p>
        ),
        confirmLabel: "上書きして最適化",
        run: () => void runFile(filePath, filePath),
      });
      return;
    }
    let outputPath: string | null;
    try {
      outputPath = await saveDialog({
        defaultPath: defaultOutputPath(filePath),
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
    } catch (cause) {
      if (mountedRef.current) setError(formatPngOptError(cause));
      return;
    }
    if (outputPath != null && mountedRef.current) await runFile(filePath, outputPath);
  }, [fileMode, filePath, runFile]);

  const runFolder = useCallback(
    async (inputFolder: string, mode: PngOptOutputMode, target: string | null) => {
      if (operationRef.current != null) return;
      const operationId = crypto.randomUUID();
      replaceOperation({
        id: operationId,
        kind: "folder",
        completed: 0,
        total: 0,
        current: null,
        cancelling: false,
      });
      clearResults();
      const events: FileEvent[] = [];
      try {
        const result = await pngOptOptimizeFolder({
          operationId,
          folderPath: inputFolder,
          outputMode: mode,
          outputFolder: target,
          settings,
          onProgress: (progress) => {
            const current = operationRef.current;
            if (current?.id !== operationId || !mountedRef.current) return;
            if (progress.type === "started") {
              replaceOperation({ ...current, total: progress.total });
            } else if (progress.type === "file") {
              events.push(progress);
              setFolderEvents([...events]);
              replaceOperation({
                ...current,
                completed: progress.index + 1,
                total: progress.total,
                current: progress.name,
              });
            }
          },
        });
        if (mountedRef.current && isCurrentOperation(operationRef.current, operationId)) {
          setFolderResult(result);
        }
      } catch (cause) {
        if (!mountedRef.current) return;
        if (isCancelledError(cause)) {
          setError(
            `キャンセルしました。処理済みの${events.length}ファイルはそのまま残っています。`,
          );
        } else {
          setError(formatPngOptError(cause));
        }
      } finally {
        if (mountedRef.current && isCurrentOperation(operationRef.current, operationId))
          replaceOperation(null);
      }
    },
    [clearResults, replaceOperation, settings],
  );

  const startFolder = useCallback(async () => {
    if (folderPath == null || operationRef.current != null) return;
    const target = folderMode === "separate" ? outputFolder : null;
    let scan: PngOptScanResult;
    try {
      scan = await pngOptScanFolder({ folderPath, outputMode: folderMode, outputFolder: target });
    } catch (cause) {
      if (mountedRef.current) setError(formatPngOptError(cause));
      return;
    }
    if (!mountedRef.current) return;
    if (scan.file_count === 0) {
      setError("フォルダの直下にPNGファイルがありません。");
      return;
    }
    setConfirmation({
      title: `${scan.file_count.toLocaleString()}ファイルを最適化しますか？`,
      body: (
        <ul className="space-y-1">
          <li>
            対象: フォルダ直下のPNG {scan.file_count.toLocaleString()}ファイル (
            {formatBytes(scan.input_bytes)})
          </li>
          {scan.skipped_count > 0 && (
            <li>対象外: {scan.skipped_count.toLocaleString()}件 (PNG以外・サブフォルダなど)</li>
          )}
          {folderMode === "overwrite" ? (
            <li className="font-medium text-[var(--destructive)]">
              元のファイルを最適化したPNGで上書きします。元には戻せません。
            </li>
          ) : (
            scan.conflict_count > 0 && (
              <li className="font-medium text-[var(--destructive)]">
                出力先にある同じ名前の{scan.conflict_count.toLocaleString()}
                ファイルを上書きします。
              </li>
            )
          )}
        </ul>
      ),
      confirmLabel: folderMode === "overwrite" ? "上書きして最適化" : "最適化",
      run: () => void runFolder(folderPath, folderMode, target),
    });
  }, [folderMode, folderPath, outputFolder, runFolder]);

  const busy = operation != null;
  const settingsError = validateSettings(settings);
  const canRunFile = filePath != null && settingsError == null && !busy;
  const canRunFolder =
    folderPath != null &&
    (folderMode === "overwrite" || outputFolder != null) &&
    settingsError == null &&
    !busy;

  return (
    <ToolPage
      title="PNG最適化"
      description="shotq でPNGを非可逆に圧縮します。既定の設定は shotq --quality=70-85 --speed 11 と同じ結果になります。"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-6">
        <div className="flex gap-1.5" role="group" aria-label="処理の単位">
          <SegmentButton selected={tab === "file"} disabled={busy} onClick={() => setTab("file")}>
            <FileImage size={14} aria-hidden /> 1ファイル
          </SegmentButton>
          <SegmentButton
            selected={tab === "folder"}
            disabled={busy}
            onClick={() => setTab("folder")}
          >
            <FolderOpen size={14} aria-hidden /> フォルダ
          </SegmentButton>
        </div>

        <ToolPanel title={tab === "file" ? "入力PNG" : "入力フォルダ"}>
          <div
            className={cn(
              "flex min-h-20 flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed px-4 py-3 text-center transition-colors",
              dragOver
                ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--bg-muted)] text-[var(--fg-muted)]",
            )}
            aria-label={tab === "file" ? "PNGファイルのドロップ領域" : "フォルダのドロップ領域"}
          >
            {tab === "file" ? (
              <PathLine path={filePath} placeholder="PNGファイルをここへドロップ" />
            ) : (
              <PathLine
                path={folderPath}
                placeholder="フォルダをここへドロップ (直下のPNGだけを処理します)"
              />
            )}
            <Button
              size="sm"
              onClick={() => void (tab === "file" ? chooseFile() : chooseFolder("input"))}
              disabled={busy}
            >
              {tab === "file" ? "PNGを選択" : "フォルダを選択"}
            </Button>
          </div>
        </ToolPanel>

        <ToolPanel
          title="設定"
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSettings(DEFAULT_SETTINGS)}
              disabled={busy}
            >
              <RotateCcw size={14} aria-hidden /> 既定に戻す
            </Button>
          }
        >
          <div className="flex flex-wrap items-end gap-4">
            <NumberField
              label="品質の下限"
              min={0}
              max={100}
              value={settings.qualityMin}
              disabled={busy}
              onChange={(qualityMin) => setSettings({ ...settings, qualityMin })}
            />
            <NumberField
              label="品質の上限"
              min={0}
              max={100}
              value={settings.qualityMax}
              disabled={busy}
              onChange={(qualityMax) => setSettings({ ...settings, qualityMax })}
            />
            <NumberField
              label="速度 (1〜11)"
              min={1}
              max={11}
              value={settings.speed}
              disabled={busy}
              onChange={(speed) => setSettings({ ...settings, speed })}
            />
          </div>
          <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
            品質が下限に届かない画像と、小さくならない画像は元のまま残します。速度は11が最速です。
          </p>
          {settingsError != null && (
            <p role="alert" className="mt-2 text-[12px] text-[var(--destructive)]">
              {settingsError}
            </p>
          )}
        </ToolPanel>

        <ToolPanel title="出力">
          {tab === "file" ? (
            <ModeChoice
              name="file-output"
              value={fileMode}
              disabled={busy}
              onChange={setFileMode}
              separateLabel="別名で保存"
            />
          ) : (
            <>
              <ModeChoice
                name="folder-output"
                value={folderMode}
                disabled={busy}
                onChange={setFolderMode}
                separateLabel="別のフォルダに同じ名前で保存"
              />
              {folderMode === "separate" && (
                <div className="mt-3 flex items-center gap-2">
                  <PathLine path={outputFolder} placeholder="出力先のフォルダを選んでください" />
                  <Button size="sm" onClick={() => void chooseFolder("output")} disabled={busy}>
                    出力先を選択
                  </Button>
                </div>
              )}
              <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
                サブフォルダ、隠しファイル、シンボリックリンクは処理しません。1回に
                {MAX_PNG_FOLDER_FILES.toLocaleString()}ファイルまでです。
              </p>
            </>
          )}

          {operation != null && (
            <OperationProgress operation={operation} onCancel={() => void cancelActive()} />
          )}

          {error != null && (
            <p
              role="alert"
              className="mt-3 rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-3 text-[12px] text-[var(--destructive)]"
            >
              {error}
            </p>
          )}

          {fileResult != null && operation == null && <FileResultView result={fileResult} />}
          {folderResult != null && operation == null && (
            <FolderResultView result={folderResult} events={folderEvents} />
          )}

          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              onClick={() => void (tab === "file" ? startFile() : startFolder())}
              disabled={tab === "file" ? !canRunFile : !canRunFolder}
            >
              {busy ? (
                <Loader2 className="animate-spin" size={14} aria-hidden />
              ) : (
                <ImageDown size={14} aria-hidden />
              )}
              最適化
            </Button>
          </div>
        </ToolPanel>
      </div>

      <Modal
        open={confirmation != null}
        onClose={() => setConfirmation(null)}
        title={confirmation?.title ?? ""}
      >
        {confirmation != null && (
          <div className="text-[13px] text-[var(--fg)]">
            {confirmation.body}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmation(null)}>
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const pending = confirmation;
                  setConfirmation(null);
                  pending.run();
                }}
              >
                {confirmation.confirmLabel}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </ToolPage>
  );
}

function SegmentButton({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-[var(--radius)] border px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
          : "border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--bg-muted)]",
      )}
    >
      {children}
    </button>
  );
}

function PathLine({ path, placeholder }: { path: string | null; placeholder: string }) {
  return path == null ? (
    <p className="text-[13px] font-medium">{placeholder}</p>
  ) : (
    <p className="max-w-full truncate text-[13px] font-medium text-[var(--fg)]" title={path}>
      {path}
    </p>
  );
}

function NumberField({
  label,
  min,
  max,
  value,
  disabled,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="text-[12px]">
      {label}
      <input
        className={`${inputClass} mt-1 block w-24`}
        type="number"
        min={min}
        max={max}
        step={1}
        value={Number.isNaN(value) ? "" : value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

function ModeChoice({
  name,
  value,
  disabled,
  onChange,
  separateLabel,
}: {
  name: string;
  value: PngOptOutputMode;
  disabled: boolean;
  onChange: (mode: PngOptOutputMode) => void;
  separateLabel: string;
}) {
  const options: { mode: PngOptOutputMode; label: string }[] = [
    { mode: "separate", label: separateLabel },
    { mode: "overwrite", label: "元のファイルを上書き" },
  ];
  return (
    <fieldset className="flex flex-wrap gap-4 text-[13px]" disabled={disabled}>
      <legend className="sr-only">出力先</legend>
      {options.map((option) => (
        <label key={option.mode} className="inline-flex items-center gap-1.5">
          <input
            type="radio"
            name={name}
            checked={value === option.mode}
            onChange={() => onChange(option.mode)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function OperationProgress({
  operation,
  onCancel,
}: {
  operation: ActiveOperation;
  onCancel: () => void;
}) {
  const label =
    operation.kind === "file"
      ? `${operation.current ?? "PNG"} を最適化しています...`
      : operation.total === 0
        ? "フォルダを確認しています..."
        : `${operation.completed.toLocaleString()} / ${operation.total.toLocaleString()} ファイル${
            operation.current != null ? ` · ${operation.current}` : ""
          }`;
  const max = Math.max(operation.total, 1);
  return (
    <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-3">
      <div className="flex items-center justify-between gap-3">
        <p
          className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--fg)]"
          aria-live="polite"
        >
          <Loader2 className="shrink-0 animate-spin" size={14} aria-hidden />
          <span className="truncate">{label}</span>
        </p>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={operation.cancelling}>
          {operation.cancelling ? "キャンセル中..." : "キャンセル"}
        </Button>
      </div>
      {operation.kind === "folder" && (
        <div
          role="progressbar"
          aria-label="PNG最適化の進捗"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={operation.completed}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
        >
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width]"
            style={{ width: `${Math.round((operation.completed / max) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function FileResultView({ result }: { result: PngOptFileResult }) {
  const optimized = result.status === "optimized";
  return (
    <div
      role="status"
      className={cn(
        "mt-3 rounded-[var(--radius)] border p-3 text-[12px] text-[var(--fg)]",
        optimized
          ? "border-emerald-500/50 bg-emerald-500/10"
          : "border-amber-500/50 bg-amber-500/10",
      )}
    >
      <p className="font-semibold">{statusMessage(result.status)}</p>
      <p className="mt-1 text-[var(--fg-muted)]">
        {formatBytes(result.input_bytes)} → {formatBytes(result.output_bytes)}
        {optimized && ` (${reductionPercent(result.input_bytes, result.output_bytes)}削減)`} ·{" "}
        {result.width}×{result.height} · {result.duration_ms} ms
      </p>
      <p className="mt-1 truncate text-[var(--fg-muted)]" title={result.output_path}>
        {result.output_path}
      </p>
      {result.detail !== "" && <Detail text={result.detail} />}
    </div>
  );
}

function FolderResultView({ result, events }: { result: PngOptFolderResult; events: FileEvent[] }) {
  const issues = events.filter((event) => event.status !== "optimized");
  return (
    <div
      role="status"
      className={cn(
        "mt-3 rounded-[var(--radius)] border p-3 text-[12px] text-[var(--fg)]",
        result.failed === 0
          ? "border-emerald-500/50 bg-emerald-500/10"
          : "border-amber-500/50 bg-amber-500/10",
      )}
    >
      <p className="font-semibold">{result.total.toLocaleString()}ファイルを処理しました</p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[var(--fg-muted)]">
        <li>最適化: {result.optimized.toLocaleString()}</li>
        <li>品質が下限未満で元のまま: {result.quality_too_low.toLocaleString()}</li>
        <li>小さくならず元のまま: {result.not_smaller.toLocaleString()}</li>
        <li>失敗: {result.failed.toLocaleString()}</li>
      </ul>
      <p className="mt-1 text-[var(--fg-muted)]">
        {formatBytes(result.input_bytes)} → {formatBytes(result.output_bytes)} (
        {reductionPercent(result.input_bytes, result.output_bytes)}削減) · {result.duration_ms} ms
      </p>
      {issues.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer">
            元のまま・失敗のファイル ({issues.length.toLocaleString()})
          </summary>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto">
            {issues.slice(0, MAX_LISTED_ISSUES).map((event) => (
              <li key={event.index}>
                <span className="font-medium">{event.name}</span>: {statusMessage(event.status)}
                {event.status === "failed" && event.detail !== "" && ` (${event.detail})`}
              </li>
            ))}
            {issues.length > MAX_LISTED_ISSUES && (
              <li>ほか{(issues.length - MAX_LISTED_ISSUES).toLocaleString()}ファイル</li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

function Detail({ text }: { text: string }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[var(--fg-subtle)]">詳細</summary>
      <p className="mt-1 font-mono text-[11px] break-all text-[var(--fg-muted)]">{text}</p>
    </details>
  );
}

function reductionPercent(inputBytes: number, outputBytes: number): string {
  if (inputBytes === 0) return "0%";
  return `${Math.round((1 - outputBytes / inputBytes) * 100)}%`;
}

function isCurrentOperation(operation: ActiveOperation | null, operationId: string): boolean {
  return operation?.id === operationId;
}

function isCancelledError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "cancelled"
  );
}

function formatPngOptError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "object" && message !== null && "reason" in message) {
      const reason = (message as { reason?: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return formatInvokeError(cause);
}

function fileNameOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
