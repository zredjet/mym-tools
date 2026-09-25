import { lazy } from "react";
import { StickyNote } from "lucide-react";

import type { MemoPayloadV1 } from "@/lib/types";
import type { ModuleDefinition } from "@/modules/types";

const MemoDetailPage = lazy(() =>
  import("@/modules/memo/MemoDetailPage").then((module) => ({ default: module.MemoDetailPage })),
);
const MemoEditorRoute = lazy(() =>
  import("@/modules/memo/MemoEditorPage").then((module) => ({ default: module.MemoEditorRoute })),
);
const MemoListPage = lazy(() =>
  import("@/modules/memo/MemoListPage").then((module) => ({ default: module.MemoListPage })),
);

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
