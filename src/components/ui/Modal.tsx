/**
 * 軽量モーダル (Phase 1 の暫定。shadcn の Dialog 導入後に置き換える)。
 *
 * - `Esc` キーで閉じる (ui-design.md §8.1)。モーダルを重ねた場合は最前面だけが閉じる
 * - 背景クリックで閉じる
 * - Tab / Shift+Tab はモーダル内で循環し、背後の要素へ移らない
 * - 開いたときにフォーカスをモーダル内へ移し (中の autoFocus は尊重)、閉じたら元の要素へ戻す
 * - 見出し id は `useId` で一意にし、重ねたモーダルでも `aria-labelledby` が自分の見出しを指す
 */
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 任意の幅クラス (`max-w-md` 等)。指定なしは `max-w-md` */
  widthClassName?: string;
}

/** 開いているモーダルの順序 (末尾が最前面)。Escape を最前面だけに処理させる */
const openModals: string[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children, widthClassName }: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    openModals.push(id);
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel != null && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }

    const handler = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== id) return;
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || panel == null) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      const index = openModals.lastIndexOf(id);
      if (index >= 0) openModals.splice(index, 1);
      if (previousFocus != null && previousFocus.isConnected) previousFocus.focus();
    };
  }, [open, id]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={title != null ? titleId : undefined}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-24"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-2xl ring-1 ring-[var(--border)] outline-none",
          widthClassName ?? "w-full max-w-md",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title != null && (
          <div className="border-b border-[var(--border)] px-4 py-3">
            <h2 id={titleId} className="text-base font-semibold text-[var(--fg)]">
              {title}
            </h2>
          </div>
        )}
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  );
}
