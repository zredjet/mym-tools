import { lazy } from "react";
import { ImageDown } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const PngOptPage = lazy(() =>
  import("./PngOptPage").then((module) => ({ default: module.PngOptPage })),
);

export const pngOptModule: ModuleDefinition = {
  id: "pngopt",
  displayName: "PNG最適化",
  icon: ImageDown,
  category: "other",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: PngOptPage }],
  defaultRoute: "/",
};
