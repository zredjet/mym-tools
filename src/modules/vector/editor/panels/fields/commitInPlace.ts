/**
 * 入力欄の打ちかけを、欄を閉じずにその場で文書へ入れる口 (§4.7 / §5.3)。画面の保存 (⌘S) が、
 * 編集を続けられるように使う。登録のない欄は、画面が blur して値を入れる。
 *
 * レイヤー名の欄は blur で閉じる (DOM から消える) ので、ここに登録して、閉じずに確定する。
 */
const handlers = new WeakMap<Element, () => void>();

/** `element` の打ちかけを確定する関数を登録する。戻り値で外す。 */
export function registerCommitInPlace(element: Element, commit: () => void): () => void {
  handlers.set(element, commit);
  return () => {
    if (handlers.get(element) === commit) handlers.delete(element);
  };
}

/** `element` に登録があれば、打ちかけを欄を閉じずに確定して true。なければ何もせず false。 */
export function commitInPlace(element: Element): boolean {
  const commit = handlers.get(element);
  if (!commit) return false;
  commit();
  return true;
}
