import { lazy } from "react";
import { Files } from "lucide-react";

import type { ModuleDefinition } from "@/modules/types";

const PdfMergePage = lazy(() =>
  import("./PdfMergePage").then((module) => ({ default: module.PdfMergePage })),
);

export const pdfMergeModule: ModuleDefinition = {
  id: "pdfmerge",
  displayName: "PDF結合",
  icon: Files,
  category: "other",
  enabledByDefault: true,
  isStateless: true,
  routes: [{ path: "/", component: PdfMergePage }],
  defaultRoute: "/",
};
