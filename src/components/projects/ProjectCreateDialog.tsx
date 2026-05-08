/**
 * プロジェクト新規作成ダイアログ (`docs/ui-design.md` §6 C-4)。
 *
 * Phase 1: 名前 + 説明のみ。アクセント色欄は §2.1.1 で Phase 2 持ち越し。
 */
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createProject } from "@/ipc/projects";
import { formatInvokeError } from "@/lib/error";
import type { Project } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 作成成功時に呼ばれる。作成された Project を引数で渡す (親側で auto-navigate 等に利用可) */
  onCreated: (project: Project) => void;
}

export function ProjectCreateDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setError(null);
    setSubmitting(false);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
      });
      onCreated(project);
      reset();
      onClose();
    } catch (err) {
      setError(formatInvokeError(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title="新規プロジェクト">
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="project-name" className="text-[13px] font-medium text-[var(--fg)]">
            名前
          </label>
          <input
            id="project-name"
            type="text"
            autoFocus
            required
            maxLength={120}
            placeholder="MyProject"
            className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="project-description" className="text-[13px] font-medium text-[var(--fg)]">
            説明 (任意)
          </label>
          <textarea
            id="project-description"
            rows={3}
            maxLength={500}
            placeholder="このプロジェクトの目的やメモ"
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
          />
        </div>
        {error != null && (
          <p role="alert" className="text-[13px] text-[var(--destructive)]">
            {error}
          </p>
        )}
        <div className="mt-1 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
            {submitting ? "作成中..." : "作成"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
