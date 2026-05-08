/**
 * Color 新規作成 / 編集ダイアログ (`docs/ui-design.md` §6.5 K-2 の最小版)。
 *
 * `mode` で create / edit を切替。Phase 1 PR-M: HEX 入力のみ
 * (RGB/HSL/OKLCH 双方向バインドは Phase 2 持ち越し、§10 オープン論点)。
 *
 * - HEX は `#RRGGBB` または `#RRGGBBAA`。フロントは保存時に大文字正規化
 *   (`docs/data-model.md` §10.3「正規化済み (大文字)」)
 *
 * ## ショートカット
 * - `Cmd/Ctrl + S` / `Cmd/Ctrl + Enter`: 保存
 */
import { useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem, updateItem } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";
import type { ColorPayloadV1, Item } from "@/lib/types";

const HEX_REGEX = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

type DialogMode =
  | { mode: "create"; projectId: string }
  | { mode: "edit"; item: Item };

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
} & DialogMode;

export function ColorItemDialog(props: Props) {
  const title = props.mode === "create" ? "新規 Color" : "Color を編集";
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={title}
      widthClassName="w-full max-w-md"
    >
      {props.open && <Content {...props} />}
    </Modal>
  );
}

function Content(props: Props) {
  const initial: ColorPayloadV1 | null =
    props.mode === "edit" ? (props.item.payload as ColorPayloadV1) : null;
  const [name, setName] = useState(props.mode === "edit" ? props.item.title : "");
  const [hex, setHex] = useState(initial?.hex ?? "#");
  const [tagsInput, setTagsInput] = useState(
    props.mode === "edit" ? props.item.tags.join(", ") : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedHex = hex.trim();
  const isValidHex = useMemo(() => HEX_REGEX.test(trimmedHex), [trimmedHex]);
  const canSubmit = !submitting && name.trim().length > 0 && isValidHex;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter((t) => t.length > 0);
      const normalizedHex = trimmedHex.toUpperCase();
      if (props.mode === "create") {
        await createItem({
          moduleId: "color",
          projectId: props.projectId,
          title: name.trim(),
          tags,
          payload: { hex: normalizedHex },
        });
      } else {
        await updateItem({
          moduleId: "color",
          itemId: props.item.id,
          title: name.trim(),
          tags,
          payload: { hex: normalizedHex },
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
    [name, hex, tagsInput, props, canSubmit],
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center gap-3">
        <div
          className="h-16 w-16 shrink-0 rounded-[var(--radius)] border border-[var(--border)]"
          style={{ background: isValidHex ? trimmedHex : "transparent" }}
          aria-label="プレビュー"
        />
        <div className="flex flex-1 flex-col gap-2">
          <Field label="名前" htmlFor="color-name">
            <input
              id="color-name"
              type="text"
              autoFocus
              required
              maxLength={120}
              placeholder="Brand Primary"
              className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </Field>
          <Field label="HEX (#RRGGBB or #RRGGBBAA)" htmlFor="color-hex">
            <input
              id="color-hex"
              type="text"
              required
              maxLength={9}
              placeholder="#3B82F6"
              className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 font-mono text-[13px] text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              disabled={submitting}
            />
          </Field>
          {!isValidHex && trimmedHex !== "#" && (
            <p className="text-[12px] text-[var(--destructive)]">
              {`#RRGGBB`} または {`#RRGGBBAA`} の形式で入力してください
            </p>
          )}
        </div>
      </div>

      <Field label="タグ (カンマ区切り、`#` は省略可)" htmlFor="color-tags">
        <input
          id="color-tags"
          type="text"
          maxLength={200}
          placeholder="brand, ui"
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          disabled={submitting}
        />
      </Field>

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
