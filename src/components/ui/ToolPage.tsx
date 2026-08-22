import type { ReactNode } from "react";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/Button";

export function ToolPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-[var(--fg)]">{title}</h1>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">{description}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

export function ToolPanel({
  title,
  actions,
  children,
  className = "",
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[var(--radius)] border border-[var(--border)] p-4 ${className}`}>
      <div className="mb-3 flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-[var(--fg)]">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function CopyButton({ text, label = "コピー" }: { text: string; label?: string }) {
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text);
      }}
      disabled={text === ""}
    >
      <Copy size={13} aria-hidden />
      {label}
    </Button>
  );
}

export const inputClass =
  "h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

export const textareaClass =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[13px] text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

export function ToolError({ message }: { message: string | null }) {
  if (message == null) return null;
  return (
    <p
      role="alert"
      className="rounded-[var(--radius)] border border-[var(--destructive)] bg-[var(--destructive)]/10 p-2 text-[12px] text-[var(--destructive)]"
    >
      {message}
    </p>
  );
}
