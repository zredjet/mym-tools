import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { inputClass, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";

import { evaluateContrast, type ContrastResult } from "./contrast";

export function A11yPage() {
  const [foreground, setForeground] = useState("#111827");
  const [background, setBackground] = useState("#FFFFFF");
  const [result, setResult] = useState<ContrastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const execute = () => {
    try {
      setResult(evaluateContrast(foreground, background));
      setError(null);
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ToolPage
      title="Webアクセシビリティ確認"
      description="WCAG 2.2のコントラスト判定と色覚シミュレーションを行います。"
    >
      <ToolPanel title="配色">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[12px]">
            前景色
            <input
              className={`${inputClass} mt-1 block font-mono`}
              value={foreground}
              onChange={(event) => setForeground(event.target.value)}
            />
          </label>
          <input
            aria-label="前景色選択"
            type="color"
            value={/^#[0-9A-Fa-f]{6}$/.test(foreground) ? foreground : "#000000"}
            onChange={(event) => setForeground(event.target.value)}
            className="h-8 w-10"
          />
          <label className="text-[12px]">
            背景色
            <input
              className={`${inputClass} mt-1 block font-mono`}
              value={background}
              onChange={(event) => setBackground(event.target.value)}
            />
          </label>
          <input
            aria-label="背景色選択"
            type="color"
            value={/^#[0-9A-Fa-f]{6}$/.test(background) ? background : "#ffffff"}
            onChange={(event) => setBackground(event.target.value)}
            className="h-8 w-10"
          />
          <Button
            onClick={() => {
              setForeground(background);
              setBackground(foreground);
            }}
          >
            入れ替え
          </Button>
          <Button variant="primary" onClick={execute}>
            判定
          </Button>
        </div>
      </ToolPanel>
      <div className="mt-3">
        <ToolError message={error} />
      </div>
      {result != null && (
        <>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <ToolPanel title={`プレビュー — ${result.ratio.toFixed(2)}:1`}>
              <div
                className="rounded p-6"
                style={{ color: result.foreground, backgroundColor: result.background }}
              >
                <p className="text-base">通常テキストのサンプル</p>
                <p className="text-2xl font-bold">大きなテキストのサンプル</p>
                <button className="mt-3 rounded border border-current px-3 py-1">
                  UI component
                </button>
              </div>
            </ToolPanel>
            <ToolPanel title="WCAG 2.2判定">
              <dl className="grid grid-cols-[1fr_auto_auto] gap-2 text-[12px]">
                <dt>通常文字</dt>
                <Status ok={result.normalAA} label="AA" />
                <Status ok={result.normalAAA} label="AAA" />
                <dt>大きな文字</dt>
                <Status ok={result.largeAA} label="AA" />
                <Status ok={result.largeAAA} label="AAA" />
                <dt>非テキストUI</dt>
                <Status ok={result.nonTextAA} label="AA" />
                <dd>—</dd>
              </dl>
            </ToolPanel>
          </div>
          <ToolPanel title="色覚シミュレーション（近似）" className="mt-4">
            <p className="mb-3 text-[11px] text-[var(--fg-muted)]">
              適合判定ではありません。Machado方式の100% severityを使った見え方の近似です。
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              {Object.entries(result.simulations).map(([kind, colors]) => (
                <div
                  key={kind}
                  className="rounded border border-[var(--border)] p-3"
                  style={{ color: colors.foreground, backgroundColor: colors.background }}
                >
                  <strong>{kind}</strong>
                  <p>Sample text 123</p>
                  <small>
                    {colors.foreground} / {colors.background}
                  </small>
                </div>
              ))}
            </div>
          </ToolPanel>
        </>
      )}
    </ToolPage>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <dd className={ok ? "text-green-600" : "text-red-600"}>
      {label}: {ok ? "Pass" : "Fail"}
    </dd>
  );
}
