import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  FilePlus2,
  Files,
  GripVertical,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/Button";
import { ToolPage, ToolPanel } from "@/components/ui/ToolPage";
import {
  MAX_PDF_INPUT_FILES,
  MAX_PDF_TOTAL_BYTES,
  type PdfInputInfo,
  type PdfInspectIssue,
  type PdfMergeProgress,
  type PdfMergeResult,
  cancelPdfMergeOperation,
  pdfMergeFiles,
  pdfMergeInspectFiles,
} from "@/ipc/pdfmerge";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";

interface PdfListEntry extends PdfInputInfo {
  id: string;
}

interface ActiveOperation {
  id: string;
  kind: "inspect" | "merge";
  progress: PdfMergeProgress | null;
  cancelling: boolean;
}

export function PdfMergePage() {
  const [files, setFiles] = useState<PdfListEntry[]>([]);
  const [issues, setIssues] = useState<PdfInspectIssue[]>([]);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfMergeResult | null>(null);
  const filesRef = useRef(files);
  const operationRef = useRef(operation);
  const mountedRef = useRef(true);

  const replaceFiles = useCallback((next: PdfListEntry[]) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  const replaceOperation = useCallback((next: ActiveOperation | null) => {
    operationRef.current = next;
    setOperation(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = operationRef.current;
      if (active != null) void cancelPdfMergeOperation(active.id).catch(() => undefined);
    };
  }, []);

  const applyProgress = useCallback(
    (operationId: string, progress: PdfMergeProgress) => {
      const current = operationRef.current;
      if (current == null || current.id !== operationId || !mountedRef.current) return;
      replaceOperation({ ...current, progress });
    },
    [replaceOperation],
  );

  const inspectPaths = useCallback(
    async (paths: string[]) => {
      if (!mountedRef.current || paths.length === 0 || operationRef.current != null) return;
      const operationId = crypto.randomUUID();
      replaceOperation({ id: operationId, kind: "inspect", progress: null, cancelling: false });
      setError(null);
      setResult(null);
      setIssues([]);
      try {
        const inspected = await pdfMergeInspectFiles({
          operationId,
          paths,
          onProgress: (progress) => applyProgress(operationId, progress),
        });
        if (!mountedRef.current || !isCurrentOperation(operationRef.current, operationId)) return;

        const next = [...filesRef.current];
        const rejected = [...inspected.rejected];
        let totalBytes = next.reduce((sum, file) => sum + file.size_bytes, 0);
        for (const info of inspected.accepted) {
          if (next.length >= MAX_PDF_INPUT_FILES) {
            rejected.push({
              path: info.path,
              reason: `PDFは最大${MAX_PDF_INPUT_FILES}ファイルまでです。`,
            });
          } else if (totalBytes + info.size_bytes > MAX_PDF_TOTAL_BYTES) {
            rejected.push({
              path: info.path,
              reason: "入力PDFの合計は200 MiB以下にしてください。",
            });
          } else {
            next.push({ ...info, id: crypto.randomUUID() });
            totalBytes += info.size_bytes;
          }
        }
        replaceFiles(next);
        setIssues(rejected);
      } catch (cause) {
        if (!isCancelledError(cause) && mountedRef.current) {
          setError(formatPdfMergeError(cause));
        }
      } finally {
        if (mountedRef.current && isCurrentOperation(operationRef.current, operationId)) {
          replaceOperation(null);
        }
      }
    },
    [applyProgress, replaceFiles, replaceOperation],
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
          if (operationRef.current == null) void inspectPaths(event.payload.paths);
        } else {
          setDragOver(false);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(formatPdfMergeError(cause));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [inspectPaths]);

  const addFiles = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        directory: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (selected == null || !mountedRef.current) return;
      await inspectPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (cause) {
      if (mountedRef.current) setError(formatPdfMergeError(cause));
    }
  }, [inspectPaths]);

  const cancelActive = useCallback(async () => {
    const active = operationRef.current;
    if (active == null) return;
    replaceOperation({ ...active, cancelling: true });
    try {
      await cancelPdfMergeOperation(active.id);
    } catch (cause) {
      if (mountedRef.current && isCurrentOperation(operationRef.current, active.id)) {
        replaceOperation({ ...active, cancelling: false });
        setError(formatPdfMergeError(cause));
      }
    }
  }, [replaceOperation]);

  const mergeAndSave = useCallback(async () => {
    if (filesRef.current.length < 2 || operationRef.current != null) return;
    let outputPath: string | null;
    try {
      outputPath = await saveDialog({
        defaultPath: "merged.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
    } catch (cause) {
      if (mountedRef.current) setError(formatPdfMergeError(cause));
      return;
    }
    if (outputPath == null || !mountedRef.current) return;

    const operationId = crypto.randomUUID();
    replaceOperation({ id: operationId, kind: "merge", progress: null, cancelling: false });
    setError(null);
    setResult(null);
    try {
      const merged = await pdfMergeFiles({
        operationId,
        inputPaths: filesRef.current.map((file) => file.path),
        outputPath,
        onProgress: (progress) => applyProgress(operationId, progress),
      });
      if (mountedRef.current && isCurrentOperation(operationRef.current, operationId)) {
        setResult(merged);
      }
    } catch (cause) {
      if (!isCancelledError(cause) && mountedRef.current) {
        setError(formatPdfMergeError(cause));
      }
    } finally {
      if (mountedRef.current && isCurrentOperation(operationRef.current, operationId)) {
        replaceOperation(null);
      }
    }
  }, [applyProgress, replaceOperation]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (event.over == null || event.active.id === event.over.id || operationRef.current != null)
        return;
      const current = filesRef.current;
      const from = current.findIndex((file) => file.id === event.active.id);
      const to = current.findIndex((file) => file.id === event.over?.id);
      if (from >= 0 && to >= 0) {
        replaceFiles(arrayMove(current, from, to));
        setResult(null);
      }
    },
    [replaceFiles],
  );

  const moveFile = useCallback(
    (index: number, direction: -1 | 1) => {
      if (operationRef.current != null) return;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= filesRef.current.length) return;
      replaceFiles(arrayMove(filesRef.current, index, nextIndex));
      setResult(null);
    },
    [replaceFiles],
  );

  const removeFile = useCallback(
    (id: string) => {
      if (operationRef.current != null) return;
      replaceFiles(filesRef.current.filter((file) => file.id !== id));
      setResult(null);
    },
    [replaceFiles],
  );

  const totalPages = useMemo(() => files.reduce((sum, file) => sum + file.page_count, 0), [files]);
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size_bytes, 0), [files]);
  const busy = operation != null;

  return (
    <ToolPage
      title="PDF結合"
      description="複数のPDFを並べ替え、1つのPDFとしてローカルに保存します。"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-6">
        <ToolPanel
          title={`入力PDF · ${files.length}/${MAX_PDF_INPUT_FILES}`}
          actions={
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void addFiles()} disabled={busy}>
                <FilePlus2 size={14} aria-hidden /> PDFを追加
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  replaceFiles([]);
                  setIssues([]);
                  setResult(null);
                }}
                disabled={busy || files.length === 0}
              >
                <X size={14} aria-hidden /> 全消去
              </Button>
            </div>
          }
        >
          <div
            className={cn(
              "mb-3 flex min-h-20 items-center justify-center rounded-[var(--radius)] border border-dashed px-4 text-center transition-colors",
              dragOver
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--bg-muted)] text-[var(--fg-muted)]",
            )}
            aria-label="PDFファイルのドロップ領域"
          >
            <div>
              <Files className="mx-auto mb-1" size={22} aria-hidden />
              <p className="text-[13px] font-medium">
                {dragOver ? "ここにドロップして追加" : "PDFファイルをここへドロップ"}
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">
                最大50ファイル・合計200 MiB
              </p>
            </div>
          </div>

          {files.length === 0 ? (
            <p className="py-5 text-center text-[13px] text-[var(--fg-subtle)]">
              結合するPDFを2ファイル以上追加してください。
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={files.map((file) => file.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="space-y-2" aria-label="結合順序">
                  {files.map((file, index) => (
                    <SortablePdfRow
                      key={file.id}
                      file={file}
                      index={index}
                      count={files.length}
                      disabled={busy}
                      onMove={moveFile}
                      onRemove={removeFile}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}

          {files.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--border)] pt-3 text-[12px] text-[var(--fg-muted)]">
              <span>合計 {totalPages.toLocaleString()}ページ</span>
              <span>{formatBytes(totalBytes)}</span>
              <span>上から順に結合されます</span>
            </div>
          )}
        </ToolPanel>

        {issues.length > 0 && (
          <div
            role="alert"
            className="rounded-[var(--radius)] border border-amber-500/50 bg-amber-500/10 p-3 text-[12px] text-[var(--fg)]"
          >
            <p className="font-semibold">追加できなかったファイルがあります</p>
            <ul className="mt-1.5 space-y-1">
              {issues.map((issue, index) => (
                <li key={`${issue.path}:${index}`}>
                  <span className="font-medium">{fileNameOf(issue.path)}</span>: {issue.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error != null && (
          <p
            role="alert"
            className="rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-3 text-[12px] text-[var(--destructive)]"
          >
            {error}
          </p>
        )}

        <ToolPanel title="出力">
          <p className="mb-3 text-[12px] leading-5 text-[var(--fg-muted)]">
            暗号化、電子署名、フォーム、しおり、添付ファイルを含むPDFは結合できません。
            入力ファイル自体は変更されません。
          </p>

          {operation != null && (
            <OperationProgress operation={operation} onCancel={() => void cancelActive()} />
          )}

          {result != null && operation == null && (
            <div
              role="status"
              className="mb-3 rounded-[var(--radius)] border border-emerald-500/50 bg-emerald-500/10 p-3 text-[12px] text-[var(--fg)]"
            >
              <p className="font-semibold">
                {result.total_pages.toLocaleString()}ページのPDFを保存しました
              </p>
              <p className="mt-1 truncate text-[var(--fg-muted)]" title={result.output_path}>
                {result.output_path} · {formatBytes(result.output_bytes)} · {result.duration_ms} ms
              </p>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => void mergeAndSave()}
              disabled={files.length < 2 || busy}
              aria-label="結合して保存"
            >
              {operation?.kind === "merge" ? (
                <Loader2 className="animate-spin" size={14} aria-hidden />
              ) : (
                <Files size={14} aria-hidden />
              )}
              結合して保存
            </Button>
          </div>
        </ToolPanel>
      </div>
    </ToolPage>
  );
}

function SortablePdfRow({
  file,
  index,
  count,
  disabled,
  onMove,
  onRemove,
}: {
  file: PdfListEntry;
  index: number;
  count: number;
  disabled: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.id,
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex min-h-14 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2",
        isDragging && "z-10 opacity-90 shadow-lg",
      )}
    >
      <button
        type="button"
        aria-label={`${file.file_name} をドラッグして並べ替え`}
        title="ドラッグして並べ替え"
        disabled={disabled}
        className="inline-flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] disabled:cursor-not-allowed"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={15} aria-hidden />
      </button>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-[var(--accent-soft)] text-[11px] font-semibold text-[var(--accent)]">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--fg)]" title={file.path}>
          {file.file_name}
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">
          {file.page_count.toLocaleString()}ページ · {formatBytes(file.size_bytes)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label={`${file.file_name} を上へ移動`}
          disabled={disabled || index === 0}
          onClick={() => onMove(index, -1)}
        >
          <ArrowUp size={14} aria-hidden />
        </IconButton>
        <IconButton
          label={`${file.file_name} を下へ移動`}
          disabled={disabled || index === count - 1}
          onClick={() => onMove(index, 1)}
        >
          <ArrowDown size={14} aria-hidden />
        </IconButton>
        <IconButton
          label={`${file.file_name} を削除`}
          disabled={disabled}
          onClick={() => onRemove(file.id)}
          destructive
        >
          <Trash2 size={14} aria-hidden />
        </IconButton>
      </div>
    </li>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  destructive = false,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-35",
        destructive && "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]",
      )}
    >
      {children}
    </button>
  );
}

function OperationProgress({
  operation,
  onCancel,
}: {
  operation: ActiveOperation;
  onCancel: () => void;
}) {
  const { label, value, max } = progressView(operation);
  return (
    <div className="mb-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-3">
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
      <div
        role="progressbar"
        aria-label={operation.kind === "inspect" ? "PDF検査の進捗" : "PDF結合の進捗"}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width]"
          style={{ width: `${max === 0 ? 0 : Math.round((value / max) * 100)}%` }}
        />
      </div>
    </div>
  );
}

function progressView(operation: ActiveOperation): { label: string; value: number; max: number } {
  const progress = operation.progress;
  if (progress == null) {
    return {
      label: operation.kind === "inspect" ? "PDFを確認しています..." : "結合を準備しています...",
      value: 0,
      max: 1,
    };
  }
  switch (progress.type) {
    case "reading":
      return {
        label: `${progress.file_name} を読み込んでいます (${progress.completed_files}/${progress.total_files})`,
        value: progress.completed_files,
        max: progress.total_files,
      };
    case "merging":
      return {
        label: `${progress.pages_processed.toLocaleString()}ページを結合しました (${progress.completed_files}/${progress.total_files})`,
        value: progress.completed_files,
        max: progress.total_files,
      };
    case "writing":
      return {
        label: `${progress.total_pages.toLocaleString()}ページを書き込んでいます...`,
        value: 1,
        max: 1,
      };
    case "done":
      return { label: "完了しました", value: 1, max: 1 };
    case "cancelled":
      return { label: "キャンセルしました", value: 1, max: 1 };
  }
}

function isCancelledError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "cancelled"
  );
}

function isCurrentOperation(operation: ActiveOperation | null, operationId: string): boolean {
  return operation?.id === operationId;
}

function formatPdfMergeError(cause: unknown): string {
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
