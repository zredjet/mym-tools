/**
 * プロンプト新規作成 / 編集ダイアログ (`docs/ui-design.md` §6.4 P-3 の最小版)。
 *
 * `mode` で create / edit を切替。
 * - create: title / tags / body の入力フォーム
 * - edit: 既存 `initial` から初期値を入れて `updateItem` 経由で保存
 *
 * 検出変数 (`{{name}}`) を入力フォーム下にリアルタイム表示する点は両モード共通。
 *
 * ## ショートカット (`docs/ui-design.md` §8.4)
 * - `Cmd/Ctrl + S` / `Cmd/Ctrl + Enter`: 保存
 * - `Esc`: キャンセル (Modal 共通)
 */
import { useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, updateItem } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";
import { extractPromptVariables } from "@/lib/promptVars";
import type { Item, PromptPayloadV1 } from "@/lib/types";

type DialogMode = { mode: "create"; projectId: string } | { mode: "edit"; item: Item };

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
} & DialogMode;

export function PromptItemDialog(props: Props) {
  const title = props.mode === "create" ? "新規プロンプト" : "プロンプトを編集";
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={title}
      widthClassName="w-full max-w-2xl"
    >
      {props.open && <Content {...props} />}
    </Modal>
  );
}

function Content(props: Props) {
  const initial: PromptPayloadV1 | null =
    props.mode === "edit" ? (props.item.payload as PromptPayloadV1) : null;
  const initialTitle = props.mode === "edit" ? props.item.title : "";
  const initialTags = props.mode === "edit" ? props.item.tags.join(", ") : "";
  const initialBody = initial?.body ?? "";

  const [title, setTitle] = useState(initialTitle);
  const [tagsInput, setTagsInput] = useState(initialTags);
  const [body, setBody] = useState(initialBody);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectedVars = useMemo(() => extractPromptVariables(body), [body]);
  const canSubmit = !submitting && title.trim().length > 0 && body.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter((t) => t.length > 0);
      if (props.mode === "create") {
        await createItem({
          moduleId: "prompt",
          projectId: props.projectId,
          title: title.trim(),
          tags,
          payload: { body: body.trim() },
        });
      } else {
        await updateItem({
          moduleId: "prompt",
          itemId: props.item.id,
          title: title.trim(),
          tags,
          payload: { body: body.trim() },
        });
      }
      props.onSaved();
      props.onClose();
    } catch (err) {
      setError(formatInvokeError(err));
      setSubmitting(false);
    }
  };

  // ショートカット (`docs/ui-design.md` §8.4): Cmd/Ctrl+S / Cmd/Ctrl+Enter で保存
  useHotkeys(
    "mod+s, mod+enter",
    (e) => {
      e.preventDefault();
      void handleSubmit();
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
    [title, body, tagsInput, props, canSubmit],
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-3"
    >
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
          placeholder="Translate the following to {{language}}: {{text}}"
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
        <Button variant="ghost" onClick={props.onClose} disabled={submitting}>
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
