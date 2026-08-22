import { Link as LinkIcon } from "lucide-react";

import type { LinkMemoPayloadV1 } from "@/lib/types";
import { LinkMemoListPage } from "@/modules/linkmemo/LinkMemoListPage";
import type { ModuleDefinition } from "@/modules/types";

export const linkMemoModule: ModuleDefinition = {
  id: "linkmemo",
  displayName: "リンク・メモ",
  icon: LinkIcon,
  enabledByDefault: true,
  isStateless: false,
  routes: [{ path: "/", component: LinkMemoListPage }],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => {
      const payload = item.payload as Partial<LinkMemoPayloadV1>;
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
