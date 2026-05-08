/**
 * モジュールページ dispatcher。`/projects/:projectId/m/:moduleId` でモジュール ID に
 * 応じた一覧コンポーネントへ振り分ける。
 *
 * Phase 1 PR-J: 一覧 (P-1 / L-1 / K-1) のみ。詳細・編集 (P-2/P-3 等) は `Routes` を
 * モジュール内側に持つ形に拡張する想定 (`module-contract.md` §4.1 ModuleRoute)。
 *
 * **`key={projectId-moduleId}` の意図** (PR #32 codex P1 対応):
 * projectId / moduleId が変わったらコンポーネントを完全に remount し、内部 state
 * (items / loading / error) を自然にリセットする。これによって listItems の
 * transient 失敗で旧プロジェクトの items が残り続け、誤削除に繋がる事故を防ぐ。
 */
import { useParams } from "react-router-dom";

import { ColorListPage } from "@/modules/color/ColorListPage";
import { LinkMemoListPage } from "@/modules/linkmemo/LinkMemoListPage";
import { PromptListPage } from "@/modules/prompt/PromptListPage";
import type { ModuleId } from "@/lib/types";

export function ModulePage() {
  const { projectId, moduleId } = useParams<{ projectId: string; moduleId: ModuleId }>();
  const key = `${projectId ?? "none"}-${moduleId ?? "none"}`;

  switch (moduleId) {
    case "prompt":
      return <PromptListPage key={key} />;
    case "linkmemo":
      return <LinkMemoListPage key={key} />;
    case "color":
      return <ColorListPage key={key} />;
    default:
      return (
        <div className="m-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--fg-muted)]">
          未知のモジュール: <code className="font-mono">{moduleId}</code>
        </div>
      );
  }
}
