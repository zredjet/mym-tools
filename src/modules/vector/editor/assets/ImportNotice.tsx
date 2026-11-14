/**
 * 取込の知らせ (取り込まなかった理由、draw.io の SVG の変換など)。ツールバーの上に浮かせる。
 * 閉じるボタンか、次の取込で消える。知らせ (`info`) は少し経つと消える。
 */
import { X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { showImportNotice, useImportStatus } from "./status";

/** `info` の知らせを出しておく時間 (ms)。 */
const INFO_DURATION = 8000;

export function ImportNotice() {
  const { notice } = useImportStatus();

  useEffect(() => {
    if (notice?.tone !== "info") return;
    const timer = window.setTimeout(() => showImportNotice(null), INFO_DURATION);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  const isError = notice.tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      data-canvas-import-notice=""
      className={cn(
        "absolute bottom-[60px] left-1/2 z-10 flex max-w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-start gap-2 rounded-[var(--radius-lg)] border bg-[var(--bg)] px-3 py-2 text-[13px] shadow-[0_8px_24px_rgba(0,0,0,0.10)]",
        isError
          ? "border-[var(--destructive)] text-[var(--fg)]"
          : "border-[var(--border)] text-[var(--fg)]",
      )}
    >
      <span className="min-w-0 flex-1 break-words">{notice.message}</span>
      <button
        type="button"
        aria-label="閉じる"
        className="shrink-0 rounded-[var(--radius-sm)] p-0.5 text-[var(--fg-muted)] hover:bg-[var(--bg-muted)]"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => showImportNotice(null)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
