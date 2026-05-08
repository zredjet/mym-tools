/**
 * M-Prompt 一覧 (`docs/ui-design.md` §6.2 / §9.1)。
 *
 * Phase 1 PR-J: 空状態のスケルトンのみ。ItemList / Detail / Editor (P-1〜P-3) は
 * `ScopedStorage` の Tauri commands を露出する次 PR で実装する。
 */
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export function PromptListPage() {
  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Prompts</h1>
        <Button variant="primary" disabled>
          <Plus size={14} aria-hidden /> 新規プロンプト
        </Button>
      </header>
      <div className="flex-1 rounded-[var(--radius)] border border-dashed border-[var(--border)]">
        <EmptyState
          icon="📝"
          title="まだプロンプトがありません"
          description="よく使うプロンプトを保存して、変数差し込みで再利用できます。CRUD UI は次 PR で実装予定です。"
          actions={
            <>
              <Button variant="primary" disabled>
                <Plus size={14} aria-hidden /> 新規プロンプト
              </Button>
              <Button variant="secondary" disabled>
                サンプルから始める
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
