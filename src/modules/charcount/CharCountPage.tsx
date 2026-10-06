import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { textareaClass, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";

import { type CharCountResult, type CharKind, countText, formatCodePoint } from "./charCount";

const DEBOUNCE_MS = 150;

interface Snapshot {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const kindRows: { kind: CharKind; label: string }[] = [
  { kind: "hiragana", label: "ひらがな" },
  { kind: "katakana", label: "カタカナ" },
  { kind: "kanji", label: "漢字" },
  { kind: "latin", label: "英字" },
  { kind: "digit", label: "数字" },
  { kind: "space", label: "空白" },
  { kind: "newline", label: "改行" },
  { kind: "other", label: "記号・その他" },
];

const countRows: { label: string; value: (result: CharCountResult) => number }[] = [
  { label: "文字数", value: (result) => result.graphemes },
  { label: "空白・改行を除く文字数", value: (result) => result.nonWhitespace },
  { label: "コードポイント数", value: (result) => result.codePoints },
  { label: "UTF-16 単位数", value: (result) => result.utf16Units },
  { label: "行数", value: (result) => result.lines },
  { label: "空行数", value: (result) => result.blankLines },
  { label: "UTF-8 バイト数", value: (result) => result.bytes.utf8 },
  { label: "Shift_JIS バイト数", value: (result) => result.bytes.sjis },
  { label: "UTF-16 バイト数", value: (result) => result.bytes.utf16 },
  { label: "半角", value: (result) => result.width.half },
  { label: "全角", value: (result) => result.width.full },
  { label: "Shift_JIS で表せない文字", value: (result) => result.width.unencodable },
];

const numberFormat = new Intl.NumberFormat("ja-JP");

export function CharCountPage() {
  const [input, setInput] = useState("");
  const [crlf, setCrlf] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    text: "",
    selectionStart: 0,
    selectionEnd: 0,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timeoutRef = useRef<number | null>(null);

  // 入力と選択範囲をまとめて少し遅らせて数える。1 MiB までなら同期で間に合う。
  const scheduleSnapshot = useCallback(() => {
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      const textarea = textareaRef.current;
      if (!textarea) return;
      setSnapshot({
        text: textarea.value,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      });
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    // 選択を外したときは select イベントが出ないため、document 側でも拾う。
    const onSelectionChange = () => {
      if (document.activeElement === textareaRef.current) scheduleSnapshot();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
    };
  }, [scheduleSnapshot]);

  const { whole, selection, error } = useMemo(() => {
    try {
      const options = { crlf };
      const { text, selectionStart, selectionEnd } = snapshot;
      return {
        whole: countText(text, options),
        selection:
          selectionEnd > selectionStart
            ? countText(text.slice(selectionStart, selectionEnd), options)
            : null,
        error: null,
      };
    } catch (cause) {
      return {
        whole: null,
        selection: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [snapshot, crlf]);

  return (
    <ToolPage
      title="文字数カウント"
      description="文字数・行数・バイト数・文字種を数えます。入力は保存しません。"
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={crlf}
            onChange={(event) => setCrlf(event.target.checked)}
          />
          バイト数で改行を CRLF として数える
        </label>
      </div>
      <ToolError message={error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <ToolPanel title="入力" className="self-start">
          <textarea
            ref={textareaRef}
            aria-label="入力"
            className={`${textareaClass} h-96`}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              scheduleSnapshot();
            }}
            onSelect={scheduleSnapshot}
            onKeyUp={scheduleSnapshot}
            onMouseUp={scheduleSnapshot}
          />
        </ToolPanel>
        <div className="grid content-start gap-4">
          <ToolPanel title="件数">
            <CountTable rows={countRows} whole={whole} selection={selection} />
            <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
              文字数は見た目の 1 文字 (書記素) 単位です。半角・全角は Shift_JIS (CP932 相当) で 1
              バイトか 2 バイトかで分け、改行は含めません。空行には空白だけの行も含めます。
            </p>
          </ToolPanel>
          <ToolPanel title="文字種 (コードポイント単位)">
            <CountTable
              rows={kindRows.map((row) => ({
                label: row.label,
                value: (result: CharCountResult) => result.kinds[row.kind],
              }))}
              whole={whole}
              selection={selection}
            />
          </ToolPanel>
          {whole != null && whole.unencodable.length > 0 && (
            <ToolPanel title="Shift_JIS で表せない文字">
              <ul className="flex flex-wrap gap-2 text-[12px]">
                {whole.unencodable.map((item) => (
                  <li
                    key={item.codePoint}
                    className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-1"
                  >
                    <span className="font-mono">{formatCodePoint(item.codePoint)}</span>{" "}
                    {item.invisible ? (
                      <span className="text-[var(--fg-muted)]">(見えない文字)</span>
                    ) : (
                      <span>{item.char}</span>
                    )}{" "}
                    <span className="text-[var(--fg-muted)]">
                      ×{numberFormat.format(item.count)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
                最初に現れた順で 20 種類まで表示します。Shift_JIS のバイト数には含めません。
              </p>
            </ToolPanel>
          )}
        </div>
      </div>
    </ToolPage>
  );
}

function CountTable({
  rows,
  whole,
  selection,
}: {
  rows: { label: string; value: (result: CharCountResult) => number }[];
  whole: CharCountResult | null;
  selection: CharCountResult | null;
}) {
  return (
    <table className="w-full text-left text-[12px]">
      <thead>
        <tr className="text-[var(--fg-muted)]">
          <th className="py-1 font-normal">項目</th>
          <th className="py-1 text-right font-normal">全体</th>
          {selection != null && <th className="py-1 text-right font-normal">選択範囲</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="border-t border-[var(--border)]">
            <td className="py-1.5">{row.label}</td>
            <td className="py-1.5 text-right font-mono">
              {whole == null ? "—" : numberFormat.format(row.value(whole))}
            </td>
            {selection != null && (
              <td className="py-1.5 text-right font-mono">
                {numberFormat.format(row.value(selection))}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
