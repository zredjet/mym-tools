/**
 * キャンバスのポインターのドラッグを、エディタの外 (画面) から確かめて取り消す口 (§4.4)。
 *
 * ドラッグの途中は保存と新規のキーを受けない。閉じる要求や画面の移動の確認の前には、ドラッグを
 * 途中で確定せずに取り消す (Esc と同じく、ツールの `onCancel` を呼び、ドラッグが開いたジェスチャーを
 * 戻す)。`useCanvasInput` が登録する (エディタは同時に 1 つだけ)。
 */
export interface PointerDragHandle {
  /** ポインターのドラッグの途中か */
  isActive: () => boolean;
  /** ドラッグを取り消す。ドラッグがなければ何もせず false */
  cancel: () => boolean;
}

let current: PointerDragHandle | null = null;

/** 登録する。戻り値で外す (登録し直されていたら何もしない)。 */
export function registerPointerDrag(handle: PointerDragHandle): () => void {
  current = handle;
  return () => {
    if (current === handle) current = null;
  };
}

export function isPointerDragActive(): boolean {
  return current?.isActive() ?? false;
}

/** ポインターのドラッグを取り消す。ドラッグがなければ false。 */
export function cancelPointerDrag(): boolean {
  return current?.cancel() ?? false;
}
