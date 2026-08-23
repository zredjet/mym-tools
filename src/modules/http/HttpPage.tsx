import { useEffect, useRef, useState } from "react";
import { Plus, Send, Square, Trash2 } from "lucide-react";

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
  cancelHttpRequest,
  sendHttpRequest,
  type HttpBodyKind,
  type HttpHeaderInput,
  type HttpResponseOutput,
} from "@/ipc/http";
import { formatInvokeError } from "@/lib/error";

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function responseText(response: HttpResponseOutput | null): string {
  if (response == null || response.body_kind === "binary") return "";
  try {
    return JSON.stringify(JSON.parse(response.body) as unknown, null, 2);
  } catch {
    return response.body;
  }
}

export function HttpPage() {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("https://example.com");
  const [headers, setHeaders] = useState<HttpHeaderInput[]>([
    { name: "Accept", value: "application/json" },
  ]);
  const [bodyKind, setBodyKind] = useState<HttpBodyKind>("none");
  const [body, setBody] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [response, setResponse] = useState<HttpResponseOutput | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      const operationId = operationRef.current;
      if (operationId != null) void cancelHttpRequest(operationId);
    },
    [],
  );

  const updateHeader = (index: number, key: keyof HttpHeaderInput, value: string) => {
    setHeaders((current) =>
      current.map((header, position) =>
        position === index ? { ...header, [key]: value } : header,
      ),
    );
  };

  const send = async () => {
    const previous = operationRef.current;
    if (previous != null) await cancelHttpRequest(previous).catch(() => undefined);
    const operationId = crypto.randomUUID();
    operationRef.current = operationId;
    setPending(true);
    setError(null);
    setResponse(null);
    try {
      const result = await sendHttpRequest(operationId, {
        method,
        url,
        headers: headers.filter((header) => header.name.trim() !== ""),
        body_kind: bodyKind,
        body,
        timeout_ms: timeoutSeconds * 1_000,
      });
      if (operationRef.current === operationId) setResponse(result);
    } catch (cause) {
      if (operationRef.current === operationId) {
        const message = formatInvokeError(cause);
        if (!/cancel/i.test(message)) setError(message);
      }
    } finally {
      if (operationRef.current === operationId) {
        operationRef.current = null;
        setPending(false);
      }
    }
  };

  const cancel = async () => {
    const operationId = operationRef.current;
    if (operationId == null) return;
    try {
      await cancelHttpRequest(operationId);
    } catch (cause) {
      setError(formatInvokeError(cause));
    }
  };

  const displayedBody = responseText(response);

  return (
    <ToolPage
      title="HTTPリクエスト実験ツール"
      description="軽量なRESTリクエストをRust側から送信します。入力や応答は保存しません。"
    >
      <ToolPanel title="Request">
        <div className="flex gap-2">
          <select
            aria-label="HTTP method"
            className={`${inputClass} w-28 font-mono`}
            value={method}
            onChange={(event) => setMethod(event.target.value)}
          >
            {methods.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <input
            aria-label="Request URL"
            className={`${inputClass} min-w-0 flex-1 font-mono`}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            spellCheck={false}
          />
          {pending ? (
            <Button variant="destructive" onClick={() => void cancel()}>
              <Square size={13} aria-hidden />
              停止
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void send()}>
              <Send size={13} aria-hidden />
              送信
            </Button>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold">Headers</h3>
          <Button
            size="sm"
            onClick={() => setHeaders((current) => [...current, { name: "", value: "" }])}
          >
            <Plus size={13} aria-hidden />
            追加
          </Button>
        </div>
        <div className="mt-2 space-y-2">
          {headers.map((header, index) => (
            <div className="flex gap-2" key={`${index}-${headers.length}`}>
              <input
                aria-label={`Header ${index + 1} name`}
                className={`${inputClass} w-1/3 font-mono`}
                placeholder="Header name"
                value={header.name}
                onChange={(event) => updateHeader(index, "name", event.target.value)}
              />
              <input
                aria-label={`Header ${index + 1} value`}
                className={`${inputClass} min-w-0 flex-1 font-mono`}
                placeholder="Value"
                value={header.value}
                onChange={(event) => updateHeader(index, "value", event.target.value)}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Header ${index + 1}を削除`}
                onClick={() =>
                  setHeaders((current) => current.filter((_, position) => position !== index))
                }
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <label className="text-[12px]">
            Body
            <select
              className={`${inputClass} ml-2`}
              value={bodyKind}
              onChange={(event) => setBodyKind(event.target.value as HttpBodyKind)}
            >
              <option value="none">なし</option>
              <option value="text">Text</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <label className="text-[12px]">
            Timeout (秒)
            <input
              className={`${inputClass} ml-2 w-20`}
              type="number"
              min={1}
              max={120}
              value={timeoutSeconds}
              onChange={(event) => setTimeoutSeconds(event.target.valueAsNumber)}
            />
          </label>
        </div>
        {bodyKind !== "none" && (
          <textarea
            aria-label="Request body"
            className={`${textareaClass} mt-3 min-h-32`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            spellCheck={false}
          />
        )}
        <p className="mt-3 text-[11px] text-[var(--fg-muted)]">
          Authorization等の秘密値も含め、リクエスト内容は履歴・ログへ保存しません。
        </p>
      </ToolPanel>

      <div className="mt-3">
        <ToolError message={error} />
      </div>
      <ToolPanel
        title="Response"
        className="mt-4"
        actions={<CopyButton text={displayedBody} label="Bodyをコピー" />}
      >
        {response == null ? (
          <p className="text-[12px] text-[var(--fg-muted)]">応答はまだありません。</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
              <span className="font-semibold">
                {response.status} {response.status_text}
              </span>
              <span>{response.duration_ms} ms</span>
              <span>{response.bytes_received.toLocaleString()} bytes</span>
              <span className="min-w-0 font-mono break-all">{response.final_url}</span>
            </div>
            {response.body_truncated && (
              <p role="status" className="mt-2 text-[12px] text-[var(--destructive)]">
                応答が5 MiBを超えたため、本文を打ち切りました。
              </p>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-[12px] font-semibold">
                Response headers
              </summary>
              <pre className="mt-2 overflow-auto rounded bg-[var(--bg-muted)] p-2 text-[11px]">
                {response.headers.map((header) => `${header.name}: ${header.value}`).join("\n")}
              </pre>
            </details>
            {response.body_kind === "binary" ? (
              <p className="mt-3 rounded bg-[var(--bg-muted)] p-3 text-[12px]">
                バイナリ応答の本文は表示しません。
              </p>
            ) : (
              <pre className="mt-3 max-h-96 overflow-auto rounded bg-[var(--bg-muted)] p-3 font-mono text-[12px] break-words whitespace-pre-wrap">
                {displayedBody}
              </pre>
            )}
          </>
        )}
      </ToolPanel>
    </ToolPage>
  );
}
