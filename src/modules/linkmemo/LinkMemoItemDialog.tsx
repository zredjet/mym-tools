/**
 * LinkMemo 新規作成 / 編集ダイアログ (`docs/ui-design.md` §6.4 L-3)。
 *
 * `mode` で create / edit を切替。type は segmented control (URL / Path / Memo)。
 *
 * 仕様:
 * - URL タブで `file://` 入力時は保存時に `linkmemo_normalize_target` で path に振替
 *   (`docs/ui-design.md` §6.4 v0.4 / `data-model.md` §10.2)
 * - type 切替で 2 番目の入力欄のラベル / プレースホルダが変化 (§6.4 v0.2)
 *
 * ## ショートカット (`docs/ui-design.md` §8.4)
 * - `Cmd/Ctrl + S` / `Cmd/Ctrl + Enter`: 保存
 */
import { useState } from "react";
import { FileText, Globe, StickyNote } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, updateItem } from "@/ipc/items";
import { linkmemoNormalizeTarget } from "@/ipc/linkmemo";
import { cn } from "@/lib/cn";
import { formatInvokeError } from "@/lib/error";
import type { Item, LinkMemoPayloadV1 } from "@/lib/types";

type LinkType = "url" | "path" | "memo";

type DialogMode =
  | { mode: "create"; projectId: string }
  | { mode: "edit"; item: Item };

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
} & DialogMode;

export function LinkMemoItemDialog(props: Props) {
  const title = props.mode === "create" ? "新規 Link / Memo" : "Link / Memo を編集";
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={title}
      widthClassName="w-full max-w-xl"
    >
      {props.open && <Content {...props} />}
    </Modal>
  );
}

function Content(props: Props) {
  const initial: LinkMemoPayloadV1 | null =
    props.mode === "edit" ? (props.item.payload as LinkMemoPayloadV1) : null;
  const [type, setType] = useState<LinkType>(initial?.type ?? "url");
  const [title, setTitle] = useState(props.mode === "edit" ? props.item.title : "");
  const [target, setTarget] = useState(initial?.target ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [tagsInput, setTagsInput] = useState(
    props.mode === "edit" ? props.item.tags.join(", ") : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const targetLabel = type === "url" ? "URL" : type === "path" ? "ローカルパス" : "本文";
  const targetPlaceholder =
    type === "url" ? "https://example.com" : type === "path" ? "/Users/redjet/folder" : "";

  const canSubmit =
    !submitting &&
    title.trim().length > 0 &&
    ((type !== "memo" && target.trim().length > 0) ||
      (type === "memo" && body.trim().length > 0));

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setHint(null);
    try {
      let actualType: LinkType = type;
      let actualTarget: string | null = target.trim() === "" ? null : target.trim();

      // URL タブで `file://` を入れた場合は path に自動振替
      if (type === "url" && actualTarget != null && actualTarget.startsWith("file://")) {
        const normalized = await linkmemoNormalizeTarget(actualTarget);
        actualType = normalized.type;
        actualTarget = normalized.target;
        setHint(
          `file:// URL を ${normalized.type} (${normalized.target}) に正規化しました`,
        );
      }

      const tags = tagsInput
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter((t) => t.length > 0);
      const payload: LinkMemoPayloadV1 =
        actualType === "memo"
          ? { type: "memo", target: null, body: body.trim() }
          : { type: actualType, target: actualTarget ?? "", body: body.trim() };

      if (props.mode === "create") {
        await createItem({
          moduleId: "linkmemo",
          projectId: props.projectId,
          title: title.trim(),
          tags,
          payload,
        });
      } else {
        await updateItem({
          moduleId: "linkmemo",
          itemId: props.item.id,
          title: title.trim(),
          tags,
          payload,
        });
      }
      props.onSaved();
      props.onClose();
    } catch (err) {
      setError(formatInvokeError(err));
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
    [type, title, target, body, tagsInput, props, canSubmit],
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

      {hint != null && (
        <p className="rounded-[var(--radius)] bg-[var(--bg-accent-soft)] p-2 text-[12px] text-[var(--accent)]">
          {hint}
        </p>
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
