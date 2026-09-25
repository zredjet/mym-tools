import { lazy } from "react";
import { Link as LinkIcon } from "lucide-react";

import type { LinkPayloadV1 } from "@/lib/types";
import type { ModuleDefinition } from "@/modules/types";

const LinkMemoListPage = lazy(() =>
  import("@/modules/linkmemo/LinkMemoListPage").then((module) => ({
    default: module.LinkMemoListPage,
  })),
);

export const linkMemoModule: ModuleDefinition = {
  id: "linkmemo",
  displayName: "リンク",
  icon: LinkIcon,
  category: "manage",
  enabledByDefault: true,
  isStateless: false,
  routes: [{ path: "/", component: LinkMemoListPage }],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => {
      const payload = item.payload as Partial<LinkPayloadV1>;
      return {
        title: item.title,
        ...(typeof payload.target === "string" && payload.target !== ""
          ? { subtitle: payload.target }
          : {}),
        targetPath: "/",
      };
    },
  },
};
