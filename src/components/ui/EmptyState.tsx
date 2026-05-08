/**
 * 空状態の共通コンポーネント (`docs/ui-design.md` §9)。
 *
 * 各モジュールの一覧で 0 件のときの表示に使う。アイコン + タイトル + サブテキスト + CTA。
 */
import type { ReactNode } from "react";

interface EmptyStateProps {
  /** 大きめの絵文字 / アイコン */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** CTA (1〜2 個想定) を `actions` に並べる */
  actions?: ReactNode;
}

export function EmptyState({ icon, title, description, actions }: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {icon != null && <div className="text-4xl leading-none">{icon}</div>}
      <h2 className="text-base font-semibold text-[var(--fg)]">{title}</h2>
      {description != null && (
        <p className="max-w-md text-[13px] text-[var(--fg-muted)]">{description}</p>
      )}
      {actions != null && <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
