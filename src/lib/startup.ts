/** 起動時のプロジェクト／モジュール復元規則 (`docs/data-model.md` §11.5)。 */
import type { ModuleId, Project } from "@/lib/types";
import { enabledModules, modulePath } from "@/modules/registry";

interface StartupInput {
  projects: readonly Project[];
  lastProjectId: string | null;
  defaultProjectId: string | null;
  lastModuleId: ModuleId | null;
  moduleEnabled: Partial<Record<ModuleId, boolean>>;
}

export function resolveStartupTarget(input: StartupInput): string {
  if (input.projects.length === 0) return "/welcome";
  const project =
    input.projects.find((candidate) => candidate.id === input.lastProjectId) ??
    input.projects.find((candidate) => candidate.id === input.defaultProjectId) ??
    input.projects[0]!;
  const enabled = enabledModules(input.moduleEnabled);
  if (enabled.length === 0) return "/settings";
  const module = enabled.find((candidate) => candidate.id === input.lastModuleId) ?? enabled[0]!;
  return modulePath(project.id, module.id, module.defaultRoute);
}
