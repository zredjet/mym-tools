/**
 * M-LinkMemo 一覧 (`docs/ui-design.md` §6.4 / §9.2)。
 *
 * Phase 1 PR-J: 空状態のスケルトンのみ。type 別アイコン / `linkmemo_open` /
 * `linkmemo_normalize_target` の UI 接続は次 PR で実装する。
 */
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export function LinkMemoListPage() {
  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Links / Memos</h1>
        <Button variant="primary" disabled>
          <Plus size={14} aria-hidden /> 新規 Link/Memo
        </Button>
      </header>
      <div className="flex-1 rounded-[var(--radius)] border border-dashed border-[var(--border)]">
        <EmptyState
          icon="🔗"
          title="Link / Memo を追加しましょう"
          description="URL / ローカルパス / メモをプロジェクトごとに整理できます。CRUD UI は次 PR で実装予定です。"
          actions={
            <Button variant="primary" disabled>
              <Plus size={14} aria-hidden /> 新規 Link/Memo
            </Button>
          }
        />
      </div>
    </div>
  );
}
