/**
 * 画像と SVG の取込 (§4.8) を store に当てる。
 *
 * - `importFromPicker`: 登録された関数 (`reader.ts`) でファイル選択を開き、選んだファイルを置く。
 *   ツールバーの「画像」のボタンと画像ツールが呼ぶ。位置を省けば表示範囲の中央で、そのときは
 *   置く矩形を丸ごと含む frame (なければページ直下) に入れる。位置を渡せば、その点の下の frame に入れる
 * - `importFile`: 読んだファイルを指定した位置に置く (OS からのドロップ用。切替 PR がつなぐ)
 *
 * 置いたノードを選び、選択ツールへ戻る。文書の変更は `apply` 1 回 (履歴 1 件)。
 * 取り込めなければ文書を変えず、理由を `status.ts` の知らせに出す。
 *
 * ファイル選択と読み込みは非同期なので、その間に文書が変わることがある。置く計算は置く時点の文書から
 * 行い (Undo の後なら Undo の後の文書に置く)、古い文書を書き戻さない。別の作品が開かれた (`load`) なら置かない。
 * 読み込みが終わった時点でほかの操作のジェスチャーが開いていれば、閉じるのを待ってから置く (途中で確定しない)。
 * 本文の編集中なら、編集を終えてから置く (§4.8)。
 */
import type { StoreApi } from "zustand";
import { formatInvokeError } from "@/lib/error";
import { getCanvasViewSize } from "../canvas/viewCommands";
import { getNode } from "../model/tree";
import type { CanvasDocument, Point } from "../model/types";
import type { EditorStore } from "../state/types";
import { scopeForParent } from "../tools/create/parent";
import { placeAsset, visibleArea, visibleCenter, type Size } from "./place";
import { measureImageInBrowser, prepareImport, type MeasureImage } from "./prepare";
import { getImportFileReader } from "./reader";
import { getImportStatus, setImportBusy, showImportNotice, type ImportNoticeState } from "./status";
import type { ImportedFile } from "./types";

type Store = StoreApi<EditorStore>;

export interface ImportOptions {
  /** 置く中心 (ページ座標)。省けば表示範囲の中央 */
  at?: Point | null;
  /** 画像の大きさを求める関数 (テスト用) */
  measureImage?: MeasureImage;
  /** キャンバスの大きさ (画面 px、テスト用)。省けば `getCanvasViewSize()` */
  viewSize?: Size;
}

/**
 * 別の作品が開かれた (`load`) かを見張る。`onReplaced` は入れ替わったときに 1 回だけ呼ぶ。
 *
 * `apply` / `commitGesture` (変更あり) / `undo` / `redo` は revision を増やし、`updateGesture` は
 * ジェスチャーの中で文書を変え、`cancelGesture` と変更なしの `commitGesture` はジェスチャーの開始時点の
 * 文書に戻す。`load` は revision を 0 に戻し、ジェスチャーを閉じる。そこで次を入れ替えとみなす:
 * - revision が減った
 * - ジェスチャーの外で、revision が増えずに文書が変わった
 * - ジェスチャーが閉じたとき、revision が増えずに、ジェスチャーの外で最後に見た文書と違う文書になった
 *   (未変更の作品で色の選択や本文の編集の途中に `load` された場合)
 *
 * 見張り始めた時点でジェスチャーが開いていた場合は、開始時点の文書が分からないので、閉じたときに
 * 履歴が空になった (Undo も Redo もできなくなった) ことで見分ける。未変更の作品ではこれを見逃す。
 */
export function watchDocumentReplaced(
  store: Store,
  onReplaced?: () => void,
): { replaced(): boolean; stop(): void } {
  let replaced = false;
  const initial = store.getState();
  /** ジェスチャーの外で最後に見た文書 (見張り始めにジェスチャーが開いていれば null) */
  let stable: CanvasDocument | null = initial.gestureActive ? null : initial.doc;
  const mark = () => {
    replaced = true;
    onReplaced?.();
  };
  const stop = store.subscribe((state, previous) => {
    if (replaced) return;
    if (state.revision < previous.revision) return mark();
    if (state.gestureActive) return;
    if (state.revision === previous.revision) {
      if (!previous.gestureActive) {
        if (state.doc !== previous.doc) return mark();
      } else if (
        stable !== null
          ? state.doc !== stable
          : !state.canUndo && !state.canRedo && (previous.canUndo || previous.canRedo)
      )
        return mark();
    }
    stable = state.doc;
  });
  return { replaced: () => replaced, stop };
}

/** 知らせを見張る見張り (別の作品が開かれたら知らせを消す)。 */
let noticeWatch: { stop(): void } | null = null;

/**
 * 取込の知らせを出す (null で消す)。別の作品が開かれたら、その知らせを消す
 * (前の作品への取込の理由を、新しい作品の画面に残さない)。
 */
export function notifyImport(store: Store, notice: ImportNoticeState | null): void {
  noticeWatch?.stop();
  noticeWatch = null;
  showImportNotice(notice);
  if (!notice) return;
  const watch = watchDocumentReplaced(store, () => {
    if (getImportStatus().notice === notice) showImportNotice(null);
    watch.stop();
    if (noticeWatch === watch) noticeWatch = null;
  });
  noticeWatch = watch;
}

