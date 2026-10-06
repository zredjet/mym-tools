import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ClipboardPaste, Copy, FileText, Loader2 } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/Button";
import {
  inputClass,
  textareaClass,
  ToolError,
  ToolPage,
  ToolPanel,
} from "@/components/ui/ToolPage";
import {
  cancelCsvViewOperation,
  type CsvFileText,
  csvviewReadFile,
  MAX_CSV_FILE_BYTES,
} from "@/ipc/csvview";
import type { SourceEncoding } from "@/ipc/encoding";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import { confidenceLabels, sourceOptions, textEncodingLabels } from "@/lib/textEncoding";

import { columnNames, type OutputFormat, outputFormatLabels } from "./csvConvert";
import { delimiterLabels } from "./csvParser";
import {
  type ConvertSummary,
  type DelimiterChoice,
  MAX_PREVIEW_COLUMNS,
  MAX_PREVIEW_ROWS,
  type ParseSummary,
} from "./csvWorkerCore";
import { CsvWorkerSuperseded, useCsvWorker } from "./useCsvWorker";

type Mode = "paste" | "file";
type FileInfo = Omit<CsvFileText, "text"> & { path: string; source: SourceEncoding };

/** 貼り付けたテキストの上限。ファイルは Rust 側で 10 MiB / 復号後 32 MiB まで。 */
const MAX_PASTE_LENGTH = 10 * 1024 * 1024;
const PASTE_DEBOUNCE_MS = 300;
/** 変換結果のプレビューに出す文字数。コピーは全体。 */
const OUTPUT_PREVIEW_CHARS = 20_000;

