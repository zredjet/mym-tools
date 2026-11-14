/**
 * 画像の配置 (§4.4 / §4.8)。
 *
 * ツールバーの「画像」のボタンはこのツールに切り替えず、すぐファイル選択を開いて表示範囲の中央に置く
 * (`assets/importFile.ts` の `importFromPicker`)。このツールは `setTool("image")` が呼ばれたときのためのもので、
 * キャンバスをクリックしたらファイル選択を開き、押した位置を中心に置く。置いたら (取り消しても) 選択ツールへ戻る。
 *
 * ファイル選択を開くとウィンドウのフォーカスが外れて `onCancel` が呼ばれるが、取込は続ける
 * (このツールは文書のジェスチャーを開かない)。
 */
import { importFromPicker } from "../assets/importFile";
import { getImportFileReader } from "../assets/reader";
import { showImportNotice } from "../assets/status";
import type { Point } from "../model/types";
import type { Tool } from "./types";

let press: Point | null = null;

/** テスト用: 状態を捨てる。 */
export function resetImageTool(): void {
  press = null;
}

export const imageTool: Tool = {
  id: "image",
  cursor: "crosshair",
  onPointerDown(event, { store }) {
    press = event.button === 0 ? event.page : null;
    store.getState().setHovered(null);
  },
  onPointerUp(_event, { store }) {
    const at = press;
    press = null;
    if (!at) return;
    if (!getImportFileReader()) {
      showImportNotice({ tone: "error", message: "この画面では画像を取り込めません。" });
      store.getState().setTool("select");
      return;
    }
    // 利用者の操作 (離した) の中で、待たずにファイル選択を開く
    void importFromPicker(store, { at });
  },
  onCancel() {
    press = null;
  },
};
