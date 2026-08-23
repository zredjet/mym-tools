import { lazy } from "react";
import { ScanSearch } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";
const JwtPage = lazy(() => import("./JwtPage").then((module) => ({ default: module.JwtPage })));

export const jwtModule: ModuleDefinition = {
  id: "jwt",
  displayName: "JWTインスペクター",
  icon: ScanSearch,
  category: "web",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: JwtPage }],
  defaultRoute: "/",
};
