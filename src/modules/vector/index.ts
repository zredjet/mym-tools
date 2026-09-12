import { PenTool } from "lucide-react";
import type { ModuleDefinition } from "@/modules/types";
import { VectorWorkspaceRoute } from "./VectorWorkspacePage";
export const vectorModule: ModuleDefinition = {
  id: "vector",
  displayName: "ベクター描画",
  icon: PenTool,
  category: "design",
  enabledByDefault: true,
  isStateless: false,
  routes: [
    { path: "/", component: VectorWorkspaceRoute },
    { path: "/new", component: VectorWorkspaceRoute },
    { path: "/edit/:itemId", component: VectorWorkspaceRoute },
  ],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => ({
      title: item.title,
      subtitle: String((item.payload as { text?: string }).text ?? "").slice(0, 120),
      targetPath: `/edit/${item.id}`,
    }),
  },
};
