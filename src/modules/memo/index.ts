import { StickyNote } from "lucide-react";

import type { MemoPayloadV1 } from "@/lib/types";
import { MemoDetailPage } from "@/modules/memo/MemoDetailPage";
import { MemoEditorRoute } from "@/modules/memo/MemoEditorPage";
import { MemoListPage } from "@/modules/memo/MemoListPage";
import type { ModuleDefinition } from "@/modules/types";

export const memoModule: ModuleDefinition = {
  id: "memo",
  displayName: "メモ",
  icon: StickyNote,
  category: "manage",
  enabledByDefault: true,
  isStateless: false,
  routes: [
    { path: "/", component: MemoListPage },
    { path: "/new", component: MemoEditorRoute },
    { path: "/:itemId", component: MemoDetailPage },
    { path: "/edit/:itemId", component: MemoEditorRoute },
  ],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => {
      const payload = item.payload as Partial<MemoPayloadV1>;
      const body = typeof payload.body === "string" ? payload.body.trim() : "";
      return {
        title: item.title,
        ...(body !== "" ? { subtitle: body.replace(/\s+/g, " ").slice(0, 120) } : {}),
        targetPath: `/${item.id}`,
      };
    },
  },
};
