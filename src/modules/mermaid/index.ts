import { GitBranch } from "lucide-react";

import type { MermaidPayloadV1 } from "@/lib/types";
import type { ModuleDefinition } from "@/modules/types";

import { MermaidLandingPage, MermaidWorkspaceRoute } from "./MermaidWorkspacePage";

export const mermaidModule: ModuleDefinition = {
  id: "mermaid",
  displayName: "Mermaid",
  icon: GitBranch,
  category: "design",
  enabledByDefault: true,
  isStateless: false,
  routes: [
    { path: "/", component: MermaidLandingPage },
    { path: "/new", component: MermaidWorkspaceRoute },
    { path: "/edit/:itemId", component: MermaidWorkspaceRoute },
  ],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => {
      const payload = item.payload as Partial<MermaidPayloadV1>;
      const source = typeof payload.source === "string" ? payload.source.trim() : "";
      return {
        title: item.title,
        ...(source !== "" ? { subtitle: source.replace(/\s+/g, " ").slice(0, 120) } : {}),
        targetPath: `/edit/${item.id}`,
      };
    },
  },
};
