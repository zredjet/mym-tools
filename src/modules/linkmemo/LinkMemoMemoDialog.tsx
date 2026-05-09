/**
 * LinkMemo `type=memo` の本文表示モーダル (`docs/ui-design.md` §6.4 補完)。
 *
 * `url` / `path` は `linkmemo_open` で OS 既定アプリに渡せるが、`memo` は
 * アプリ内で本文を見せるしかない。Phase 1 では本ダイアログで body を表示し、
 * Markdown レンダリング + クリップボードコピーを提供する。
 *
 * - body は `MarkdownView` で描画 (Prompt と同じく GFM + シンタックスハイライト)
 * - `Cmd/Ctrl+C` (フォーカス外) で body をクリップボードにコピー
 */
import { useCallback, useState } from "react";
import { Check, Copy, Pencil } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/Button";
import { MarkdownView } from "@/components/ui/MarkdownView";
import { Modal } from "@/components/ui/Modal";
import { formatInvokeError } from "@/lib/error";
import type { Item, LinkMemoPayloadV1 } from "@/lib/types";

interface Props {
  open: boolean;
  item: Item | null;
  onClose: () => void;
  onEdit: () => void;
}

export function LinkMemoMemoDialog({ open, item, onClose, onEdit }: Props) {
  return (
    <Modal
      open={open && item != null}
      onClose={onClose}
      title={item?.title ?? ""}
      widthClassName="w-full max-w-2xl"
    >
      {open && item != null && <Content item={item} onClose={onClose} onEdit={onEdit} />}
    </Modal>
  );
}

function Content({
  item,
  onClose,
  onEdit,
}: {
  item: Item;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payload = item.payload as LinkMemoPayloadV1 | undefined;
  const body = typeof payload?.body === "string" ? payload.body : "";

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setError(null);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(formatInvokeError(e));
    }
  }, [body]);

  // Cmd/Ctrl+C: 入力フォーカス中は通常コピーを妨げない (現状フォーカスを取る要素なし)
  useHotkeys(
    "mod+c",
    (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      void copy();
    },
    [copy],
  );

  return (
    <div className="flex flex-col gap-3">
      {item.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--fg-muted)]">
          {item.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-[var(--bg-muted)] px-2 py-0.5 font-mono text-[11px]"
            >
              #{t}
            </span>
          ))}
        </div>
      )}

      <div className="max-h-[60vh] min-h-32 overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-4">
        {body === "" ? (
          <p className="text-[13px] text-[var(--fg-subtle)]">本文なし</p>
        ) : (
          <MarkdownView source={body} />
        )}
      </div>

      {error != null && (
        <p role="alert" className="text-[12px] text-[var(--destructive)]">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          閉じる
        </Button>
        <Button variant="secondary" onClick={onEdit}>
          <Pencil size={14} aria-hidden /> 編集
        </Button>
        <Button variant="primary" onClick={() => void copy()} title="Cmd/Ctrl+C">
          {copied ? (
            <>
              <Check size={14} aria-hidden /> コピー済
            </>
          ) : (
            <>
              <Copy size={14} aria-hidden /> 本文をコピー
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
