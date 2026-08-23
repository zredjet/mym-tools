import { lazy } from "react";
import { Accessibility } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";
const A11yPage = lazy(() => import("./A11yPage").then((module) => ({ default: module.A11yPage })));

export const a11yModule: ModuleDefinition = {
  id: "a11y",
  displayName: "Webアクセシビリティ",
  icon: Accessibility,
  category: "design",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: A11yPage }],
  defaultRoute: "/",
};
