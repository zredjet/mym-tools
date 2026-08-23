import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import {
  CopyButton,
  inputClass,
  textareaClass,
  ToolError,
  ToolPage,
  ToolPanel,
} from "@/components/ui/ToolPage";

import type { RegexEvaluation } from "./regexEngine";

export function RegexPage() {
  const [pattern, setPattern] = useState("(?<word>\\w+)");
  const [flags, setFlags] = useState("gu");
  const [text, setText] = useState("hello world");
  const [replacement, setReplacement] = useState("<$<word>>");
  const [result, setResult] = useState<RegexEvaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);

  const cancel = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setPending(false);
  };
  useEffect(() => cancel, []);

  const execute = () => {
    cancel();
    const id = ++requestId.current;
    const worker = new Worker(new URL("./regex.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setPending(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      if (requestId.current !== id) return;
      cancel();
      setResult(null);
      setError("正規表現の評価が1秒を超えたため停止しました");
    }, 1000);
    worker.onmessage = (
      event: MessageEvent<{ id: number; result?: RegexEvaluation; error?: string }>,
    ) => {
      if (event.data.id !== id || requestId.current !== id) return;
      window.clearTimeout(timeout);
      worker.terminate();
      workerRef.current = null;
      setPending(false);
      if (event.data.error != null) {
        setResult(null);
        setError(event.data.error);
      } else setResult(event.data.result ?? null);
    };
    worker.postMessage({ id, input: { pattern, flags, text, replacement } });
  };

  return (
    <ToolPage
      title="正規表現プレイグラウンド"
      description="ECMAScript RegExpのmatch、capture、置換結果をWorker内で安全に確認します。"
    >
      <ToolPanel title="正規表現">
        <div className="grid gap-3 md:grid-cols-[1fr_8rem_auto]">
          <input
            aria-label="pattern"
            className={`${inputClass} font-mono`}
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
          />
          <input
            aria-label="flags"
            className={`${inputClass} font-mono`}
            value={flags}
            onChange={(event) => setFlags(event.target.value)}
          />
          <Button variant="primary" onClick={execute} disabled={pending}>
            {pending ? "評価中..." : "評価"}
          </Button>
        </div>
      </ToolPanel>
      <div className="mt-3">
        <ToolError message={error} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ToolPanel title="テスト文字列">
          <textarea
            className={`${textareaClass} h-56`}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </ToolPanel>
        <ToolPanel title={`Match (${result?.matches.length ?? 0})`}>
          <ol className="max-h-56 overflow-auto font-mono text-[12px]">
            {result?.matches.map((match, index) => (
              <li key={`${match.index}-${index}`} className="mb-2 rounded bg-[var(--bg-muted)] p-2">
                <strong>
                  @{match.index}: {JSON.stringify(match.text)}
                </strong>
                {match.captures.length > 0 && <div>captures: {JSON.stringify(match.captures)}</div>}
                {Object.keys(match.groups).length > 0 && (
                  <div>groups: {JSON.stringify(match.groups)}</div>
                )}
              </li>
            ))}
          </ol>
        </ToolPanel>
      </div>
      <ToolPanel
        title="置換プレビュー"
        className="mt-4"
        actions={<CopyButton text={result?.replacement ?? ""} />}
      >
        <input
          className={`${inputClass} mb-3 w-full font-mono`}
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
        />
        <pre className="min-h-16 rounded bg-[var(--bg-muted)] p-3 text-[12px] whitespace-pre-wrap">
          {result?.replacement ?? "—"}
        </pre>
      </ToolPanel>
    </ToolPage>
  );
}
