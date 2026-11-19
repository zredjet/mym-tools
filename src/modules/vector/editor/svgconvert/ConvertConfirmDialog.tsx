/**
 * 「編集できる形に変換」の確認のダイアログ (§4.17)。落とすもの・近似になるものの種類と件数を出し、
 * 「変換する」「やめる」を選ばせる。
 *
 * - アプリの共通部品 `Modal` を使う (Esc で閉じる、Tab の循環、閉じたらフォーカスを戻す)
 * - 開いたときは「変換する」にフォーカスを置き、閉じたら開く前の要素へ戻す (Modal)。Enter はフォーカスのあるボタン (ボタンの外なら「変換する」)、
 *   Esc は「やめる」
 * - Enter と Esc はキャンバスへ渡さない (`preventDefault`。キャンバスのキーの処理は `defaultPrevented` を見る)。
 *   ダイアログが閉じた直後に同じキーで選択の解除などが起きないように
 *
 * `run` (React の外) からは `openConvertConfirm.tsx` の `openConvertConfirm(items)` で開く。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

import type { DroppedItem } from "./dropped";

export interface ConvertConfirmDialogProps {
  items: readonly DroppedItem[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConvertConfirmDialog({ items, onConfirm, onCancel }: ConvertConfirmDialogProps) {
  const [open, setOpen] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 開いたら「変換する」にフォーカスを置く。`autoFocus` を使うと、Modal が開く前のフォーカスを覚える前に
  // ボタンへ移ってしまい、閉じたときに元の要素へ戻らない。子 (Modal) の effect は親より先に走るので、
  // Modal が元のフォーカスを覚えた後にここで移す
  useEffect(() => {
    bodyRef.current?.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.focus();
  }, []);
  const finish = (confirmed: boolean) => {
    if (!open) return;
    setOpen(false);
    if (confirmed) onConfirm();
    else onCancel();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // 閉じるのは Modal が行う。キャンバスへは渡さない
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    const action = target.closest("button")?.getAttribute("data-action");
    finish(action !== "cancel");
  };
  return (
    <Modal open={open} title="編集できる形に変換" onClose={() => finish(false)}>
      <div ref={bodyRef} onKeyDown={onKeyDown}>
        <p className="text-sm">次のものは、変換すると失われるか近似になります。変換しますか？</p>
        <ul
          className="mt-3 max-h-60 space-y-1 overflow-y-auto text-sm"
          aria-label="変換で変わるもの"
        >
          {items.map((item) => (
            <li key={item.kind} className="flex justify-between gap-4">
              <span>{item.label}</span>
              <span className="shrink-0 text-[var(--fg-muted)] tabular-nums">{item.count} 件</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <Button data-action="cancel" onClick={() => finish(false)}>
            やめる
          </Button>
          <Button data-action="confirm" variant="primary" onClick={() => finish(true)}>
            変換する
          </Button>
        </div>
      </div>
    </Modal>
  );
}