export function CsvViewPage() {
  const [mode, setMode] = useState<Mode>("paste");
  const [pasted, setPasted] = useState("");
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [delimiter, setDelimiter] = useState<DelimiterChoice>("auto");
  const [header, setHeader] = useState(true);
  const [format, setFormat] = useState<OutputFormat>("json");
  const [summary, setSummary] = useState<ParseSummary | null>(null);
  const [output, setOutput] = useState<ConvertSummary | null>(null);
  const [busy, setBusy] = useState<"read" | "parse" | "convert" | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const worker = useCsvWorker();
  // 非同期の処理の後で最新の設定を使うため、設定は ref にも持つ (イベントの中でだけ書く)
  const fileTextRef = useRef<string | null>(null);
  const pastedRef = useRef("");
  const settingsRef = useRef({ mode, delimiter, header, format });
  const parseSeqRef = useRef(0);
  const convertSeqRef = useRef(0);
  const readingRef = useRef<string | null>(null);
  const pasteTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pasteTimerRef.current != null) window.clearTimeout(pasteTimerRef.current);
      if (readingRef.current != null)
        void cancelCsvViewOperation(readingRef.current).catch(() => undefined);
    };
  }, []);

  const convert = useCallback(async () => {
    const seq = ++convertSeqRef.current;
    const { format: nextFormat, header: nextHeader } = settingsRef.current;
    setBusy("convert");
    setCopyMessage(null);
    try {
      const result = await worker.convert(nextFormat, nextHeader);
      if (mountedRef.current && seq === convertSeqRef.current) setOutput(result);
    } catch (cause) {
      if (
        mountedRef.current &&
        seq === convertSeqRef.current &&
        !(cause instanceof CsvWorkerSuperseded)
      )
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current && seq === convertSeqRef.current) setBusy(null);
    }
  }, [worker]);

  /** いま選んでいる入力を解析し、続けて変換する。入力が空なら表と結果を消す。 */
  const parseCurrent = useCallback(async () => {
    const seq = ++parseSeqRef.current;
    convertSeqRef.current += 1;
    const { mode: currentMode, delimiter: currentDelimiter } = settingsRef.current;
    const text = currentMode === "paste" ? pastedRef.current : fileTextRef.current;
    setOutput(null);
    setError(null);
    setCopyMessage(null);
    if (text == null || text === "") {
      worker.reset();
      setSummary(null);
      setBusy(null);
      return;
    }
    if (currentMode === "paste" && text.length > MAX_PASTE_LENGTH) {
      worker.reset();
      setSummary(null);
      setBusy(null);
      setError("貼り付けたテキストが 10 MiB を超えています。ファイルとして読み込んでください");
      return;
    }
    setBusy("parse");
    try {
      const result = await worker.parse(text, currentDelimiter);
      if (!mountedRef.current || seq !== parseSeqRef.current) return;
      setSummary(result);
      await convert();
    } catch (cause) {
      if (!mountedRef.current || seq !== parseSeqRef.current) return;
      if (cause instanceof CsvWorkerSuperseded) return;
      setSummary(null);
      setBusy(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [convert, worker]);

  const readFile = useCallback(
    async (path: string, source: SourceEncoding) => {
      if (readingRef.current != null)
        void cancelCsvViewOperation(readingRef.current).catch(() => undefined);
      const operationId = crypto.randomUUID();
      readingRef.current = operationId;
      setReadingId(operationId);
      settingsRef.current = { ...settingsRef.current, mode: "file" };
      setMode("file");
      setBusy("read");
      setError(null);
      try {
        const file = await csvviewReadFile({ operationId, path, source });
        if (!mountedRef.current || readingRef.current !== operationId) return;
        fileTextRef.current = file.text;
        setFileInfo({
          encoding: file.encoding,
          confidence: file.confidence,
          bom: file.bom,
          size: file.size,
          path,
          source,
        });
        await parseCurrent();
      } catch (cause) {
        if (!mountedRef.current || readingRef.current !== operationId) return;
        if (!isCancelledError(cause)) {
          fileTextRef.current = null;
          setFileInfo(null);
          setSummary(null);
          setOutput(null);
          setError(formatCsvError(cause));
        }
        setBusy(null);
      } finally {
        if (mountedRef.current && readingRef.current === operationId) {
          readingRef.current = null;
          setReadingId(null);
        }
      }
    },
    [parseCurrent],
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
          if (first != null) void readFile(first, "auto");
        } else {
          setDragOver(false);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(formatCsvError(cause));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [readFile]);

  const chooseFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] },
          { name: "すべてのファイル", extensions: ["*"] },
        ],
      });
      if (typeof selected === "string" && mountedRef.current) await readFile(selected, "auto");
    } catch (cause) {
      if (mountedRef.current) setError(formatCsvError(cause));
    }
  };

  const switchMode = (next: Mode) => {
    settingsRef.current = { ...settingsRef.current, mode: next };
    setMode(next);
    void parseCurrent();
  };

  const copyOutput = () => {
    if (output == null) return;
    navigator.clipboard.writeText(output.text).then(
      () => mountedRef.current && setCopyMessage("コピーしました"),
      (cause: unknown) =>
        mountedRef.current &&
        setCopyMessage(
          `コピーできませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    );
  };

  const headerRow = summary != null && header ? (summary.preview[0] ?? []) : null;
  const shownColumns = summary == null ? 0 : Math.min(summary.columnCount, MAX_PREVIEW_COLUMNS);
  const names = columnNames(headerRow, shownColumns).names;
  const body =
    summary == null
      ? []
      : summary.preview.slice(header ? 1 : 0, header ? MAX_PREVIEW_ROWS : MAX_PREVIEW_ROWS - 1);
  const dataRowCount = summary == null ? 0 : Math.max(summary.rowCount - (header ? 1 : 0), 0);

  return (
    <ToolPage
      title="CSV ビューア"
      description="CSV / TSV を表で表示し、JSON・Markdown 表・CSV・TSV に変換します。入力は保存しません。"
    >
      <div className="flex flex-col gap-4 pb-6">
        <ToolPanel
          title="入力"
          actions={
            <div className="flex gap-1.5" role="group" aria-label="入力の方法">
              <SegmentButton selected={mode === "paste"} onClick={() => switchMode("paste")}>
                <ClipboardPaste size={13} aria-hidden /> 貼り付け
              </SegmentButton>
              <SegmentButton selected={mode === "file"} onClick={() => switchMode("file")}>
                <FileText size={13} aria-hidden /> ファイル
              </SegmentButton>
            </div>
          }
        >
          {mode === "paste" ? (
            <textarea
              aria-label="CSV を貼り付け"
              placeholder="CSV や、Excel からコピーしたセル (TSV) を貼り付け"
              className={`${textareaClass} h-40`}
              value={pasted}
              onChange={(event) => {
                const next = event.target.value;
                setPasted(next);
                pastedRef.current = next;
                if (pasteTimerRef.current != null) window.clearTimeout(pasteTimerRef.current);
                pasteTimerRef.current = window.setTimeout(() => {
                  pasteTimerRef.current = null;
                  void parseCurrent();
                }, PASTE_DEBOUNCE_MS);
              }}
            />
          ) : (
            <div
              className={cn(
                "flex min-h-20 flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed px-4 py-3 text-center transition-colors",
                dragOver
                  ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--bg-muted)] text-[var(--fg-muted)]",
              )}
              aria-label="ファイルのドロップ領域"
            >
              {fileInfo == null ? (
                <span className="text-[12px]">
                  CSV / TSV ファイルをここへドロップ ({MAX_CSV_FILE_BYTES / (1024 * 1024)} MiB まで)
                </span>
              ) : (
                <span className="text-[12px] break-all text-[var(--fg)]">{fileInfo.path}</span>
              )}
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button size="sm" onClick={() => void chooseFile()} disabled={busy === "read"}>
                  ファイルを選択
                </Button>
                {fileInfo != null && (
                  <label className="text-[12px] text-[var(--fg)]">
                    文字コード
                    <select
                      className={`${inputClass} ml-2`}
                      value={fileInfo.source}
                      disabled={busy === "read"}
                      onChange={(event) =>
                        void readFile(fileInfo.path, event.target.value as SourceEncoding)
                      }
                    >
                      {sourceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {fileInfo != null && (
                <span className="text-[11px] text-[var(--fg-muted)]">
                  {textEncodingLabels[fileInfo.encoding]}
                  {fileInfo.confidence != null && ` (${confidenceLabels[fileInfo.confidence]})`}
                  {fileInfo.bom != null && "・BOM あり"} / {fileInfo.size.toLocaleString()} バイト
                </span>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]">
            <label>
              区切り文字
              <select
                className={`${inputClass} ml-2`}
                value={delimiter}
                onChange={(event) => {
                  const next = event.target.value as DelimiterChoice;
                  settingsRef.current = { ...settingsRef.current, delimiter: next };
                  setDelimiter(next);
                  void parseCurrent();
                }}
              >
                <option value="auto">自動</option>
                <option value=",">カンマ</option>
                <option value={"\t"}>タブ</option>
                <option value=";">セミコロン</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={header}
                onChange={(event) => {
                  const next = event.target.checked;
                  settingsRef.current = { ...settingsRef.current, header: next };
                  setHeader(next);
                  if (summary != null) void convert();
                }}
              />
              1 行目を見出しにする
            </label>
          </div>
        </ToolPanel>

        <ToolError message={error} />

        {busy != null && (
          <div className="flex items-center gap-3 text-[12px] text-[var(--fg-muted)]" role="status">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {busy === "read"
              ? "ファイルを読んでいます…"
              : busy === "parse"
                ? "解析しています…"
                : "変換しています…"}
            {busy === "read" && readingId != null && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void cancelCsvViewOperation(readingId).catch(() => undefined)}
              >
                キャンセル
              </Button>
            )}
          </div>
        )}

        {summary != null && (
          <ToolPanel
            title="表"
            actions={
              <span className="text-[12px] text-[var(--fg-muted)]">
                {dataRowCount.toLocaleString()} 行 × {summary.columnCount.toLocaleString()} 列 /
                区切り: {delimiterLabels[summary.delimiter]}
              </span>
            }
          >
            {summary.warningCount > 0 && (
              <details className="mb-3 text-[12px]">
                <summary className="cursor-pointer text-[var(--destructive)]">
                  警告が {summary.warningCount.toLocaleString()} 件あります
                </summary>
                <ul className="mt-1 list-disc pl-5">
                  {summary.warnings.map((warning, index) => (
                    <li key={index}>
                      {warning.record.toLocaleString()} 件目 ({warning.line.toLocaleString()} 行目):{" "}
                      {warning.message}
                    </li>
                  ))}
                  {summary.warningCount > summary.warnings.length && (
                    <li>
                      ほか {(summary.warningCount - summary.warnings.length).toLocaleString()} 件
                    </li>
                  )}
                </ul>
              </details>
            )}
            <div className="max-h-[480px] overflow-auto rounded-[var(--radius)] border border-[var(--border)]">
              <table className="w-max min-w-full border-collapse text-left text-[12px]">
                <thead className="sticky top-0 bg-[var(--bg-muted)]">
                  <tr>
                    <th className="border-b border-[var(--border)] px-2 py-1 text-right font-normal text-[var(--fg-subtle)]">
                      #
                    </th>
                    {names.map((name, index) => (
                      <th
                        key={index}
                        className="border-b border-[var(--border)] px-2 py-1 font-semibold whitespace-nowrap"
                      >
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-[var(--border)]">
                      <td className="px-2 py-1 text-right font-mono text-[var(--fg-subtle)]">
                        {rowIndex + 1}
                      </td>
                      {names.map((_, columnIndex) => (
                        <td
                          key={columnIndex}
                          className="max-w-80 truncate px-2 py-1"
                          title={row[columnIndex] ?? ""}
                        >
                          {cellText(row[columnIndex])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
              {dataRowCount > body.length
                ? `先頭 ${body.length.toLocaleString()} 行を表示しています (全 ${dataRowCount.toLocaleString()} 行)。`
                : "すべての行を表示しています。"}
              {summary.previewTrimmed &&
                ` 表示は ${MAX_PREVIEW_COLUMNS} 列・1 セル 200 文字までです (変換結果には全体が入ります)。`}
              空行は飛ばします。
            </p>
          </ToolPanel>
        )}

        {summary != null && (
          <ToolPanel
            title="変換"
            actions={
              <div className="flex items-center gap-2">
                {copyMessage != null && (
                  <span className="text-[12px] text-[var(--fg-muted)]" role="status">
                    {copyMessage}
                  </span>
                )}
                <Button size="sm" disabled={output == null || busy != null} onClick={copyOutput}>
                  <Copy size={13} aria-hidden />
                  コピー
                </Button>
              </div>
            }
          >
            <label className="text-[12px]">
              形式
              <select
                className={`${inputClass} ml-2`}
                value={format}
                onChange={(event) => {
                  const next = event.target.value as OutputFormat;
                  settingsRef.current = { ...settingsRef.current, format: next };
                  setFormat(next);
                  void convert();
                }}
              >
                {(Object.keys(outputFormatLabels) as OutputFormat[]).map((value) => (
                  <option key={value} value={value}>
                    {outputFormatLabels[value]}
                  </option>
                ))}
              </select>
            </label>
            {output != null && output.warnings.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-[12px] text-[var(--fg-muted)]">
                {output.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            {output != null && (
              <>
                <pre
                  aria-label="変換結果"
                  className="mt-3 max-h-80 overflow-auto rounded-[var(--radius)] bg-[var(--bg-muted)] p-3 font-mono text-[12px] whitespace-pre-wrap"
                >
                  {output.text.slice(0, OUTPUT_PREVIEW_CHARS)}
                </pre>
                <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">
                  {output.text.length.toLocaleString()} 文字
                  {output.text.length > OUTPUT_PREVIEW_CHARS &&
                    ` (先頭 ${OUTPUT_PREVIEW_CHARS.toLocaleString()} 文字を表示。コピーは全体)`}
                  {output.format === "csv" || output.format === "tsv" ? "。改行は LF" : ""}
                </p>
              </>
            )}
          </ToolPanel>
        )}
      </div>
    </ToolPage>
  );
}

function SegmentButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={selected ? "primary" : "secondary"}
      aria-pressed={selected}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** 表では 1 行に収めるため、セルの中の改行を ⏎ で示す。 */
function cellText(value: string | undefined): string {
  return (value ?? "").replace(/\r\n|\r|\n/g, "⏎");
}

function isCancelledError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "cancelled"
  );
}

function formatCsvError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "object" && message !== null && "reason" in message) {
      const reason = (message as { reason?: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return formatInvokeError(cause);
}
