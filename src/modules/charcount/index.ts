import { lazy } from "react";
import { LetterText } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const CharCountPage = lazy(() =>
  import("./CharCountPage").then((module) => ({ default: module.CharCountPage })),
);

export const charCountModule: ModuleDefinition = {
  id: "charcount",
  displayName: "文字数カウント",
  icon: LetterText,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: CharCountPage }],
  defaultRoute: "/",
};
