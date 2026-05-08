/**
 * 最小ボタン (`docs/ui-design.md` §2.1.2 ボタン variant)。shadcn の Button を入れる前の
 * Phase 1 暫定実装。primary / secondary / ghost / destructive の 4 variant を持つ。
 *
 * shadcn 既定値 > カスタマイズ (CLAUDE.md UI 規約) のため、shadcn 導入時は本ファイルを
 * 削除して `import { Button } from "@/components/ui/button"` に置換する。
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

const baseClass =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius)] " +
  "font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] " +
  "focus-visible:ring-offset-2";

const sizeClass: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px]",
  md: "h-8 px-3 text-sm",
};

const variantClass: Record<Variant, string> = {
  primary: "bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-95 active:opacity-90",
  secondary:
    "border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:bg-[var(--bg-muted)]",
  ghost: "text-[var(--fg)] hover:bg-[var(--bg-muted)]",
  destructive: "bg-[var(--destructive)] text-white hover:opacity-95 active:opacity-90",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(baseClass, sizeClass[size], variantClass[variant], className)}
      {...rest}
    >
      {children}
    </button>
  );
}
