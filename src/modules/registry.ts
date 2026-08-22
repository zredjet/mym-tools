/** フロント側モジュールレジストリ。Shell / Router / Search の唯一の列挙元。 */
import type { ModuleId } from "@/lib/types";
import { colorModule } from "@/modules/color";
import { hashModule } from "@/modules/hash";
import { linkMemoModule } from "@/modules/linkmemo";
import { paletteModule } from "@/modules/palette";
import { promptModule } from "@/modules/prompt";
import type { ModuleDefinition } from "@/modules/types";

export const modules: readonly ModuleDefinition[] = [
  promptModule,
  linkMemoModule,
  colorModule,
  hashModule,
  paletteModule,
];

export function validateModuleDefinitions(definitions: readonly ModuleDefinition[]): void {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (!/^[a-z0-9]{3,32}$/.test(definition.id)) {
      throw new Error(`invalid module id: ${definition.id}`);
    }
    if (ids.has(definition.id)) throw new Error(`duplicate module id: ${definition.id}`);
    ids.add(definition.id);
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

export function modulePath(projectId: string, moduleId: ModuleId, relativePath = "/"): string {
  const suffix = relativePath === "/" ? "" : `/${relativePath.replace(/^\/+/, "")}`;
  return `/projects/${encodeURIComponent(projectId)}/m/${moduleId}${suffix}`;
}
