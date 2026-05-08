/**
 * 初回起動 / プロジェクト 0 件のときの Welcome 画面 (`docs/ui-design.md` §9.5 C-2)。
 *
 * `AppShell` の Outlet で表示される。サイドバーの `+ PROJECTS` ボタンか中央の CTA から
 * プロジェクト作成ダイアログを開く。CTA はサイドバーへの誘導テキストのみ (実モーダルは
 * Sidebar 側で持つ。Phase 1 では `useState` を AppShell に持ち上げない、UI 規律)。
 */
import { ArrowLeft } from "lucide-react";

import { EmptyState } from "@/components/ui/EmptyState";

export function WelcomePage() {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon="👋"
        title="MyMyTools へようこそ"
        description="左サイドバー上部の [+] からプロジェクトを作成して始めましょう。Hash モジュールはプロジェクトなしで使えます。"
        actions={
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--fg-subtle)]">
            <ArrowLeft size={14} aria-hidden /> サイドバーの PROJECTS [+] から作成
          </span>
        }
      />
    </div>
  );
}
