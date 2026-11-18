/**
 * 「変換」の節の「編集できる形に変換」(§8.12、§8.13)。J が中身を書く。
 *
 * 書き方: `ConvertAction` を 1 つ作ってこの配列に入れる (一覧 `panels/sections/convertActions.ts` への読み込みは
 * 済んでいる)。型と補助 (`applyConvertChange`、`refuseConvert`、`convertContextOf`) は
 * `panels/sections/convertSupport.ts` から読み込む。確認のダイアログは `run` から開く。
 */
import type { ConvertAction } from "../panels/sections/convertSupport";

export const SVG_CONVERT_ACTIONS: readonly ConvertAction[] = [];
