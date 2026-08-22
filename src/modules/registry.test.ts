import { describe, expect, it } from "vitest";

import {
  enabledModules,
  getModuleDefinition,
  modulePath,
  modules,
  validateModuleDefinitions,
} from "./registry";

describe("frontend module registry", () => {
  it("registers all modules with valid routes", () => {
    expect(modules.map((module) => module.id)).toEqual([
      "prompt",
      "linkmemo",
      "color",
      "hash",
      "palette",
    ]);
    expect(() => validateModuleDefinitions(modules)).not.toThrow();
    for (const module of modules) expect(module.routes.length).toBeGreaterThan(0);
  });

  it("is the single lookup and path authority", () => {
    expect(getModuleDefinition("color")?.displayName).toBe("カラー");
    expect(getModuleDefinition("unknown")).toBeUndefined();
    expect(modulePath("p1", "hash")).toBe("/projects/p1/m/hash");
    expect(modulePath("p1", "prompt", "/item-1")).toBe("/projects/p1/m/prompt/item-1");
  });

  it("routes palette search results to the saved editor", () => {
    const palette = getModuleDefinition("palette")!;
    expect(
      palette.searchAdapter?.formatResult({
        id: "theme-1",
        project_id: "p1",
        module_id: "palette",
        title: "Ocean",
        tags: [],
        payload_schema_version: 1,
        payload: {
          colors: ["#123ABC", "#2563EB", "#3B82F6", "#60A5FA", "#93C5FD"],
          harmony: "analogous",
          base_index: 2,
        },
        position: 0,
        created_at: "",
        updated_at: "",
      }),
    ).toEqual({
      title: "Ocean",
      subtitle: "#123ABC · #2563EB · #3B82F6 · #60A5FA · #93C5FD",
      targetPath: "/edit/theme-1",
    });
  });

  it("applies settings overrides on top of enabledByDefault", () => {
    expect(enabledModules({ color: false }).map((module) => module.id)).toEqual([
      "prompt",
      "linkmemo",
      "hash",
      "palette",
    ]);
  });

  it("rejects duplicate ids and missing stateful search adapters", () => {
    expect(() => validateModuleDefinitions([modules[0]!, modules[0]!])).toThrow(/duplicate/);
    const { searchAdapter, ...withoutAdapter } = modules[0]!;
    expect(searchAdapter).toBeDefined();
    expect(() => validateModuleDefinitions([{ ...withoutAdapter, id: "broken" }])).toThrow(
      /searchAdapter/,
    );
  });
});
