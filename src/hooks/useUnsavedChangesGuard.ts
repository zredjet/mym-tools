/**
 * 未保存の変更がある編集画面から「離れる」操作をまとめて確認する。
 *
 * - 画面内の遷移: 呼び出し側の `useBlocker` (条件は画面ごとに異なるため外から受け取る)
 * - ウィンドウを閉じる / ⌘Q: `registerCloseGuard` (`src/lib/windowClose.ts`)
 * - WebView の reload 等: `beforeunload`
 *
 * 戻り値の `open` / `cancel` / `proceed` をそのまま確認 Modal に渡せば、どちらの経路でも
 * 同じ Modal で「編集を続ける / 破棄する」を選べる。
 */
import { useEffect, useRef, useState } from "react";
import type { Blocker } from "react-router-dom";

import { registerCloseGuard } from "@/lib/windowClose";

export interface UnsavedChangesGuard {
  /** 確認 Modal を開くべきか。 */
  open: boolean;
  /** ウィンドウを閉じる要求で開いているか (ボタン文言の出し分け用)。 */
  isWindowClose: boolean;
  /** 編集を続ける。 */
  cancel: () => void;
  /** 変更を破棄して移動する / ウィンドウを閉じる。 */
  proceed: () => void;
}

export function useUnsavedChangesGuard(blocker: Blocker, dirty: boolean): UnsavedChangesGuard {
  const [pendingClose, setPendingClose] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(
    () =>
      registerCloseGuard({
        shouldBlock: () => dirtyRef.current,
        onBlocked: (proceed) => setPendingClose(() => proceed),
      }),
    [],
  );

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const isWindowClose = pendingClose !== null;
  return {
    open: blocker.state === "blocked" || isWindowClose,
    isWindowClose,
    cancel: () => {
      if (isWindowClose) setPendingClose(null);
      else blocker.reset?.();
    },
    proceed: () => {
      if (pendingClose !== null) {
        setPendingClose(null);
        pendingClose();
      } else {
        blocker.proceed?.();
      }
    },
  };
}
