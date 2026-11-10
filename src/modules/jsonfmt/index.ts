import { lazy } from "react";
import { Braces } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const JsonFormatPage = lazy(() =>
  import("./JsonFormatPage").then((module) => ({ default: module.JsonFormatPage })),
);

export const jsonFormatModule: ModuleDefinition = {
  id: "jsonfmt",
  displayName: "JSON 整形",
  icon: Braces,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: JsonFormatPage }],
  defaultRoute: "/",
};
