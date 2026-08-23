import { FileText } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";
import { PromptDetailPage } from "@/modules/prompt/PromptDetailPage";
import { PromptListPage } from "@/modules/prompt/PromptListPage";

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
