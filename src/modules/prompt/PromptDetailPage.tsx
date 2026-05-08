/**
 * M-Prompt 詳細 / 変数差し込みプレビュー (`docs/ui-design.md` §6.3 P-2 / §8.5)。
 *
 * Phase 1 PR-L (本 PR):
 * - 変数フォーム (検出した `{{name}}` ごとに input)
 * - プレビュー (`prompt_render_template` 経由で差し込み後の本文)
 * - クリップボードコピー (`Cmd/Ctrl+C` でプレビュー、`Cmd/Ctrl+Shift+C` で raw 本文)
 * - 編集 (P-3 full editor) は次 PR
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { getItem } from "@/ipc/items";
import { promptRenderTemplate } from "@/ipc/prompt";
import { formatInvokeError } from "@/lib/error";
import { extractPromptVariables } from "@/lib/promptVars";
import type { Item, PromptPayloadV1 } from "@/lib/types";

export function PromptDetailPage() {
  const { projectId, itemId } = useParams<{ projectId: string; itemId: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState("");
  const [copied, setCopied] = useState<"preview" | "raw" | null>(null);

  // 1) item ロード
  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const fetched = await getItem({ moduleId: "prompt", itemId });
        if (!cancelled) {
          setItem(fetched);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const body = useMemo(() => {
    const p = item?.payload as PromptPayloadV1 | undefined;
    return typeof p?.body === "string" ? p.body : "";
  }, [item]);

  const detectedVars = useMemo(() => extractPromptVariables(body), [body]);

  // 2) 変数値変更時にプレビュー再計算 (`prompt_render_template` 経由)
  useEffect(() => {
    if (body === "") {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rendered = await promptRenderTemplate({ body, variables });
        if (!cancelled) setPreview(rendered);
      } catch (e) {
        if (!cancelled) setError(formatInvokeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [body, variables]);

  const copy = useCallback(async (text: string, kind: "preview" | "raw") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      // 2 秒後にバッジを消す
      window.setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      setError(formatInvokeError(e));
    }
  }, []);

  // 3) ショートカット (`docs/ui-design.md` §8.5)
  useHotkeys(
    "mod+c",
    (e) => {
      // 入力フォーカス中は normal copy を妨げない
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      void copy(preview, "preview");
    },
    [preview, copy],
  );
  useHotkeys(
    "mod+shift+c",
    (e) => {
      e.preventDefault();
      void copy(body, "raw");
    },
    [body, copy],
  );

  if (loading) {
    return (
      <div className="px-[var(--page-pad)] py-6 text-[13px] text-[var(--fg-subtle)]">読込中...</div>
    );
  }

  if (item == null || error != null) {
    return (
      <div className="m-6 rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-3 text-sm text-[var(--destructive)]">
        {error ?? "プロンプトが見つかりません"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 px-[var(--page-pad)] py-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/projects/${projectId ?? ""}/m/prompt`)}
            aria-label="一覧へ戻る"
          >
            <ArrowLeft size={14} aria-hidden /> 一覧
          </Button>
          <h1 className="truncate text-lg font-semibold" title={item.title}>
            {item.title}
          </h1>
          {item.tags.length > 0 && (
            <span className="ml-1 truncate text-[12px] text-[var(--fg-muted)]">
              {item.tags.map((t) => `#${t}`).join(" ")}
            </span>
          )}
        </div>
      </header>

      {detectedVars.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-[0.05em] text-[var(--fg-subtle)] uppercase">
            変数
          </h2>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {detectedVars.map((name) => (
              <label
                key={name}
                className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-[var(--border)] p-2"
              >
                <span className="font-mono text-[12px] text-[var(--accent)]">{`{{${name}}}`}</span>
                <input
                  type="text"
                  value={variables[name] ?? ""}
                  onChange={(e) => setVariables((prev) => ({ ...prev, [name]: e.target.value }))}
                  placeholder={`${name} の値`}
                  className="h-7 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
                />
              </label>
            ))}
          </div>
        </section>
      )}

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold tracking-[0.05em] text-[var(--fg-subtle)] uppercase">
            {detectedVars.length > 0 ? "プレビュー (差し込み後)" : "本文"}
          </h2>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(preview, "preview")}
              title="Cmd/Ctrl+C"
            >
              {copied === "preview" ? (
                <>
                  <Check size={14} aria-hidden /> コピー済
                </>
              ) : (
                <>
                  <Copy size={14} aria-hidden /> 完成プロンプトをコピー
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copy(body, "raw")}
              title="Cmd/Ctrl+Shift+C"
            >
              {copied === "raw" ? (
                <>
                  <Check size={14} aria-hidden /> コピー済
                </>
              ) : (
                "raw コピー"
              )}
            </Button>
          </div>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-3 font-mono text-[13px] whitespace-pre-wrap text-[var(--fg)]">
          {preview === "" ? body : preview}
        </pre>
      </section>
    </div>
  );
}
