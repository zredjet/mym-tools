import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Code2, Copy, Eye, Pencil } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { MarkdownView } from "@/components/ui/MarkdownView";
import { getItem } from "@/ipc/items";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { Item, MemoPayloadV1 } from "@/lib/types";
import { modulePath } from "@/modules/registry";

export function MemoDetailPage() {
  const { projectId, itemId } = useParams<{ projectId: string; itemId: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"markdown" | "raw">("markdown");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    void getItem({ moduleId: "memo", itemId })
      .then((result) => {
        if (!cancelled) setItem(result);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(formatInvokeError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const body = useMemo(
    () => (item?.payload as Partial<MemoPayloadV1> | undefined)?.body ?? "",
    [item],
  );
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setActionError(null);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      setActionError(formatInvokeError(cause));
    }
  }, [body]);

  if (loading)
    return <div className="p-6 text-sm text-[var(--fg-subtle)]">メモを読み込んでいます...</div>;
  if (item == null || loadError != null)
    return (
      <div role="alert" className="m-6 text-sm text-[var(--destructive)]">
        {loadError ?? "メモが見つかりません"}
      </div>
    );
  const listPath = modulePath(projectId ?? item.project_id, "memo");

  return (
    <div className="flex h-full flex-col gap-4 px-[var(--page-pad)] py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(listPath)}>
            <ArrowLeft size={14} /> 一覧
          </Button>
          <h1 className="truncate text-lg font-semibold">{item.title}</h1>
          {item.tags.length > 0 && (
            <span className="truncate text-[12px] text-[var(--fg-muted)]">
              {item.tags.map((tag) => `#${tag}`).join(" ")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
            {copied ? "コピー済" : "本文をコピー"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate(modulePath(item.project_id, "memo", `/edit/${item.id}`))}
          >
            <Pencil size={14} /> 編集
          </Button>
        </div>
      </header>
      {actionError != null && (
        <div role="alert" className="text-sm text-[var(--destructive)]">
          {actionError}
        </div>
      )}
      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex w-fit overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
          <ViewButton selected={viewMode === "markdown"} onClick={() => setViewMode("markdown")}>
            <Eye size={12} /> Markdown
          </ViewButton>
          <ViewButton selected={viewMode === "raw"} onClick={() => setViewMode("raw")}>
            <Code2 size={12} /> Raw
          </ViewButton>
        </div>
        {viewMode === "markdown" ? (
          <div className="min-h-0 flex-1 overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-4">
            <MarkdownView source={body} />
          </div>
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-4 font-mono text-[13px] whitespace-pre-wrap text-[var(--fg)]">
            {body}
          </pre>
        )}
      </section>
    </div>
  );
}

function ViewButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 px-2 py-1 text-[12px]",
        selected ? "bg-[var(--bg-accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]",
      )}
    >
      {children}
    </button>
  );
}
