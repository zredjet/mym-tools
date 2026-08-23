import { describe, expect, it } from "vitest";

import { mergeSettingsDocument, parseSettingsDocument } from "./settings";

describe("settings document", () => {
  it("parses known values and applies safe defaults", () => {
    const parsed = parseSettingsDocument(
      {
        schema_version: 1,
        core: {
          theme: "dark",
          default_project_id: "p-default",
          last_opened_project_id: "p-last",
          last_opened_module_id: "prompt",
          sidebar_width: 999,
          ui_scale: 0.5,
          row_density: "comfortable",
          module_enabled: { prompt: false, unknown: false },
          collapsed_module_categories: ["text", "future", "text", 7],
        },
        modules: {},
      },
      ["prompt", "linkmemo", "color", "hash", "palette"],
    );

    expect(parsed.theme).toBe("dark");
    expect(parsed.defaultProjectId).toBe("p-default");
    expect(parsed.lastOpenedProjectId).toBe("p-last");
    expect(parsed.lastOpenedModuleId).toBe("prompt");
    expect(parsed.sidebarWidth).toBe(320);
    expect(parsed.uiScale).toBe(0.75);
    expect(parsed.rowDensity).toBe("comfortable");
    expect(parsed.moduleEnabled).toEqual({ prompt: false });
    expect(parsed.collapsedModuleCategories).toEqual(["text", "future"]);
  });

  it("merges current values without discarding unknown keys", () => {
    const original = {
      schema_version: 1,
      core: {
        theme: "light",
        future_core_key: 42,
        module_enabled: { future_module: false },
      },
      modules: { future: { custom: true } },
      future_root_key: "keep",
    };

    const merged = mergeSettingsDocument(original, {
      theme: "dark",
      defaultProjectId: null,
      lastOpenedProjectId: "p1",
      lastOpenedModuleId: "color",
      searchDefaultScope: "global",
      logLevel: "debug",
      sidebarWidth: 280,
      uiScale: 1.15,
      rowDensity: "compact",
      moduleEnabled: { prompt: true, color: false },
      collapsedModuleCategories: ["web"],
    });

    expect(merged.future_root_key).toBe("keep");
    expect(merged.modules).toEqual({ future: { custom: true } });
    expect(merged.core.future_core_key).toBe(42);
    expect(merged.core.last_opened_project_id).toBe("p1");
    expect(merged.core.module_enabled).toEqual({
      future_module: false,
      prompt: true,
      color: false,
    });
    expect(merged.core.collapsed_module_categories).toEqual(["web"]);
  });
});
