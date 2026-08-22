import { lazy } from "react";
import { Regex } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const RegexPage = lazy(() =>
  import("./RegexPage").then((module) => ({ default: module.RegexPage })),
);

export const regexModule: ModuleDefinition = {
  id: "regex",
  displayName: "正規表現",
  icon: Regex,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: RegexPage }],
  defaultRoute: "/",
};
