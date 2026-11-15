/**
 * キャンバスのポインターのドラッグを、エディタの外 (画面) から確かめて取り消す口 (§4.4)。
 *
 * ドラッグの途中は保存と新規のキーを受けない。閉じる要求や画面の移動の確認の前には、ドラッグを
 * 途中で確定せずに取り消す (Esc と同じく、ドラッグを開いた側が自分のジェスチャーを戻す)。
 * キャンバスのポインター (`useCanvasInput`) と、ルーラーからのガイド線の引き出し (`Rulers.tsx`) が
 * それぞれ登録する。
 */
export interface PointerDragHandle {
  /** ポインターのドラッグの途中か */
  isActive: () => boolean;
  /** ドラッグを取り消す。ドラッグがなければ何もせず false */
  cancel: () => boolean;
}

const handles = new Set<PointerDragHandle>();

/** 登録する。戻り値で外す。 */
export function registerPointerDrag(handle: PointerDragHandle): () => void {
  handles.add(handle);
  return () => {
    handles.delete(handle);
  };
}

/** 登録されたどれかがドラッグの途中か。 */
export function isPointerDragActive(): boolean {
  for (const handle of handles) if (handle.isActive()) return true;
  return false;
}

/** 進んでいるドラッグをすべて取り消す。取り消したものがなければ false。 */
export function cancelPointerDrag(): boolean {
  let cancelled = false;
  for (const handle of [...handles]) if (handle.isActive() && handle.cancel()) cancelled = true;
  return cancelled;
}
