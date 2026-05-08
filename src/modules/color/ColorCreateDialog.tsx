/**
 * Color 新規作成ダイアログ (`docs/ui-design.md` §6.5 K-2 の最小版)。
 *
 * Phase 1 PR-L: HEX 入力のみ (RGB/HSL/OKLCH 双方向バインドは次 PR で K-2 full editor に拡張)。
 * - HEX は `#RRGGBB` または `#RRGGBBAA`。バリデーションはバックエンドの
 *   `validate_payload` (大小文字どちらも許容) と整合させ、フロントは保存時に大文字化する
 *   (`docs/data-model.md` §10.3: 「正規化済み (大文字)」)
 */
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createItem } from "@/ipc/items";
import { formatInvokeError } from "@/lib/error";

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}

const HEX_REGEX = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

export function ColorCreateDialog({ open, projectId, onClose, onCreated }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="新規 Color" widthClassName="w-full max-w-md">
      {open && <ColorCreateContent projectId={projectId} onClose={onClose} onCreated={onCreated} />}
    </Modal>
  );
}

function ColorCreateContent({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [hex, setHex] = useState("#");
  const [tagsInput, setTagsInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedHex = hex.trim();
  const isValidHex = useMemo(() => HEX_REGEX.test(trimmedHex), [trimmedHex]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !isValidHex) return;
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter((t) => t.length > 0);
      // `data-model.md` §10.3 通り保存は大文字に正規化
      const normalizedHex = trimmedHex.toUpperCase();
      await createItem({
        moduleId: "color",
        projectId,
        title: name.trim(),
        tags,
        payload: { hex: normalizedHex },
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
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          キャンセル
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !name.trim() || !isValidHex}
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
