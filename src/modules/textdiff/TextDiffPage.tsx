import { useEffect, useRef, useState } from "react";
import type { Change } from "diff";

import { Button } from "@/components/ui/Button";
import {
  inputClass,
  textareaClass,
  ToolError,
  ToolPage,
  ToolPanel,
} from "@/components/ui/ToolPage";

import type { DiffMode } from "./textDiff";

export function TextDiffPage() {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [mode, setMode] = useState<DiffMode>("lines");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [result, setResult] = useState<Change[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);

  useEffect(() => () => workerRef.current?.terminate(), []);
  const execute = () => {
    workerRef.current?.terminate();
    const id = ++requestId.current;
    const worker = new Worker(new URL("./textDiff.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setPending(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      if (requestId.current !== id) return;
      worker.terminate();
      workerRef.current = null;
      setPending(false);
      setResult([]);
      setError("差分計算が2秒を超えたため停止しました");
    }, 2000);
    worker.onmessage = (event: MessageEvent<{ id: number; result?: Change[]; error?: string }>) => {
      if (event.data.id !== id || requestId.current !== id) return;
      window.clearTimeout(timeout);
      worker.terminate();
      workerRef.current = null;
      setPending(false);
      if (event.data.error != null) {
        setResult([]);
        setError(event.data.error);
      } else setResult(event.data.result ?? []);
    };
    worker.postMessage({ id, input: { left, right, mode, ignoreWhitespace, ignoreCase } });
  };

  return (
    <ToolPage
      title="テキスト差分ビューア"
      description="左右のテキストを行単位または単語単位で比較します。"
    >
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <select
          className={inputClass}
          value={mode}
          onChange={(event) => setMode(event.target.value as DiffMode)}
        >
          <option value="lines">行差分</option>
          <option value="words">単語差分</option>
        </select>
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={ignoreWhitespace}
            onChange={(event) => setIgnoreWhitespace(event.target.checked)}
          />
          空白を無視
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={ignoreCase}
            onChange={(event) => setIgnoreCase(event.target.checked)}
          />
          大文字小文字を無視
        </label>
        <Button variant="primary" onClick={execute} disabled={pending}>
          {pending ? "比較中..." : "比較"}
        </Button>
      </div>
      <ToolError message={error} />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ToolPanel title="左">
          <textarea
            className={`${textareaClass} h-64`}
            value={left}
            onChange={(event) => setLeft(event.target.value)}
          />
        </ToolPanel>
        <ToolPanel title="右">
          <textarea
            className={`${textareaClass} h-64`}
            value={right}
            onChange={(event) => setRight(event.target.value)}
          />
        </ToolPanel>
      </div>
      <ToolPanel title="差分" className="mt-4">
        <pre className="max-h-72 overflow-auto rounded bg-[var(--bg-muted)] p-3 font-mono text-[12px] whitespace-pre-wrap">
          {result.length === 0
            ? "—"
            : result.map((change, index) => (
                <span
                  key={index}
                  className={
                    change.added
                      ? "bg-green-500/20 text-green-700 dark:text-green-300"
                      : change.removed
                        ? "bg-red-500/20 text-red-700 line-through dark:text-red-300"
                        : ""
                  }
                >
                  {change.value}
                </span>
              ))}
        </pre>
      </ToolPanel>
    </ToolPage>
  );
}
