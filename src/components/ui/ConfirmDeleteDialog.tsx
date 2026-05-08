/**
 * 削除確認ダイアログ (`docs/ui-design.md` §6.8 C-15 / §8.6)。
 *
 * 「タイプ・トゥ・コンファーム」: 削除対象の名前 (`name`) を **正確に手入力した時のみ**
 * 削除ボタンが有効化される。誤クリックでの取り返しのつかない削除事故を防ぐ。
 *
 * - `Enter`: 名前一致時のみ削除を実行
 * - `Esc`: キャンセル (Modal 共通)
 * - 削除成功時の状態リセット (input 欄クリア) は親側の `onClose` 後の再オープンで自然に
 *   起こるよう、Content コンポーネントを `open` で出し入れする
 */
import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

interface Props {
  open: boolean;
  /** 削除対象のラベル (例: 「プロンプト」「Color」「Project」) */
  entityLabel: string;
  /** 削除対象の名前 (ユーザーがこの文字列を一致入力したら削除可能になる) */
  name: string;
  /** 補足説明 (任意、`<>` JSX 可) */
  description?: React.ReactNode;
  onClose: () => void;
  /** 削除実行。Promise を返し、成功時は `onClose` で閉じる前提 */
  onConfirm: () => Promise<void>;
}

export function ConfirmDeleteDialog({
  open,
  entityLabel,
  name,
  description,
  onClose,
  onConfirm,
}: Props) {
  return (
    <Modal open={open} onClose={onClose} widthClassName="w-full max-w-md">
      {open && (
        <ConfirmDeleteContent
          entityLabel={entityLabel}
          name={name}
          description={description}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  );
}

function ConfirmDeleteContent({
  entityLabel,
  name,
  description,
  onClose,
  onConfirm,
}: Omit<Props, "open">) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = input === name;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matches || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      // 成功時は親側で onClose する前提だが、保険として閉じる
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="-mx-4 -my-3">
      <div className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-3">
        <AlertTriangle
          size={20}
          aria-hidden
          className="mt-0.5 shrink-0 text-[var(--destructive)]"
        />
        <div className="flex-1">
          <h2 className="text-base font-semibold text-[var(--fg)]">
            {entityLabel}を削除しますか?
          </h2>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
            この操作は取り消せません。
            {description != null && <> {description}</>}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 px-4 py-3">
        <p className="text-[13px] text-[var(--fg)]">
          確認のため、以下の名前を入力してください:
        </p>
        <code className="rounded-[var(--radius)] bg-[var(--bg-muted)] px-2 py-1 font-mono text-[13px] text-[var(--fg)] select-all">
          {name}
        </code>
        <input
          type="text"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ここに名前を入力..."
          className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          disabled={submitting}
          aria-label="削除確認"
        />
        {error != null && (
          <p role="alert" className="text-[13px] text-[var(--destructive)]">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          キャンセル
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={!matches || submitting}
        >
          {submitting ? "削除中..." : `${entityLabel}を削除`}
        </Button>
      </div>
    </form>
  );
}
