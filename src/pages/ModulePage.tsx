/**
 * モジュールページ dispatcher。`/projects/:projectId/m/:moduleId` でモジュール ID に
 * 応じた一覧コンポーネントへ振り分ける。
 *
 * Phase 1 PR-J: 一覧 (P-1 / L-1 / K-1) のみ。詳細・編集 (P-2/P-3 等) は `Routes` を
 * モジュール内側に持つ形に拡張する想定 (`module-contract.md` §4.1 ModuleRoute)。
 */
import { useParams } from "react-router-dom";

import { ColorListPage } from "@/modules/color/ColorListPage";
import { LinkMemoListPage } from "@/modules/linkmemo/LinkMemoListPage";
import { PromptListPage } from "@/modules/prompt/PromptListPage";
import type { ModuleId } from "@/lib/types";

export function ModulePage() {
  const { moduleId } = useParams<{ moduleId: ModuleId }>();

  switch (moduleId) {
    case "prompt":
      return <PromptListPage />;
    case "linkmemo":
      return <LinkMemoListPage />;
    case "color":
      return <ColorListPage />;
    default:
      return (
        <div className="m-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--fg-muted)]">
          未知のモジュール: <code className="font-mono">{moduleId}</code>
        </div>
      );
  }
}
