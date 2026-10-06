import { lazy } from "react";
import { FileType } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const EncodingPage = lazy(() =>
  import("./EncodingPage").then((module) => ({ default: module.EncodingPage })),
);

export const encodingModule: ModuleDefinition = {
  id: "encoding",
  displayName: "文字コード変換",
  icon: FileType,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: EncodingPage }],
  defaultRoute: "/",
};
