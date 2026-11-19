/**
 * 確認のダイアログ (`ConvertConfirmDialog`) を、`run` (React の外) から開く。ダイアログは `document.body` の下に
 * 自分の根を作って描き、閉じたら片付ける (エディタの画面の部品を変えずに済むように)。
 */
import { createRoot } from "react-dom/client";

import { ConvertConfirmDialog } from "./ConvertConfirmDialog";
import type { DroppedItem } from "./dropped";

/** 確認のダイアログを開き、「変換する」なら true、「やめる」(Esc、背景のクリックを含む) なら false。 */
export function openConvertConfirm(items: readonly DroppedItem[]): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-svg-convert-confirm", "");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (confirmed: boolean) => {
      resolve(confirmed);
      // キーの処理の途中で片付けない (同じイベントの残りの処理がダイアログを見る)
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };
    root.render(
      <ConvertConfirmDialog
        items={items}
        onConfirm={() => done(true)}
        onCancel={() => done(false)}
      />,
    );
  });
}
