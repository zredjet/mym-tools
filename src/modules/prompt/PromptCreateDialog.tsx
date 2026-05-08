/**
 * プロンプト新規作成ダイアログ (`docs/ui-design.md` §6.4 P-3 の最小版)。
 *
 * Phase 1 PR-K: title + tags + body のみ。フォーカス時の変数差し込みプレビュー
 * (P-3 の右ペイン) は次 PR で拡張予定。
 */
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";
import { extractPromptVariables } from "@/lib/promptVars";

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}

export function PromptCreateDialog({ open, projectId, onClose, onCreated }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="新規プロンプト" widthClassName="w-full max-w-2xl">
      {open && (
        <PromptCreateContent projectId={projectId} onCreated={onCreated} onClose={onClose} />
      )}
    </Modal>
  );
}

function PromptCreateContent({
  projectId,
  onCreated,
  onClose,
}: {
  projectId: string;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectedVars = useMemo(() => extractPromptVariables(body), [body]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter((t) => t.length > 0);
      await createItem({
        moduleId: "prompt",
        projectId,
        title: title.trim(),
        tags,
        payload: { body: body.trim() },
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(formatInvokeError(err));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <Field label="タイトル" htmlFor="prompt-title">
        <input
          id="prompt-title"
          type="text"
          autoFocus
          required
          maxLength={200}
          placeholder="翻訳プロンプト (英→日)"
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={submitting}
        />
      </Field>

      <Field label="タグ (カンマ区切り、`#` は省略可)" htmlFor="prompt-tags">
        <input
          id="prompt-tags"
          type="text"
          maxLength={200}
          placeholder="lang, ai"
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          disabled={submitting}
        />
      </Field>

      <Field label="本文 (Markdown)" htmlFor="prompt-body">
        <textarea
          id="prompt-body"
          required
          rows={8}
          placeholder={"Translate the following to {{language}}: {{text}}"}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-2.5 font-mono text-[13px] text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={submitting}
        />
      </Field>

      {detectedVars.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="text-[var(--fg-subtle)]">検出された変数:</span>
          {detectedVars.map((v) => (
            <code
              key={v}
              className="rounded-full bg-[var(--bg-accent-soft)] px-2 py-0.5 font-mono text-[12px] text-[var(--accent)]"
            >
              {v}
            </code>
          ))}
        </div>
      )}

      {error != null && (
        <p role="alert" className="text-[13px] text-[var(--destructive)]">
          {error}
        </p>
      )}

      <div className="mt-1 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          キャンセル
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !title.trim() || !body.trim()}
        >
          {submitting ? "保存中..." : "保存"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--fg)]">
        {label}
      </label>
      {children}
    </div>
  );
}
