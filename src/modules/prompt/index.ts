import { lazy } from "react";
import { FileText } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const PromptDetailPage = lazy(() =>
  import("@/modules/prompt/PromptDetailPage").then((module) => ({
    default: module.PromptDetailPage,
  })),
);
const PromptListPage = lazy(() =>
  import("@/modules/prompt/PromptListPage").then((module) => ({ default: module.PromptListPage })),
);

export const promptModule: ModuleDefinition = {
  id: "prompt",
  displayName: "プロンプト",
  icon: FileText,
  category: "manage",
  enabledByDefault: true,
  isStateless: false,
  routes: [
    { path: "/", component: PromptListPage },
    { path: "/:itemId", component: PromptDetailPage },
  ],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => ({ title: item.title, targetPath: `/${item.id}` }),
  },
};
