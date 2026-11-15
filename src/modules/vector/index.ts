import { lazy } from "react";
import { PenTool } from "lucide-react";
import type { ModuleDefinition } from "@/modules/types";
const VectorWorkspaceRoute = lazy(() =>
  import("./VectorWorkspacePage").then((module) => ({ default: module.VectorWorkspaceRoute })),
);

export const vectorModule: ModuleDefinition = {
  id: "vector",
  displayName: "キャンバス",
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
  // 検索結果の payload は Rust が `text` (payload v2 の検索用テキスト) の先頭 120 文字だけに絞って返す
  // (`search_preview_field`)。ページやノードの本文、画像は IPC を通らない
  searchAdapter: {
    formatResult: (item) => ({
      title: item.title,
      subtitle: String((item.payload as { text?: string }).text ?? "").slice(0, 120),
      targetPath: `/edit/${item.id}`,
    }),
  },
};
