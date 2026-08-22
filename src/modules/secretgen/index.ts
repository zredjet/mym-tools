import { lazy } from "react";
import { KeyRound } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const SecretGeneratorPage = lazy(() =>
  import("./SecretGeneratorPage").then((module) => ({ default: module.SecretGeneratorPage })),
);

export const secretGeneratorModule: ModuleDefinition = {
  id: "secretgen",
  displayName: "安全な文字列生成",
  icon: KeyRound,
  category: "generate",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: SecretGeneratorPage }],
  defaultRoute: "/",
};
