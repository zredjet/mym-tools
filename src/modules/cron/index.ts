import { lazy } from "react";
import { CalendarClock } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";
const CronPage = lazy(() => import("./CronPage").then((module) => ({ default: module.CronPage })));

export const cronModule: ModuleDefinition = {
  id: "cron",
  displayName: "Cron式ビルダー",
  icon: CalendarClock,
  category: "time",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: CronPage }],
  defaultRoute: "/",
};
