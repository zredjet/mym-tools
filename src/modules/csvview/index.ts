import { lazy } from "react";
import { Sheet } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const CsvViewPage = lazy(() =>
  import("./CsvViewPage").then((module) => ({ default: module.CsvViewPage })),
);

export const csvViewModule: ModuleDefinition = {
  id: "csvview",
  displayName: "CSV ビューア",
  icon: Sheet,
  category: "text",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: CsvViewPage }],
  defaultRoute: "/",
};
