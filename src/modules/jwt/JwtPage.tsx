import { useState } from "react";

import { Button } from "@/components/ui/Button";
import {
  CopyButton,
  textareaClass,
  ToolError,
  ToolPage,
  ToolPanel,
} from "@/components/ui/ToolPage";

import { inspectJwt, type JwtInspection } from "./jwtInspector";

export function JwtPage() {
  const [token, setToken] = useState("");
  const [result, setResult] = useState<JwtInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const execute = () => {
    try {
      setResult(inspectJwt(token));
      setError(null);
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ToolPage
      title="JWTインスペクター"
      description="JWTのHeaderとPayloadをローカルで解析します。署名の正当性は検証しません。"
    >
      <p
        role="note"
        className="mb-4 rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 p-2 text-[12px] text-amber-700 dark:text-amber-300"
      >
        表示内容は未検証であり、信頼できる値として扱わないでください。tokenは保存しません。
      </p>
      <ToolPanel title="JWT">
        <textarea
          className={`${textareaClass} h-28`}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="eyJ..."
        />
        <Button className="mt-3" variant="primary" onClick={execute}>
          解析
        </Button>
      </ToolPanel>
      <div className="mt-3">
        <ToolError message={error} />
      </div>
      {result != null && (
        <>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <JsonPanel title="Header" value={result.header} />
            <JsonPanel title="Payload" value={result.payload} />
          </div>
          <ToolPanel title="日時claim" className="mt-4">
            {result.temporalClaims.length === 0 ? (
              <p className="text-[12px] text-[var(--fg-subtle)]">exp / nbf / iat はありません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr>
                      <th>Claim</th>
                      <th>NumericDate</th>
                      <th>UTC</th>
                      <th>JST</th>
                      <th>状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.temporalClaims.map((claim) => (
                      <tr key={claim.name} className="border-t border-[var(--border)]">
                        <td className="py-2 font-mono">{claim.name}</td>
                        <td>{claim.numericDate}</td>
                        <td>{claim.utc}</td>
                        <td>{claim.jst}</td>
                        <td>{claim.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ToolPanel>
          <ToolPanel
            title="Signature segment（未検証）"
            className="mt-4"
            actions={<CopyButton text={result.signature} />}
          >
            <p className="font-mono text-[12px] break-all">{result.signature}</p>
          </ToolPanel>
        </>
      )}
    </ToolPage>
  );
}

function JsonPanel({ title, value }: { title: string; value: Record<string, unknown> }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <ToolPanel title={title} actions={<CopyButton text={text} />}>
      <pre className="max-h-72 overflow-auto rounded bg-[var(--bg-muted)] p-3 text-[12px]">
        {text}
      </pre>
    </ToolPanel>
  );
}
