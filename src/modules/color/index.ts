import { lazy } from "react";
import { Palette } from "lucide-react";

import type { ColorPayloadV1 } from "@/lib/types";
import type { ModuleDefinition } from "@/modules/types";

const ColorListPage = lazy(() =>
  import("@/modules/color/ColorListPage").then((module) => ({ default: module.ColorListPage })),
);

export const colorModule: ModuleDefinition = {
  id: "color",
  displayName: "カラー",
  icon: Palette,
  category: "design",
  enabledByDefault: true,
  isStateless: false,
  routes: [{ path: "/", component: ColorListPage }],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => {
      const payload = item.payload as Partial<ColorPayloadV1>;
      return {
        title: item.title,
        ...(typeof payload.hex === "string" ? { subtitle: payload.hex } : {}),
        targetPath: "/",
      };
    },
  },
};
