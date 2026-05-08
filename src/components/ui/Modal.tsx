/**
 * 軽量モーダル (Phase 1 の暫定。shadcn の Dialog 導入後に置き換える)。
 *
 * - `Esc` キーで閉じる (ui-design.md §8.1)
 * - 背景クリックで閉じる
 * - フォーカスは shadcn 導入後に Radix Dialog 経由で適切に管理する
 */
import { useEffect, type ReactNode } from "react";

import { cn } from "@/lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 任意の幅クラス (`max-w-md` 等)。指定なしは `max-w-md` */
  widthClassName?: string;
}

export function Modal({ open, onClose, title, children, widthClassName }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={title != null ? "modal-title" : undefined}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-24"
      onClick={onClose}
    >
      <div
        className={cn(
          "rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-2xl ring-1 ring-[var(--border)]",
          widthClassName ?? "w-full max-w-md",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title != null && (
          <div className="border-b border-[var(--border)] px-4 py-3">
            <h2 id="modal-title" className="text-base font-semibold text-[var(--fg)]">
              {title}
            </h2>
          </div>
        )}
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  );
}
