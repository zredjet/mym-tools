import { useDeferredValue, useMemo, useRef, useState } from "react";
import { ArrowLeft, LocateFixed } from "lucide-react";

import { Button } from "@/components/ui/Button";
import {
  CopyButton,
  inputClass,
  textareaClass,
  ToolError,
  ToolPage,
  ToolPanel,
} from "@/components/ui/ToolPage";

import {
  defaultJsonFormatOptions,
  formatJson,
  type JsonFormatResult,
  type JsonIndent,
  type JsonOutputMode,
  type JsonPosition,
  JsonSyntaxError,
} from "./jsonFormat";

interface Outcome {
  result: JsonFormatResult | null;
  error: string | null;
  /** 構文エラーの位置。上限超過などの位置のないエラーでは null。 */
  errorPosition: JsonPosition | null;
}

const emptyOutcome: Outcome = { result: null, error: null, errorPosition: null };
const jsonWhitespaceOnly = /^[ \t\r\n]*$/;

export function JsonFormatPage() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<JsonOutputMode>(defaultJsonFormatOptions.mode);
  const [indent, setIndent] = useState<JsonIndent>(defaultJsonFormatOptions.indent);
  const [sortKeys, setSortKeys] = useState(defaultJsonFormatOptions.sortKeys);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deferredInput = useDeferredValue(input);

  const { result, error, errorPosition } = useMemo((): Outcome => {
    if (jsonWhitespaceOnly.test(deferredInput)) return emptyOutcome;
    try {
      return { ...emptyOutcome, result: formatJson(deferredInput, { mode, indent, sortKeys }) };
    } catch (cause) {
      if (cause instanceof JsonSyntaxError) {
        const { line, column } = cause.position;
        return {
          result: null,
          error: `${line.toLocaleString()} 行 ${column.toLocaleString()} 文字目: ${cause.message}`,
          errorPosition: cause.position,
        };
      }
      return {
        ...emptyOutcome,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [deferredInput, mode, indent, sortKeys]);
  const output = result?.output ?? "";

  const selectErrorPosition = () => {
    const textarea = inputRef.current;
    if (textarea == null || errorPosition == null) return;
    const start = Math.min(errorPosition.offset, textarea.value.length);
    textarea.focus();
    textarea.setSelectionRange(start, Math.min(start + 1, textarea.value.length));
  };

  return (
    <ToolPage
      title="JSON 整形"
      description="JSON を検証して、整形または圧縮します。数値と文字列は書かれていたまま残し、空白と改行だけを変えます。入力は保存しません。"
    >
      <ToolPanel title="設定">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[12px]">
          <label>
            出力
            <select
              className={`${inputClass} ml-2`}
              value={mode}
              onChange={(event) => setMode(event.target.value as JsonOutputMode)}
            >
              <option value="pretty">整形</option>
              <option value="minify">圧縮 (1 行)</option>
            </select>
          </label>
          <label>
            インデント
            <select
              className={`${inputClass} ml-2`}
              value={indent}
              disabled={mode !== "pretty"}
              onChange={(event) => setIndent(event.target.value as JsonIndent)}
            >
              <option value="2">スペース 2 個</option>
              <option value="4">スペース 4 個</option>
              <option value="tab">タブ</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sortKeys}
              onChange={(event) => setSortKeys(event.target.checked)}
            />
            キーを文字コード順に並べ替える
          </label>
        </div>
      </ToolPanel>

      {error != null && (
        <div className="mt-4">
          <ToolError message={error} />
          {errorPosition != null && (
            <Button size="sm" className="mt-2" onClick={selectErrorPosition}>
              <LocateFixed size={13} aria-hidden />
              エラーの位置へ移動
            </Button>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ToolPanel title="入力">
          <textarea
            ref={inputRef}
            aria-label="入力"
            aria-invalid={error != null}
            spellCheck={false}
            className={`${textareaClass} h-96`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </ToolPanel>
        <ToolPanel
          title="結果"
          actions={
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={output === "" || output === input}
                onClick={() => setInput(output)}
              >
                <ArrowLeft size={13} aria-hidden />
                結果を入力へ
              </Button>
              <CopyButton text={output} />
            </div>
          }
        >
          <textarea
            aria-label="結果"
            spellCheck={false}
            className={`${textareaClass} h-96`}
            value={output}
            readOnly
          />
          {result != null && <ResultSummary result={result} inputLength={deferredInput.length} />}
        </ToolPanel>
      </div>
    </ToolPage>
  );
}

function ResultSummary({ result, inputLength }: { result: JsonFormatResult; inputLength: number }) {
  const { stats, duplicateKeys, duplicateKeyCount, removedBom } = result;
  return (
    <div className="mt-2 text-[12px]">
      <p className="text-[var(--fg-muted)]">
        正しい JSON です。オブジェクト {stats.objects.toLocaleString()} 個 / 配列{" "}
        {stats.arrays.toLocaleString()} 個 / 値 {stats.values.toLocaleString()} 個 / 深さ{" "}
        {stats.maxDepth.toLocaleString()} / {inputLength.toLocaleString()} →{" "}
        {result.output.length.toLocaleString()} 文字
      </p>
      {removedBom && (
        <p className="mt-1 text-[var(--fg-muted)]">先頭の BOM (U+FEFF) は取り除きました。</p>
      )}
      {duplicateKeyCount > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[var(--destructive)]">
            同じオブジェクトの中に重複したキーが {duplicateKeyCount.toLocaleString()} 件あります
          </summary>
          <p className="mt-1 text-[var(--fg-muted)]">
            どちらの値が使われるかは読み込む側で変わります。結果には両方を残しています。
          </p>
          <ul className="mt-1 list-disc pl-5">
            {duplicateKeys.map((duplicate) => (
              <li key={duplicate.position.offset}>
                {duplicate.position.line.toLocaleString()} 行{" "}
                {duplicate.position.column.toLocaleString()} 文字目:{" "}
                <code className="font-mono">{JSON.stringify(duplicate.key)}</code>
              </li>
            ))}
            {duplicateKeyCount > duplicateKeys.length && (
              <li>ほか {(duplicateKeyCount - duplicateKeys.length).toLocaleString()} 件</li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}
