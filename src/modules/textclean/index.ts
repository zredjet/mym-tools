import { lazy } from "react";
import { WandSparkles } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const TextCleanPage = lazy(() =>
  import("./TextCleanPage").then((module) => ({ default: module.TextCleanPage })),
);

export const textCleanModule: ModuleDefinition = {
  id: "textclean",
  displayName: "テキスト整形",
  icon: WandSparkles,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: TextCleanPage }],
  defaultRoute: "/",
};
