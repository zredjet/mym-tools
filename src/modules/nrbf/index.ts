import { lazy } from "react";
import { FileSearch2 } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const NrbfInspectorPage = lazy(() =>
  import("./NrbfInspectorPage").then((module) => ({ default: module.NrbfInspectorPage })),
);

export const nrbfModule: ModuleDefinition = {
  id: "nrbf",
  displayName: "BinaryFormatter解析",
  icon: FileSearch2,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: NrbfInspectorPage }],
  defaultRoute: "/",
};
