/**
 * アイテムを別のプロジェクトへ移すダイアログ (`docs/ui-design.md` §6.28 C-17)。
 *
 * - 移動先は、開くたびに取得したプロジェクト一覧から今のプロジェクトを除いたもの
 *   (サイドバーと同じ並び)。1 つ選ぶまで「移動」は押せない
 * - 変わるのは所属だけで、内容と更新日時はそのまま (`docs/data-model.md` §6.6)
 * - 成功したら `onMoved` で親に知らせてから閉じる。親は一覧を取り直す
 */
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { moveItem } from "@/ipc/items";
import { listProjects } from "@/ipc/projects";
import { formatInvokeError } from "@/lib/error";
import type { ModuleId, Project } from "@/lib/types";

interface Props {
  /** 移動するアイテム。`null` の間は閉じている */
  item: { id: string; title: string } | null;
  moduleId: ModuleId;
  /** アイテムが今あるプロジェクト。移動先の候補から除く */
  currentProjectId: string;
  /** アイテムの種類のラベル (例: 「プロンプト」「Link」) */
  entityLabel: string;
  onClose: () => void;
  /** 移動が成功した直後に、移動先のプロジェクトを渡して呼ぶ */
  onMoved: (target: Project) => void;
}

export function MoveItemDialog({ item, entityLabel, onClose, ...rest }: Props) {
  return (
    <Modal
      open={item != null}
      onClose={onClose}
      title={`${entityLabel}を別のプロジェクトへ移動`}
      widthClassName="w-full max-w-md"
    >
      {item != null && <MoveItemContent key={item.id} item={item} onClose={onClose} {...rest} />}
    </Modal>
  );
}

function MoveItemContent({
  item,
  moduleId,
  currentProjectId,
  onClose,
  onMoved,
}: Omit<Props, "item" | "entityLabel"> & { item: { id: string; title: string } }) {
  const [targets, setTargets] = useState<Project[] | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupName = useId();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const projects = await listProjects();
        if (!cancelled) setTargets(projects.filter((project) => project.id !== currentProjectId));
      } catch (cause) {
        if (!cancelled) setError(formatInvokeError(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = targets?.find((project) => project.id === targetId);
    if (target == null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await moveItem({ moduleId, itemId: item.id, targetProjectId: target.id });
    } catch (cause) {
      setError(formatInvokeError(cause));
      setSubmitting(false);
      return;
    }
    onMoved(target);
    onClose();
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <p className="text-[13px] break-words text-[var(--fg)]">
        「{item.title}」の移動先を選んでください。
      </p>
      <p className="mt-1 text-[12px] text-[var(--fg-muted)]">内容と更新日時は変わりません。</p>

      <div className="mt-3">
        {targets == null ? (
          error == null && <p className="text-[13px] text-[var(--fg-subtle)]">読込中...</p>
        ) : targets.length === 0 ? (
          <p className="text-[13px] text-[var(--fg-muted)]">
            移動先にできるプロジェクトがありません。先にプロジェクトを作成してください。
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-label="移動先のプロジェクト"
            className="max-h-64 divide-y divide-[var(--border)] overflow-auto rounded-[var(--radius)] border border-[var(--border)]"
          >
            {targets.map((project, index) => (
              <label
                key={project.id}
                className="flex h-[var(--row-h)] cursor-pointer items-center gap-2 px-3 text-[13px] text-[var(--fg)] hover:bg-[var(--bg-muted)]"
              >
                <input
                  type="radio"
                  name={groupName}
                  value={project.id}
                  autoFocus={index === 0}
                  checked={targetId === project.id}
                  disabled={submitting}
                  onChange={() => setTargetId(project.id)}
                />
                <span className="min-w-0 truncate">{project.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {error != null && (
        <p role="alert" className="mt-3 text-[13px] break-words text-[var(--destructive)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          キャンセル
        </Button>
        <Button type="submit" variant="primary" disabled={targetId == null || submitting}>
          {submitting ? "移動中..." : "移動"}
        </Button>
      </div>
    </form>
  );
}
