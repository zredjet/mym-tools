import { lazy } from "react";
import { HardDrive } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const DirSizePage = lazy(() =>
  import("./DirSizePage").then((module) => ({ default: module.DirSizePage })),
);

export const dirSizeModule: ModuleDefinition = {
  id: "dirsize",
  displayName: "フォルダ容量",
  icon: HardDrive,
  category: "other",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: DirSizePage }],
  defaultRoute: "/",
};
