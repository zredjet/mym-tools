import { SwatchBook } from "lucide-react";

import type { PalettePayloadV1 } from "@/lib/types";
import type { ModuleDefinition } from "@/modules/types";

import { PaletteEditorRoute } from "./PaletteEditorPage";
import { PaletteListPage } from "./PaletteListPage";

export const paletteModule: ModuleDefinition = {
  id: "palette",
  displayName: "パレット",
  icon: SwatchBook,
  category: "design",
  enabledByDefault: true,
  isStateless: false,
  routes: [
    { path: "/", component: PaletteEditorRoute },
    { path: "/saved", component: PaletteListPage },
    { path: "/edit/:itemId", component: PaletteEditorRoute },
  ],
  defaultRoute: "/",
  searchAdapter: {
    formatResult: (item) => {
      const payload = item.payload as Partial<PalettePayloadV1>;
      return {
        title: item.title,
        ...(Array.isArray(payload.colors) ? { subtitle: payload.colors.join(" · ") } : {}),
        targetPath: `/edit/${item.id}`,
      };
    },
  },
};
