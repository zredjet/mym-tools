import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { MIXED, type Mixed } from "./values";

/** プロパティパネルの節。見出しと、右端の小さな操作 (追加・削除など)。 */
export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title} className="border-b border-[var(--border)] px-3 py-2.5">
      <div className="flex h-7 items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium tracking-[0.05em] text-[var(--fg-muted)]">
          {title}
        </h3>
        {actions !== undefined && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      {children !== undefined && <div className="mt-1 flex flex-col gap-1.5">{children}</div>}
    </section>
  );
}

/** 2 列に並べる。 */
export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-1.5">{children}</div>;
}

/**
 * アイコンだけの小さなボタン (`pdfmerge` の IconButton と同じ作り)。
 * 共通の `Button` は `px-0` で余白を消せず (tailwind-merge を入れていないため)、28 px 幅では
 * アイコンが潰れるので、ここでは素の button にする。
 */
export function IconButton({
  label,
  compact,
  title,
  onClick,
  disabled,
  children,
}: {
  label: string;
  /** 幅を 20 px にする (停止点の行など) */
  compact?: boolean;
  /** ツールチップ。省略すると `label` */
  title?: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)]",
        compact ? "w-5" : "w-7",
        "hover:bg-[var(--bg-muted)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-35",
        "disabled:hover:bg-transparent disabled:hover:text-[var(--fg-muted)]",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none",
      )}
    >
      {children}
    </button>
  );
}

/** チェックボックス。「混在」は不確定の表示にし、押すと入にする。 */
export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean | Mixed;
  onChange(checked: boolean): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = checked === MIXED;
  }, [checked]);
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2 text-[12px] text-[var(--fg)] select-none">
      <input
        ref={input}
        type="checkbox"
        className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
        checked={checked === true}
        aria-checked={checked === MIXED ? "mixed" : checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/** 押した状態を持つボタンを並べた切替 (塗りの種類など)。 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  /** null は「混在」(どれも押していない) */
  value: T | null;
  onChange(value: T): void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid h-7 auto-cols-fr grid-flow-col gap-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-muted)] p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={cn(
            "rounded-[3px] text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none",
            value === option.value
              ? "bg-[var(--bg)] font-medium text-[var(--fg)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
              : "text-[var(--fg-muted)] hover:text-[var(--fg)]",
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
