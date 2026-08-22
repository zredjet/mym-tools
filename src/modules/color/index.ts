import { Palette } from "lucide-react";

import type { ColorPayloadV1 } from "@/lib/types";
import { ColorListPage } from "@/modules/color/ColorListPage";
import type { ModuleDefinition } from "@/modules/types";

export const colorModule: ModuleDefinition = {
  id: "color",
  displayName: "カラー",
  icon: Palette,
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
