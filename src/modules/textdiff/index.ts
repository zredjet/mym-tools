import { lazy } from "react";
import { FileDiff } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const TextDiffPage = lazy(() =>
  import("./TextDiffPage").then((module) => ({ default: module.TextDiffPage })),
);

export const textDiffModule: ModuleDefinition = {
  id: "textdiff",
  displayName: "テキスト差分",
  icon: FileDiff,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: TextDiffPage }],
  defaultRoute: "/",
};
