import { lazy } from "react";
import { Link2 } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const UrlQueryPage = lazy(() =>
  import("./UrlQueryPage").then((module) => ({ default: module.UrlQueryPage })),
);

export const urlQueryModule: ModuleDefinition = {
  id: "urlquery",
  displayName: "URL・クエリ編集",
  icon: Link2,
  category: "web",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: UrlQueryPage }],
  defaultRoute: "/",
};
