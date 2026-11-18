/**
 * 「変換」の節の「線のアウトライン化」(§8.10、§8.13)。I が中身を書く。
 *
 * 書き方: `ConvertAction` を 1 つ作ってこの配列に入れる (一覧 `panels/sections/convertActions.ts` への読み込みは
 * 済んでいる)。型と補助 (`applyConvertChange`、`refuseConvert`、`convertContextOf`) は
 * `panels/sections/convertSupport.ts` から読み込む。ショートカット (Shift+Cmd/Ctrl+O) は `canvas/shortcuts.ts` に
 * 自分の節を足し、`run` を呼ぶ。
 */
import type { ConvertAction } from "../panels/sections/convertSupport";

export const OUTLINE_CONVERT_ACTIONS: readonly ConvertAction[] = [];
