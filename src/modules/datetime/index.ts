import { lazy } from "react";
import { Clock3 } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const DateTimePage = lazy(() =>
  import("./DateTimePage").then((module) => ({ default: module.DateTimePage })),
);

export const dateTimeModule: ModuleDefinition = {
  id: "datetime",
  displayName: "日時・Timestamp変換",
  icon: Clock3,
  category: "time",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: DateTimePage }],
  defaultRoute: "/",
};
