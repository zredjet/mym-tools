import { Workflow } from "lucide-react";

import type { DiagramPayloadV1 } from "@/lib/types";
import type { ModuleDefinition } from "@/modules/types";

import { DiagramLandingPage, DiagramWorkspaceRoute } from "./DiagramWorkspacePage";

export const diagramModule: ModuleDefinition = {
  id: "diagram",
  displayName: "ダイアグラム",
  icon: Workflow,
  category: "design",
  enabledByDefault: true,
  isStateless: false,
  routes: [
    { path: "/", component: DiagramLandingPage },
    { path: "/new", component: DiagramWorkspaceRoute },
    { path: "/edit/:itemId", component: DiagramWorkspaceRoute },
  ],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => {
      const payload = item.payload as Partial<DiagramPayloadV1>;
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      return {
        title: item.title,
        ...(text !== "" ? { subtitle: text.replace(/\s+/g, " ").slice(0, 120) } : {}),
        targetPath: `/edit/${item.id}`,
      };
    },
  },
};
