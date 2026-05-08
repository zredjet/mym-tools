/**
 * M-Color 一覧 (`docs/ui-design.md` §6.5 / §9.3)。
 *
 * Phase 1 PR-J: 空状態のスケルトンのみ。HEX/RGB/HSL/OKLCH のフロント変換 + パレット
 * グリッド表示 (K-1) は次 PR で実装する。
 */
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export function ColorListPage() {
  return (
    <div className="flex h-full flex-col px-[var(--page-pad)] py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Colors</h1>
        <Button variant="primary" disabled>
          <Plus size={14} aria-hidden /> 新規 Color
        </Button>
      </header>
      <div className="flex-1 rounded-[var(--radius)] border border-dashed border-[var(--border)]">
        <EmptyState
          icon="🎨"
          title="パレットが空です"
          description="ブランド色や UI トークンを HEX / RGB / HSL / OKLCH で管理できます。CRUD UI は次 PR で実装予定です。"
          actions={
            <Button variant="primary" disabled>
              <Plus size={14} aria-hidden /> 新規 Color
            </Button>
          }
        />
      </div>
    </div>
  );
}
