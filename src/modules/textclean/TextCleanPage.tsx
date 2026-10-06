import { useDeferredValue, useMemo, useRef, useState } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";

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
  type BlankLineMode,
  cleanText,
  defaultTextCleanOptions,
  type TabMode,
  type TabScope,
  type TextCleanResult,
} from "./textClean";

interface RuleRow {
  key: number;
  find: string;
  replace: string;
}

export function TextCleanPage() {
  const [input, setInput] = useState("");
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [caseSensitive, setCaseSensitive] = useState(defaultTextCleanOptions.caseSensitive);
  const [escapes, setEscapes] = useState(defaultTextCleanOptions.interpretEscapes);
  const [tabMode, setTabMode] = useState<TabMode>(defaultTextCleanOptions.tabMode);
  const [tabWidth, setTabWidth] = useState(defaultTextCleanOptions.tabWidth);
  const [tabScope, setTabScope] = useState<TabScope>(defaultTextCleanOptions.tabScope);
  const [trimTrailing, setTrimTrailing] = useState(defaultTextCleanOptions.trimTrailing);
  const [blankLines, setBlankLines] = useState<BlankLineMode>(defaultTextCleanOptions.blankLines);
  const [whitespaceLinesAreBlank, setWhitespaceLinesAreBlank] = useState(
    defaultTextCleanOptions.whitespaceLinesAreBlank,
  );
  const nextRuleKey = useRef(0);
  const deferredInput = useDeferredValue(input);

  const { result, error } = useMemo((): {
    result: TextCleanResult | null;
    error: string | null;
  } => {
    try {
      return {
        result: cleanText(deferredInput, {
          rules,
          caseSensitive,
          interpretEscapes: escapes,
          tabMode,
          tabWidth,
          tabScope,
          trimTrailing,
          blankLines,
          whitespaceLinesAreBlank,
        }),
        error: null,
      };
    } catch (cause) {
      return { result: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [
    deferredInput,
    rules,
    caseSensitive,
    escapes,
    tabMode,
    tabWidth,
    tabScope,
    trimTrailing,
    blankLines,
    whitespaceLinesAreBlank,
  ]);
  const output = result?.output ?? "";

  const updateRule = (key: number, patch: Partial<RuleRow>) =>
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));

  return (
    <ToolPage
      title="テキスト整形"
      description="置換・タブ・行末の空白・空行をこの順で整えます。正規表現での置換は「正規表現」を使ってください。入力は保存しません。"
    >
      <ToolPanel
        title="置換ルール"
        actions={
          <Button
            size="sm"
            onClick={() => {
              const key = nextRuleKey.current;
              nextRuleKey.current += 1;
              setRules((current) => [...current, { key, find: "", replace: "" }]);
            }}
          >
            <Plus size={13} aria-hidden />
            ルールを追加
          </Button>
        }
      >
        {rules.length === 0 ? (
          <p className="text-[12px] text-[var(--fg-subtle)]">
            置換ルールはありません。上から順に、文字列が一致した箇所をすべて置き換えます。
          </p>
        ) : (
          <ol className="grid gap-2">
            {rules.map((rule, index) => (
              <li key={rule.key} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`検索 ${index + 1}`}
                  placeholder="検索"
                  className={`${inputClass} min-w-40 flex-1 font-mono`}
                  value={rule.find}
                  onChange={(event) => updateRule(rule.key, { find: event.target.value })}
                />
                <span aria-hidden className="text-[var(--fg-muted)]">
                  →
                </span>
                <input
                  aria-label={`置換 ${index + 1}`}
                  placeholder="置換 (空なら削除)"
                  className={`${inputClass} min-w-40 flex-1 font-mono`}
                  value={rule.replace}
                  onChange={(event) => updateRule(rule.key, { replace: event.target.value })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`ルール ${index + 1} を削除`}
                  onClick={() =>
                    setRules((current) => current.filter((item) => item.key !== rule.key))
                  }
                >
                  <Trash2 size={13} aria-hidden />
                </Button>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            大文字小文字を区別する
          </label>
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={escapes}
              onChange={(event) => setEscapes(event.target.checked)}
            />
            \t \n \\ をタブ・改行・\ として扱う
          </label>
        </div>
      </ToolPanel>

      <ToolPanel title="整形" className="mt-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[12px]">
          <label>
            タブ
            <select
              className={`${inputClass} ml-2`}
              value={tabMode}
              onChange={(event) => setTabMode(event.target.value as TabMode)}
            >
              <option value="keep">そのまま</option>
              <option value="delete">削除</option>
              <option value="spaces">スペースに置換</option>
            </select>
          </label>
          <label>
            1 タブを
            <select
              className={`${inputClass} mx-2`}
              value={tabWidth}
              disabled={tabMode !== "spaces"}
              onChange={(event) => setTabWidth(Number(event.target.value))}
            >
              <option value={2}>2</option>
              <option value={4}>4</option>
              <option value={8}>8</option>
            </select>
            個のスペースに
          </label>
          <label>
            対象
            <select
              className={`${inputClass} ml-2`}
              value={tabScope}
              disabled={tabMode === "keep"}
              onChange={(event) => setTabScope(event.target.value as TabScope)}
            >
              <option value="all">すべてのタブ</option>
              <option value="leading">行頭のタブだけ</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={trimTrailing}
              onChange={(event) => setTrimTrailing(event.target.checked)}
            />
            行末の空白を削除
          </label>
          <label>
            空行
            <select
              className={`${inputClass} ml-2`}
              value={blankLines}
              onChange={(event) => setBlankLines(event.target.value as BlankLineMode)}
            >
              <option value="keep">そのまま</option>
              <option value="delete">すべて削除</option>
              <option value="collapse">連続する空行を 1 行に</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={whitespaceLinesAreBlank}
              disabled={blankLines === "keep"}
              onChange={(event) => setWhitespaceLinesAreBlank(event.target.checked)}
            />
            空白だけの行も空行とみなす
          </label>
        </div>
      </ToolPanel>

      <div className="mt-4">
        <ToolError message={error} />
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <ToolPanel title="入力">
          <textarea
            aria-label="入力"
            className={`${textareaClass} h-72`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </ToolPanel>
        <ToolPanel
          title="結果"
          actions={
            <div className="flex gap-2">
              <Button size="sm" disabled={output === input} onClick={() => setInput(output)}>
                <ArrowLeft size={13} aria-hidden />
                結果を入力へ
              </Button>
              <CopyButton text={output} />
            </div>
          }
        >
          <textarea aria-label="結果" className={`${textareaClass} h-72`} value={output} readOnly />
          {result != null && (
            <p className="mt-2 text-[12px] text-[var(--fg-muted)]">
              置換 {result.replacements} 件 / タブ {result.tabs} 個 / 行末の空白{" "}
              {result.trimmedLines} 行 / 空行 {result.removedBlankLines} 行を削除
            </p>
          )}
        </ToolPanel>
      </div>
    </ToolPage>
  );
}
