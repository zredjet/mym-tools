import { lazy } from "react";
import { Fingerprint } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const IdGeneratorPage = lazy(() =>
  import("./IdGeneratorPage").then((module) => ({ default: module.IdGeneratorPage })),
);

export const idGeneratorModule: ModuleDefinition = {
  id: "idgen",
  displayName: "ID生成",
  icon: Fingerprint,
  category: "generate",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: IdGeneratorPage }],
  defaultRoute: "/",
};
