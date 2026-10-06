import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/Button";
import { inputClass, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";
import {
  type ByteIssue,
  cancelEncodingOperation,
  encodingConvertFile,
  type EncodingConvertResult,
  encodingInspectFile,
  type EncodingInspection,
  MAX_ENCODING_INPUT_BYTES,
  type NewlineMode,
  type SourceEncoding,
  type TargetEncoding,
} from "@/ipc/encoding";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";

import {
  confidenceLabels,
  defaultOutputPath,
  formatBytes,
  includesMacSymbol,
  newlineOptions,
  newlineSummary,
  noChangeReason,
  sourceOptions,
  targetOptions,
  textEncodingLabels,
} from "./encodingFormat";

interface ActiveOperation {
  id: string;
  kind: "inspect" | "convert";
  cancelling: boolean;
}

interface Converted {
  outputPath: string;
  result: EncodingConvertResult;
}

export function EncodingPage() {
  const [path, setPath] = useState<string | null>(null);
  const [source, setSource] = useState<SourceEncoding>("auto");
  const [target, setTarget] = useState<TargetEncoding>("utf8");
  const [newline, setNewline] = useState<NewlineMode>("keep");
  const [normalizeMacSymbols, setNormalizeMacSymbols] = useState(false);
  const [inspection, setInspection] = useState<EncodingInspection | null>(null);
  const [converted, setConverted] = useState<Converted | null>(null);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef(operation);
  const mountedRef = useRef(true);

  const replaceOperation = useCallback((next: ActiveOperation | null) => {
    operationRef.current = next;
    setOperation(next);
  }, []);

  /** 画面が残っていて、`operationId` がまだ現在の処理か。 */
  const isCurrentOperation = (operationId: string) =>
    mountedRef.current && operationRef.current?.id === operationId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = operationRef.current;
      if (active != null) void cancelEncodingOperation(active.id).catch(() => undefined);
    };
  }, []);

  // 判定は 1 つだけ走らせる。前の判定が終わっていなければ取り消す。
  const inspect = useCallback(
    (nextPath: string, nextSource: SourceEncoding) => {
      const previous = operationRef.current;
      if (previous?.kind === "convert") return;
      if (previous != null) void cancelEncodingOperation(previous.id).catch(() => undefined);
      const operationId = crypto.randomUUID();
      replaceOperation({ id: operationId, kind: "inspect", cancelling: false });
      setInspection(null);
      setConverted(null);
      setError(null);
      const isCurrent = () => mountedRef.current && operationRef.current?.id === operationId;
      encodingInspectFile({ operationId, path: nextPath, source: nextSource })
        .then((result) => {
          if (isCurrent()) setInspection(result);
        })
        .catch((cause: unknown) => {
          if (!isCancelledError(cause) && isCurrent()) setError(formatEncodingError(cause));
        })
        .finally(() => {
          if (isCurrent()) replaceOperation(null);
        });
    },
    [replaceOperation],
  );

  const selectPath = useCallback(
    (next: string) => {
      if (operationRef.current?.kind === "convert") return;
      setPath(next);
      setSource("auto");
      inspect(next, "auto");
    },
    [inspect],
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
          if (first != null) selectPath(first);
        } else {
          setDragOver(false);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(formatEncodingError(cause));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [selectPath]);

  const chooseFile = async () => {
    try {
      const selected = await openDialog({ multiple: false, directory: false });
      if (typeof selected === "string" && mountedRef.current) selectPath(selected);
    } catch (cause) {
      if (mountedRef.current) setError(formatEncodingError(cause));
    }
  };

  const cancelActive = async () => {
    const active = operationRef.current;
    if (active == null) return;
    replaceOperation({ ...active, cancelling: true });
    try {
      await cancelEncodingOperation(active.id);
    } catch (cause) {
      if (mountedRef.current && operationRef.current?.id === active.id) {
        replaceOperation({ ...active, cancelling: false });
        setError(formatEncodingError(cause));
      }
    }
  };

  const convert = async () => {
    if (path == null || operationRef.current != null) return;
    let outputPath: string | null;
    try {
      outputPath = await saveDialog({ defaultPath: defaultOutputPath(path, target) });
    } catch (cause) {
      if (mountedRef.current) setError(formatEncodingError(cause));
      return;
    }
    if (outputPath == null || !mountedRef.current) return;
    const operationId = crypto.randomUUID();
    replaceOperation({ id: operationId, kind: "convert", cancelling: false });
    setConverted(null);
    setError(null);
    try {
      const result = await encodingConvertFile({
        operationId,
        inputPath: path,
        outputPath,
        source,
        target,
        newline,
        normalizeMacSymbols,
      });
      if (isCurrentOperation(operationId)) setConverted({ outputPath, result });
    } catch (cause) {
      if (!isCancelledError(cause) && mountedRef.current) setError(formatEncodingError(cause));
    } finally {
      if (isCurrentOperation(operationId)) replaceOperation(null);
    }
  };

  const busy = operation != null;
  const unchanged =
    inspection == null ? null : noChangeReason(inspection, target, newline, normalizeMacSymbols);
  const blockedReason =
    inspection == null
      ? null
      : inspection.encoding == null
        ? "文字コードを判定できませんでした。変換元を選んでください。"
        : inspection.malformed_count > 0
          ? `${textEncodingLabels[inspection.encoding]} として読めないバイトがあります。変換元を確かめてください。`
          : unchanged;
  const canConvert = path != null && inspection != null && blockedReason == null && !busy;

  return (
    <ToolPage
      title="文字コード変換"
      description="テキストファイルの文字コードを判定し、別の文字コード・改行で別名保存します。元のファイルは変えません。"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-6">
        <ToolPanel title="入力ファイル">
          <div
            className={cn(
              "flex min-h-20 flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed px-4 py-3 text-center transition-colors",
              dragOver
                ? "border-[var(--accent)] bg-[var(--bg-accent-soft)] text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--bg-muted)] text-[var(--fg-muted)]",
            )}
            aria-label="ファイルのドロップ領域"
          >
            {path == null ? (
              <span className="text-[12px]">
                テキストファイルをここへドロップ ({formatBytes(MAX_ENCODING_INPUT_BYTES)} まで)
              </span>
            ) : (
              <span className="text-[12px] break-all text-[var(--fg)]">{path}</span>
            )}
            <Button
              size="sm"
              onClick={() => void chooseFile()}
              disabled={operation?.kind === "convert"}
            >
              ファイルを選択
            </Button>
          </div>
        </ToolPanel>

        <ToolError message={error} />

        {busy && (
          <div className="flex items-center gap-3 text-[12px] text-[var(--fg-muted)]" role="status">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {operation.kind === "inspect" ? "判定しています…" : "変換しています…"}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void cancelActive()}
              disabled={operation.cancelling}
            >
              キャンセル
            </Button>
          </div>
        )}

        {inspection != null && <InspectionPanel inspection={inspection} />}

        {path != null && (
          <ToolPanel title="変換">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[12px]">
              <label>
                変換元
                <select
                  className={`${inputClass} ml-2`}
                  value={source}
                  disabled={busy}
                  onChange={(event) => {
                    const next = event.target.value as SourceEncoding;
                    setSource(next);
                    inspect(path, next);
                  }}
                >
                  {sourceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                変換先
                <select
                  className={`${inputClass} ml-2`}
                  value={target}
                  disabled={busy}
                  onChange={(event) => setTarget(event.target.value as TargetEncoding)}
                >
                  {targetOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                改行
                <select
                  className={`${inputClass} ml-2`}
                  value={newline}
                  disabled={busy}
                  onChange={(event) => setNewline(event.target.value as NewlineMode)}
                >
                  {newlineOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={normalizeMacSymbols}
                  disabled={busy}
                  onChange={(event) => setNormalizeMacSymbols(event.target.checked)}
                />
                Mac 由来の記号を Windows で使われる形に寄せる (〜 → ～、— → ― など)
              </label>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button variant="primary" disabled={!canConvert} onClick={() => void convert()}>
                別名で保存…
              </Button>
              {blockedReason != null && (
                <span className="text-[12px] text-[var(--fg-muted)]">{blockedReason}</span>
              )}
            </div>
          </ToolPanel>
        )}

        {converted != null && (
          <ConvertedPanel converted={converted} normalizeMacSymbols={normalizeMacSymbols} />
        )}
      </div>
    </ToolPage>
  );
}

function InspectionPanel({ inspection }: { inspection: EncodingInspection }) {
  const detection = inspection.detection;
  return (
    <ToolPanel title="判定結果">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-[12px]">
        <dt className="text-[var(--fg-muted)]">文字コード</dt>
        <dd>
          {inspection.encoding == null ? "—" : textEncodingLabels[inspection.encoding]}
          {detection != null && (
            <span className="ml-2 text-[var(--fg-muted)]">
              ({confidenceLabels[detection.confidence]}
              {detection.ascii_only && "・ASCII の文字だけ"})
            </span>
          )}
        </dd>
        <dt className="text-[var(--fg-muted)]">BOM</dt>
        <dd>{inspection.bom == null ? "なし" : `あり (${textEncodingLabels[inspection.bom]})`}</dd>
        <dt className="text-[var(--fg-muted)]">サイズ</dt>
        <dd>{formatBytes(inspection.size)}</dd>
        {inspection.encoding != null && (
          <>
            <dt className="text-[var(--fg-muted)]">行数・文字数</dt>
            <dd>
              {inspection.line_count.toLocaleString()} 行 / {inspection.char_count.toLocaleString()}{" "}
              文字
            </dd>
            <dt className="text-[var(--fg-muted)]">改行</dt>
            <dd>
              {newlineSummary(inspection.newlines)}
              <span className="ml-2 text-[var(--fg-muted)]">
                (CRLF {inspection.newlines.crlf.toLocaleString()} / LF{" "}
                {inspection.newlines.lf.toLocaleString()} / CR{" "}
                {inspection.newlines.cr.toLocaleString()})
              </span>
            </dd>
          </>
        )}
        {inspection.private_use_count > 0 && (
          <>
            <dt className="text-[var(--fg-muted)]">外字</dt>
            <dd>私用領域の文字が {inspection.private_use_count.toLocaleString()} 文字あります</dd>
          </>
        )}
      </dl>

      {detection != null && detection.candidates.length > 0 && (
        <div className="mt-3">
          <p className="text-[12px] text-[var(--fg-muted)]">候補ごとの結果</p>
          <ul className="mt-1 text-[12px]">
            {detection.candidates.map((candidate) => (
              <li key={candidate.encoding}>
                {textEncodingLabels[candidate.encoding]}:{" "}
                {candidate.ok
                  ? "読めます"
                  : `読めないバイトが ${candidate.malformed_count.toLocaleString()} か所`}
                {candidate.first_error != null && ` (最初は ${issueLabel(candidate.first_error)})`}
              </li>
            ))}
          </ul>
          {detection.confidence === "guess" && (
            <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">
              推定はかな・漢字の多さで選んでいます。プレビューが文字化けしていたら変換元を選び直してください。
            </p>
          )}
        </div>
      )}

      {inspection.malformed_count > 0 && (
        <IssueList
          title={`読めないバイトが ${inspection.malformed_count.toLocaleString()} か所あります`}
          items={inspection.malformed.map(issueLabel)}
          total={inspection.malformed_count}
        />
      )}

      {inspection.encoding != null && (
        <div className="mt-3">
          <p className="text-[12px] text-[var(--fg-muted)]">
            プレビュー{inspection.preview_truncated && " (先頭だけ)"}
          </p>
          <pre
            aria-label="プレビュー"
            className="mt-1 max-h-60 overflow-auto rounded-[var(--radius)] bg-[var(--bg-muted)] p-3 font-mono text-[12px] whitespace-pre-wrap"
          >
            {inspection.preview}
          </pre>
        </div>
      )}
    </ToolPanel>
  );
}

function ConvertedPanel({
  converted,
  normalizeMacSymbols,
}: {
  converted: Converted;
  normalizeMacSymbols: boolean;
}) {
  const { result, outputPath } = converted;
  if (result.status === "rejected") {
    const suggestMac =
      !normalizeMacSymbols && includesMacSymbol(result.unmappable.map((issue) => issue.char));
    return (
      <ToolPanel title="変換できませんでした">
        <p className="text-[12px]">ファイルは保存していません。</p>
        {result.unmappable_count > 0 && (
          <IssueList
            title={`変換先で表せない文字が ${result.unmappable_count.toLocaleString()} か所あります`}
            items={result.unmappable.map(
              (issue) =>
                `${issue.line} 行 ${issue.column} 文字目: ${issue.char} (${issue.code_point})`,
            )}
            total={result.unmappable_count}
          />
        )}
        {result.malformed_count > 0 && (
          <IssueList
            title={`読めないバイトが ${result.malformed_count.toLocaleString()} か所あります`}
            items={result.malformed.map(issueLabel)}
            total={result.malformed_count}
          />
        )}
        {suggestMac && (
          <p className="mt-2 text-[12px]">
            Mac で入力された記号が含まれています。「Mac 由来の記号を Windows
            で使われる形に寄せる」を選ぶと変換できる場合があります。
          </p>
        )}
      </ToolPanel>
    );
  }
  return (
    <ToolPanel title="保存しました">
      <p className="text-[12px] break-all">{outputPath}</p>
      <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
        {textEncodingLabels[result.source]} から変換 / {formatBytes(result.bytes_written)} /{" "}
        {result.duration_ms.toLocaleString()} ms
        {result.normalized_count > 0 &&
          ` / Mac 由来の記号を ${result.normalized_count.toLocaleString()} 文字置き換えました`}
      </p>
      {result.warnings.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-[12px]">
          {result.warnings.map((warning) => (
            <li key={`${warning.kind}-${warning.code_point}`}>
              {warning.kind === "substituted"
                ? `${warning.char} (${warning.code_point}) は変換先に無いため、読み戻すと ${warning.replacement ?? ""} になります`
                : `外字 (私用領域の文字、最初は ${warning.code_point}) をそのまま書きました。ほかの環境では表示が変わることがあります`}
              : {warning.count.toLocaleString()} 文字、最初は {warning.first_line.toLocaleString()}{" "}
              行目
            </li>
          ))}
        </ul>
      )}
    </ToolPanel>
  );
}

function IssueList({ title, items, total }: { title: string; items: string[]; total: number }) {
  return (
    <div className="mt-3">
      <p role="alert" className="text-[12px] text-[var(--destructive)]">
        {title}
      </p>
      <ul className="mt-1 list-disc pl-5 font-mono text-[12px]">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
        {total > items.length && <li>ほか {(total - items.length).toLocaleString()} か所</li>}
      </ul>
    </div>
  );
}

function issueLabel(issue: ByteIssue): string {
  return `${issue.line} 行目 (${issue.offset.toLocaleString()} バイト目): ${issue.bytes}`;
}

function isCancelledError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "cancelled"
  );
}

function formatEncodingError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "object" && message !== null && "reason" in message) {
      const reason = (message as { reason?: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
  }
  return formatInvokeError(cause);
}
