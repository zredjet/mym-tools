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
 */
import type { StoreApi } from "zustand";
import { formatInvokeError } from "@/lib/error";
import { getCanvasViewSize } from "../canvas/viewCommands";
import { getNode } from "../model/tree";
import type { Point } from "../model/types";
import type { EditorStore } from "../state/types";
import { scopeForParent } from "../tools/create/parent";
import { placeAsset, visibleArea, visibleCenter, type Size } from "./place";
import { measureImageInBrowser, prepareImport, type MeasureImage } from "./prepare";
import { getImportFileReader } from "./reader";
import { getImportStatus, setImportBusy, showImportNotice } from "./status";
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
 * 別の作品が開かれた (`load`) かを見張る。`load` は revision を 0 に戻すので、
 * 「revision が減った」か「revision が 0 のまま、ジェスチャーの外で文書が変わった」を入れ替えとみなす
 * (`apply` / `commitGesture` / `undo` / `redo` は revision を増やし、`updateGesture` /
 * `cancelGesture` はジェスチャーの中で文書を変える)。
 */
export function watchDocumentReplaced(store: Store): { replaced(): boolean; stop(): void } {
  let replaced = false;
  const stop = store.subscribe((state, previous) => {
    if (state.doc === previous.doc) return;
    if (
      state.revision < previous.revision ||
      (state.revision === 0 &&
        previous.revision === 0 &&
        !state.gestureActive &&
        !previous.gestureActive)
    )
      replaced = true;
  });
  return { replaced: () => replaced, stop };
}

const error = (message: string) => showImportNotice({ tone: "error", message });

/** 読んだファイルを置く。置いたら true。 */
async function place(
  store: Store,
  file: ImportedFile,
  options: ImportOptions,
  watch: { replaced(): boolean },
): Promise<boolean> {
  const prepared = await prepareImport(file, options.measureImage ?? measureImageInBrowser);
  if (watch.replaced()) {
    error("取り込みの途中で別の作品が開かれたため、取り込みませんでした。");
    return false;
  }
  if (!prepared.ok) {
    error(prepared.reason);
    return false;
  }
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
  if (!result.ok) {
    error(result.reason);
    return false;
  }
  // 計算に使った文書のときだけ当てる (同期なので通常は同じ)
  state.apply((doc) => (doc === state.doc ? result.doc : doc));
  const after = store.getState();
  if (!getNode(after.doc, result.id)) {
    error("取り込みの途中で作品が変わったため、取り込みませんでした。");
    return false;
  }
  after.setScope(scopeForParent(after.doc, result.parent));
  after.setSelection([result.id]);
  if (after.toolId !== "select") after.setTool("select");
  if (prepared.notices.length > 0)
    showImportNotice({
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
  showImportNotice(null);
  const watch = watchDocumentReplaced(store);
  try {
    // ファイル選択は利用者の操作の中で開く必要があるので、待たずにすぐ呼ぶ
    const pending = read();
    const file = await pending;
    if (!file) return false;
    return await place(store, file, options, watch);
  } catch (cause) {
    error(`ファイルを読み込めません: ${formatInvokeError(cause)}`);
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
 * 登録がないか、ほかの取込の途中なら何もしない。ボタンやクリックのハンドラの中で呼ぶこと
 * (ブラウザのファイル選択は利用者の操作の中でしか開けない)。
 */
export function importFromPicker(store: Store, options: ImportOptions = {}): Promise<boolean> {
  const reader = getImportFileReader();
  if (!reader || getImportStatus().busy) return Promise.resolve(false);
  return run(store, reader, options);
}

/**
 * 読んだファイルを置く (OS からのドロップ用)。`options.at` にドロップした位置 (ページ座標) を渡す。
 * ほかの取込の途中なら何もしない。
 */
export function importFile(
  store: Store,
  file: ImportedFile,
  options: ImportOptions = {},
): Promise<boolean> {
  if (getImportStatus().busy) return Promise.resolve(false);
  return run(store, () => Promise.resolve(file), options);
}
