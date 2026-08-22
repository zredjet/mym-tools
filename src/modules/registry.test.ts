import { describe, expect, it } from "vitest";

import {
  enabledModules,
  getModuleDefinition,
  modulePath,
  modules,
  validateModuleDefinitions,
} from "./registry";

describe("frontend module registry", () => {
  it("registers the four Phase 1 modules with valid routes", () => {
    expect(modules.map((module) => module.id)).toEqual(["prompt", "linkmemo", "color", "hash"]);
    expect(() => validateModuleDefinitions(modules)).not.toThrow();
    for (const module of modules) expect(module.routes.length).toBeGreaterThan(0);
  });

  it("is the single lookup and path authority", () => {
    expect(getModuleDefinition("color")?.displayName).toBe("カラー");
    expect(getModuleDefinition("unknown")).toBeUndefined();
    expect(modulePath("p1", "hash")).toBe("/projects/p1/m/hash");
    expect(modulePath("p1", "prompt", "/item-1")).toBe("/projects/p1/m/prompt/item-1");
  });

  it("applies settings overrides on top of enabledByDefault", () => {
    expect(enabledModules({ color: false }).map((module) => module.id)).toEqual([
      "prompt",
      "linkmemo",
      "hash",
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
