/**
 * プロジェクト編集ダイアログ (`docs/ui-design.md` §6 C-5)。
 *
 * `name` と `description` の更新のみ。`position` 並び替えは Phase 1 後半 (D&D で別 PR)。
 *
 * ## ショートカット
 * - `Cmd/Ctrl + S` / `Cmd/Ctrl + Enter`: 保存
 * - `Esc`: キャンセル
 */
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { updateProject } from "@/ipc/projects";
import { formatInvokeError } from "@/lib/error";
import type { Project } from "@/lib/types";

interface Props {
  open: boolean;
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}

export function ProjectEditDialog({ open, project, onClose, onSaved }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="プロジェクトを編集">
      {open && <Content project={project} onClose={onClose} onSaved={onSaved} />}
    </Modal>
  );
}

function Content({ project, onClose, onSaved }: Omit<Props, "open">) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !submitting && name.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateProject({
        id: project.id,
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(formatInvokeError(e));
      setSubmitting(false);
    }
  };

  useHotkeys(
    "mod+s, mod+enter",
    (e) => {
      e.preventDefault();
      void handleSubmit();
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
    [name, description, canSubmit, project],
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="project-edit-name" className="text-[13px] font-medium text-[var(--fg)]">
          名前
        </label>
        <input
          id="project-edit-name"
          type="text"
          autoFocus
          required
          maxLength={120}
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="project-edit-description"
          className="text-[13px] font-medium text-[var(--fg)]"
        >
          説明 (任意)
        </label>
        <textarea
          id="project-edit-description"
          rows={3}
          maxLength={500}
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
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          キャンセル <span className="ml-1 text-[10px] text-[var(--fg-subtle)]">Esc</span>
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting ? "保存中..." : "保存"}
          <span className="ml-1 text-[10px] opacity-70">⌘S</span>
        </Button>
      </div>
    </form>
  );
}
