/**
 * M-Hash モジュール定義 (`docs/module-contract.md` §4 / §12.4)。
 *
 * Q-22 PoC: ModuleDefinition の最小実装。`isStateless: true` のため
 * `searchAdapter` は省略 (検索結果に出ない)。
 */
import { Hash } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

export const hashModule: ModuleDefinition = {
  id: "hash",
  displayName: "ハッシュ計算",
  icon: Hash,
  enabledByDefault: true,
  isStateless: true,
  routes: [], // Phase 1 の Shell 実装時に追加
  defaultRoute: "/",
  // searchAdapter: 省略 (isStateless = true のため、検索対象外)
};
