/**
 * M-Hash モジュール定義 (`docs/module-contract.md` §4 / §12.5)。
 *
 * `isStateless: true` のため `searchAdapter` は省略し、横断検索の対象外とする。
 */
import { lazy } from "react";
import { Hash } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const HashPage = lazy(() =>
  import("@/modules/hash/HashPage").then((module) => ({ default: module.HashPage })),
);

export const hashModule: ModuleDefinition = {
  id: "hash",
  displayName: "ハッシュ計算",
  icon: Hash,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: HashPage }],
  defaultRoute: "/",
  // searchAdapter: 省略 (isStateless = true のため、検索対象外)
};
