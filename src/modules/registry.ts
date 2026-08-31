/** フロント側モジュールレジストリ。Shell / Router / Search の唯一の列挙元。 */
import type { ModuleId } from "@/lib/types";
import { a11yModule } from "@/modules/a11y";
import { colorModule } from "@/modules/color";
import { codecModule } from "@/modules/codec";
import { dateTimeModule } from "@/modules/datetime";
import { cronModule } from "@/modules/cron";
import { diagramModule } from "@/modules/diagram";
import { hashModule } from "@/modules/hash";
import { httpModule } from "@/modules/http";
import { idGeneratorModule } from "@/modules/idgen";
import { jwtModule } from "@/modules/jwt";
import { linkMemoModule } from "@/modules/linkmemo";
import { memoModule } from "@/modules/memo";
import { mermaidModule } from "@/modules/mermaid";
import { paletteModule } from "@/modules/palette";
import { promptModule } from "@/modules/prompt";
import { secretGeneratorModule } from "@/modules/secretgen";
import { regexModule } from "@/modules/regex";
import { textDiffModule } from "@/modules/textdiff";
import { urlQueryModule } from "@/modules/urlquery";
import type { ModuleCategoryDefinition, ModuleCategoryId, ModuleDefinition } from "@/modules/types";

export const moduleCategories: readonly ModuleCategoryDefinition[] = [
  { id: "manage", displayName: "管理" },
  { id: "design", displayName: "カラー・デザイン" },
  { id: "text", displayName: "テキスト・解析" },
  { id: "web", displayName: "Web・通信" },
  { id: "generate", displayName: "ID・秘密値" },
  { id: "time", displayName: "日時・スケジュール" },
  { id: "other", displayName: "その他" },
];

const moduleCategoryIds = new Set<ModuleCategoryId>(
  moduleCategories.map((category) => category.id),
);

export const modules: readonly ModuleDefinition[] = [
  promptModule,
  linkMemoModule,
  memoModule,
  colorModule,
  hashModule,
  paletteModule,
  mermaidModule,
  diagramModule,
  codecModule,
  urlQueryModule,
  dateTimeModule,
  idGeneratorModule,
  secretGeneratorModule,
  regexModule,
  textDiffModule,
  jwtModule,
  cronModule,
  a11yModule,
  httpModule,
];

export function validateModuleDefinitions(definitions: readonly ModuleDefinition[]): void {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (!/^[a-z0-9]{3,32}$/.test(definition.id)) {
      throw new Error(`invalid module id: ${definition.id}`);
    }
    if (ids.has(definition.id)) throw new Error(`duplicate module id: ${definition.id}`);
    ids.add(definition.id);
    if (definition.category != null && !moduleCategoryIds.has(definition.category)) {
      throw new Error(`invalid module category: ${definition.category}`);
    }
    if (definition.routes.length === 0) {
      throw new Error(`module ${definition.id} has no routes`);
    }
    if (!definition.isStateless && definition.searchAdapter == null) {
      throw new Error(`stateful module ${definition.id} requires searchAdapter`);
    }
  }
}

validateModuleDefinitions(modules);

export function getModuleDefinition(id: string): ModuleDefinition | undefined {
  return modules.find((module) => module.id === id);
}

export function isModuleEnabled(
  module: ModuleDefinition,
  overrides: Partial<Record<ModuleId, boolean>>,
): boolean {
  return overrides[module.id] ?? module.enabledByDefault;
}

export function enabledModules(overrides: Partial<Record<ModuleId, boolean>>): ModuleDefinition[] {
  return modules.filter((module) => isModuleEnabled(module, overrides));
}

export function moduleCategoryId(module: ModuleDefinition): ModuleCategoryId {
  return module.category ?? "other";
}

export function groupedModules(definitions: readonly ModuleDefinition[]) {
  return moduleCategories
    .map((category) => ({
      category,
      modules: definitions.filter((module) => moduleCategoryId(module) === category.id),
    }))
    .filter((group) => group.modules.length > 0);
}

export function modulePath(projectId: string, moduleId: ModuleId, relativePath = "/"): string {
  const suffix = relativePath === "/" ? "" : `/${relativePath.replace(/^\/+/, "")}`;
  return `/projects/${encodeURIComponent(projectId)}/m/${moduleId}${suffix}`;
}
