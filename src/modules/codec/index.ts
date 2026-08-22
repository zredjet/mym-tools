import { lazy } from "react";
import { Binary } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const CodecPage = lazy(() =>
  import("./CodecPage").then((module) => ({ default: module.CodecPage })),
);

export const codecModule: ModuleDefinition = {
  id: "codec",
  displayName: "エンコード変換",
  icon: Binary,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: CodecPage }],
  defaultRoute: "/",
};