const REPLACED = "取り込みの途中で別の作品が開かれたため、取り込みませんでした。";
const BUSY =
  "ほかのファイルを取り込んでいる途中のため、取り込みませんでした。終わってからもう一度試してください。";

/** ジェスチャー (ほかの操作のドラッグや色の選択) が閉じるのを待つ。別の作品が開かれたらそこで終える。 */
function whenGestureClosed(store: Store, watch: { replaced(): boolean }): Promise<void> {
  if (!store.getState().gestureActive) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe((state) => {
      if (state.gestureActive && !watch.replaced()) return;
      unsubscribe();
      resolve();
    });
  });
}

/** 読んだファイルを置く。置いたら true。 */
async function place(
  store: Store,
  file: ImportedFile,
  options: ImportOptions,
  watch: { replaced(): boolean },
): Promise<boolean> {
  const error = (message: string) => {
    notifyImport(store, { tone: "error", message });
    return false;
  };
  const prepared = await prepareImport(file, options.measureImage ?? measureImageInBrowser);
  if (watch.replaced()) return error(REPLACED);
  if (!prepared.ok) return error(prepared.reason);
  // 本文の編集中なら終えてから置く (編集中のテキストを残したまま選択を画像へ移さない)
  if (store.getState().editingTextId !== null) store.getState().endTextEdit();
  // ほかの操作のジェスチャーは、開いた側が閉じるのを待つ (途中で確定しない。§4.2)
  await whenGestureClosed(store, watch);
  if (watch.replaced()) return error(REPLACED);

  const state = store.getState();
  const viewSize = options.viewSize ?? getCanvasViewSize();
  const area = visibleArea(state.viewport, viewSize);
  const result = placeAsset(state.doc, {
    pageId: state.pageId,
    scopeId: state.scopeId,
    asset: prepared.asset,
    name: prepared.name,
    center: options.at ?? visibleCenter(state.viewport, viewSize),
    parentRule: options.at ? "point" : "contain",
    available: area ? { width: area.width, height: area.height } : null,
  });
  if (!result.ok) return error(result.reason);
  // 計算に使った文書のときだけ当てる (同期なので通常は同じ)
  state.apply((doc) => (doc === state.doc ? result.doc : doc));
  const after = store.getState();
  if (!getNode(after.doc, result.id))
    return error("取り込みの途中で作品が変わったため、取り込みませんでした。");
  after.setScope(scopeForParent(after.doc, result.parent));
  after.setSelection([result.id]);
  if (after.toolId !== "select") after.setTool("select");
  if (prepared.notices.length > 0)
    notifyImport(store, {
      tone: "info",
      message: `SVG を取り込みました。${prepared.notices.join(" ")}`,
    });
  return true;
}

/** 取込の前後の共通の処理 (取込中の印、知らせの消去、画像ツールから選択ツールへ戻す)。 */
async function run(
  store: Store,
  read: () => Promise<ImportedFile | null>,
  options: ImportOptions,
): Promise<boolean> {
  setImportBusy(true);
  notifyImport(store, null);
  const watch = watchDocumentReplaced(store);
  try {
    // ファイル選択は利用者の操作の中で開く必要があるので、待たずにすぐ呼ぶ
    const pending = read();
    const file = await pending;
    if (!file) return false;
    return await place(store, file, options, watch);
  } catch (cause) {
    notifyImport(store, {
      tone: "error",
      message: `ファイルを読み込めません: ${formatInvokeError(cause)}`,
    });
    return false;
  } finally {
    watch.stop();
    setImportBusy(false);
    // 画像ツールは 1 回で終わる (取り消したときも選択ツールへ戻る)
    if (store.getState().toolId === "image") store.getState().setTool("select");
  }
}

/** ファイルを読む関数の登録があり、ほかの取込の途中でないか。 */
export function canImport(): boolean {
  return getImportFileReader() !== null && !getImportStatus().busy;
}

/**
 * 登録された関数でファイル選択を開き、選んだ画像・SVG を置く。置いたら true。
 * 登録がなければ何もしない。ほかの取込の途中なら、そのことを知らせて何もしない。
 * ボタンやクリックのハンドラの中で呼ぶこと (ブラウザのファイル選択は利用者の操作の中でしか開けない)。
 */
export function importFromPicker(store: Store, options: ImportOptions = {}): Promise<boolean> {
  const reader = getImportFileReader();
  if (!reader) return Promise.resolve(false);
  if (getImportStatus().busy) {
    notifyImport(store, { tone: "error", message: BUSY });
    return Promise.resolve(false);
  }
  return run(store, reader, options);
}

/**
 * 読んだファイルを置く (OS からのドロップ用)。`options.at` にドロップした位置 (ページ座標) を渡す。
 * ほかの取込の途中なら、そのことを知らせて何もしない (ドロップしたファイルを黙って捨てない)。
 */
export function importFile(
  store: Store,
  file: ImportedFile,
  options: ImportOptions = {},
): Promise<boolean> {
  if (getImportStatus().busy) {
    notifyImport(store, { tone: "error", message: BUSY });
    return Promise.resolve(false);
  }
  return run(store, () => Promise.resolve(file), options);
}
