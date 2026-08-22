import { lazy } from "react";
import { Send } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const HttpPage = lazy(() => import("./HttpPage").then((module) => ({ default: module.HttpPage })));

export const httpModule: ModuleDefinition = {
  id: "http",
  displayName: "HTTPリクエスト",
  icon: Send,
  category: "web",
  enabledByDefault: false,
  isStateless: true,
  routes: [{ path: "/", component: HttpPage }],
  defaultRoute: "/",
};
