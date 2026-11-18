/**
 * 「変換」の節の「編集できる形に変換」(§4.17、§5.3)。
 *
 * - 埋め込み SVG を 1 個だけ選んでいるときに出す (`availability` は選択の種類を見るだけ。SVG を読むのは `run`)
 * - 押すと SVG を読んで結果を作り (`prepareSvgConversion`)、当てられなければ理由を出す。落とすもの・近似に
 *   なるものがあれば確認のダイアログ (`openConvertConfirm`) を出し、「変換する」のときだけ当てる。なければ
 *   そのまま当てる。履歴 1 件で、作った group を選ぶ
 * - ダイアログを開いている間に文書が変わったら、当てる時点の文書で作り直す
 */
import { Shapes } from "lucide-react";

import {
  applyConvertChange,
  refuseConvert,
  type ConvertAction,
  type ConvertContext,
  type ConvertStore,
} from "../panels/sections/convertSupport";
import { getNode } from "../model/tree";
import type { NodeId } from "../model/types";
import { canvasTextMeasurer } from "../render/measureText";
import type { TextMeasurer } from "../render/types";
import { openConvertConfirm } from "./openConvertConfirm";
import type { DroppedItem } from "./dropped";
import { prepareSvgConversion, SVG_CONVERSION_MESSAGES, type SvgConversion } from "./place";

export interface SvgConvertRunOptions {
  /** 確認のダイアログ (テストで差し替える) */
  confirm?: (items: readonly DroppedItem[]) => Promise<boolean>;
  measurer?: TextMeasurer;
}

function refusal(outcome: Extract<SvgConversion, { ok: false }>): string {
  const message = SVG_CONVERSION_MESSAGES[outcome.reason];
  return outcome.detail ? `${message} (${outcome.detail})` : message;
}

function prepare(
  doc: Parameters<typeof prepareSvgConversion>[0],
  id: NodeId,
  measurer: TextMeasurer,
): SvgConversion {
  try {
    return prepareSvgConversion(doc, id, measurer);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid",
      detail: error instanceof Error ? error.message : null,
    };
  }
}

/**
 * 選んでいる埋め込み SVG を編集できる形に変換する。当てたら true。
 * 選択が埋め込み SVG 1 個でなければ何もしない (ボタンも出ていない)。
 */
export async function convertSelectedSvg(
  store: ConvertStore,
  options: SvgConvertRunOptions = {},
): Promise<boolean> {
  const measurer = options.measurer ?? canvasTextMeasurer;
  const confirm = options.confirm ?? openConvertConfirm;
  const state = store.getState();
  if (state.editingPathId !== null || state.selection.length !== 1) return false;
  const id = state.selection[0] as NodeId;
  if (getNode(state.doc, id)?.type !== "svg") return false;
  const first = prepare(state.doc, id, measurer);
  if (!first.ok) {
    refuseConvert(refusal(first));
    return false;
  }
  if (first.dropped.length > 0 && !(await confirm(first.dropped))) return false;

  let refused: string | null = null;
  const changed = applyConvertChange(store, (doc) => {
    if (doc === state.doc) return { doc: first.doc, ids: first.ids };
    // ダイアログの間に文書が変わった: 今の文書で作り直す (埋め込み SVG が無くなっていれば何もしない)
    if (getNode(doc, id)?.type !== "svg") return { doc, ids: [] };
    const again = prepare(doc, id, measurer);
    if (!again.ok) {
      refused = refusal(again);
      return { doc, ids: [] };
    }
    return { doc: again.doc, ids: again.ids };
  });
  if (refused !== null) refuseConvert(refused);
  return changed;
}

function availability({ doc, selection }: ConvertContext) {
  if (selection.length !== 1) return null;
  return getNode(doc, selection[0] as NodeId)?.type === "svg" ? { enabled: true as const } : null;
}

export const SVG_CONVERT_ACTIONS: readonly ConvertAction[] = [
  {
    id: "svgConvert",
    label: "編集できる形に変換",
    icon: Shapes,
    availability,
    run: (store) => {
      void convertSelectedSvg(store);
    },
  },
];
