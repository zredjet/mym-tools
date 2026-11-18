/**
 * 「変換」の節の操作の型と、操作を書くための補助 (§8.13)。
 *
 * 操作の一覧は `convertActions.ts` の `CONVERT_ACTIONS`。I (線のアウトライン化) と J (編集できる形に変換) は、
 * `outline/convertAction.ts` の `OUTLINE_CONVERT_ACTIONS` と `svgconvert/convertAction.ts` の
 * `SVG_CONVERT_ACTIONS` に自分の操作を書く (一覧への読み込みは済んでいる)。このファイルだけを読み込み、
 * `convertActions.ts` は読み込まない (循環させないため)。
 *
 * 操作の約束:
 * - `availability` は選択や文書が変わるたびに呼ばれる (パネルの描画)。軽い判定だけにし、重い計算 (演算の結果
 *   を求めるなど) は `run` の中で行う。出さないなら null、出して押せないなら `{ enabled: false, reason }`
 * - `run` は履歴に 1 件だけ積む (`applyConvertChange`)。当てられないときは文書を変えず、`refuseConvert` で
 *   理由を出す
 * - 点の編集中 (`editingPathId`) は、どの操作も出さない (一覧の側で除く。§8.7.3)
 */
import type { LucideIcon } from "lucide-react";
import type { StoreApi } from "zustand";

import { showImportNotice } from "../../assets/status";
import type { CanvasDocument, NodeId, PageId } from "../../model/types";
import type { EditorStore } from "../../state/types";

export type ConvertStore = StoreApi<EditorStore>;

/** 操作が見る状態。 */
export interface ConvertContext {
  doc: CanvasDocument;
  selection: readonly NodeId[];
  pageId: PageId;
  scopeId: NodeId | null;
}

export type ConvertAvailability = { enabled: true } | { enabled: false; reason: string };

export interface ConvertAction {
  /** 一意な名前 (`flatten`、`boolean.union`、`outline` など) */
  id: string;
  /** ボタンの文字 (アイコンだけのボタンではツールチップと読み上げ) */
  label: string;
  icon: LucideIcon;
  /** ツールチップに添えるショートカットの表示 (例 `⌘E`) */
  shortcut?: string;
  /** `icon` はアイコンだけのボタンを 1 行に並べる (ブーリアンの 4 つ)。既定は文字のボタン 1 行 */
  variant?: "row" | "icon";
  /** 出さないなら null。出して押せないなら理由 */
  availability(context: ConvertContext): ConvertAvailability | null;
  run(store: ConvertStore): void;
}

/** 当てなかった理由を画面に出す (キャンバスの下に浮かせる知らせ。取込の知らせと同じ場所)。 */
export function refuseConvert(message: string): void {
  showImportNotice({ tone: "error", message });
}

/**
 * 文書を変え (履歴 1 件)、変わったら選択を `ids` にする。変わらなければ何もせず false。
 * `change` は今の文書を受け取り、結果の文書と選び直す ID を返す。
 */
export function applyConvertChange(
  store: ConvertStore,
  change: (doc: CanvasDocument) => { doc: CanvasDocument; ids: readonly NodeId[] },
): boolean {
  const state = store.getState();
  const result = change(state.doc);
  if (result.doc === state.doc) return false;
  state.apply(() => result.doc);
  store.getState().setSelection([...result.ids]);
  return true;
}

/** 今の状態から `ConvertContext` を作る。 */
export function convertContextOf(state: EditorStore): ConvertContext {
  return {
    doc: state.doc,
    selection: state.selection,
    pageId: state.pageId,
    scopeId: state.scopeId,
  };
}
