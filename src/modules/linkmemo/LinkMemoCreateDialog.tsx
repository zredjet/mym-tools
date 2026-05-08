/**
 * LinkMemo 新規作成ダイアログ (`docs/ui-design.md` §6.4 L-3 の最小版)。
 *
 * - type は segmented control (URL / Path / Memo) で切替
 * - URL タブで `file://` 入力 → 保存時に `linkmemo_normalize_target` で path に
 *   自動振替 (`docs/ui-design.md` §6.4 v0.4 / `data-model.md` §10.2)
 */
import { useState } from "react";
import { FileText, Globe, StickyNote } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem } from "@/ipc/items";
import { linkmemoNormalizeTarget } from "@/ipc/linkmemo";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";

type LinkType = "url" | "path" | "memo";

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}

export function LinkMemoCreateDialog({ open, projectId, onClose, onCreated }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="新規 Link / Memo" widthClassName="w-full max-w-xl">
      {open && (
        <LinkMemoCreateContent projectId={projectId} onClose={onClose} onCreated={onCreated} />
      )}
    </Modal>
  );
}

function LinkMemoCreateContent({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<LinkType>("url");
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [body, setBody] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [normalizationHint, setNormalizationHint] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    setNormalizationHint(null);
    try {
      // type=url で `file://` を入力していたら path に自動振替 (`linkmemo_normalize_target`)
      let actualType: LinkType = type;
      let actualTarget: string | null = target.trim() === "" ? null : target.trim();
      if (type === "url" && actualTarget != null && actualTarget.startsWith("file://")) {
        const normalized = await linkmemoNormalizeTarget(actualTarget);
        actualType = normalized.type;
        actualTarget = normalized.target;
        setNormalizationHint(
          `file:// URL を ${normalized.type} (${normalized.target}) に正規化しました`,
        );
      }

      const tags = tagsInput
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter((t) => t.length > 0);
      const payload =
        actualType === "memo"
          ? { type: "memo" as const, target: null, body: body.trim() }
          : {
              type: actualType,
              target: actualTarget ?? "",
              body: body.trim(),
            };
      await createItem({
        moduleId: "linkmemo",
        projectId,
        title: title.trim(),
        tags,
        payload,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(formatInvokeError(err));
      setSubmitting(false);
    }
  };

  // type 切替時に target / body の入力ラベル + プレースホルダが変わる (ui-design §6.4 v0.2)
  const targetLabel = type === "url" ? "URL" : type === "path" ? "ローカルパス" : "本文";
  const targetPlaceholder =
    type === "url" ? "https://example.com" : type === "path" ? "/Users/redjet/folder" : "";

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-[var(--fg)]">タイプ</span>
        <div className="flex w-fit overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
          <TypeTab
            label="URL"
            icon={<Globe size={14} aria-hidden />}
            selected={type === "url"}
            onClick={() => setType("url")}
          />
          <TypeTab
            label="Path"
            icon={<FileText size={14} aria-hidden />}
            selected={type === "path"}
            onClick={() => setType("path")}
          />
          <TypeTab
            label="Memo"
            icon={<StickyNote size={14} aria-hidden />}
            selected={type === "memo"}
            onClick={() => setType("memo")}
          />
        </div>
      </div>

      <Field label="タイトル" htmlFor="link-title">
        <input
          id="link-title"
          type="text"
          autoFocus
          required
          maxLength={200}
          placeholder="Anthropic API リファレンス"
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={submitting}
        />
      </Field>

      {type !== "memo" && (
        <Field label={targetLabel} htmlFor="link-target">
          <input
            id="link-target"
            type="text"
            required
            maxLength={2000}
            placeholder={targetPlaceholder}
            className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={submitting}
          />
        </Field>
      )}

      <Field label={type === "memo" ? "本文 (必須)" : "メモ (任意)"} htmlFor="link-body">
        <textarea
          id="link-body"
          rows={type === "memo" ? 6 : 3}
          required={type === "memo"}
          placeholder={type === "memo" ? "メモ本文..." : "リンクへのメモ"}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-2.5 font-mono text-[13px] text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={submitting}
        />
      </Field>

      <Field label="タグ (カンマ区切り、`#` は省略可)" htmlFor="link-tags">
        <input
          id="link-tags"
          type="text"
          maxLength={200}
          placeholder="docs, api"
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          disabled={submitting}
        />
      </Field>

      {normalizationHint != null && (
        <p className="rounded-[var(--radius)] bg-[var(--bg-accent-soft)] p-2 text-[12px] text-[var(--accent)]">
          {normalizationHint}
        </p>
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
          disabled={
            submitting ||
            !title.trim() ||
            (type !== "memo" && target.trim() === "") ||
            (type === "memo" && body.trim() === "")
          }
        >
          {submitting ? "保存中..." : "保存"}
        </Button>
      </div>
    </form>
  );
}

function TypeTab({
  label,
  icon,
  selected,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 text-[13px] transition-colors",
        selected
          ? "bg-[var(--bg-accent-soft)] text-[var(--accent)]"
          : "text-[var(--fg)] hover:bg-[var(--bg-muted)]",
      )}
    >
      {icon}
      {label}
    </button>
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
