import { describe, expect, it } from "vitest";

import {
  enabledModules,
  getModuleDefinition,
  groupedModules,
  modulePath,
  modules,
  validateModuleDefinitions,
} from "./registry";

describe("frontend module registry", () => {
  it("registers all modules with valid routes", () => {
    expect(modules.map((module) => module.id)).toEqual([
      "prompt",
      "linkmemo",
      "memo",
      "color",
      "hash",
      "palette",
      "mermaid",
      "diagram",
      "codec",
      "urlquery",
      "datetime",
      "idgen",
      "secretgen",
      "regex",
      "textdiff",
      "jwt",
      "cron",
      "a11y",
      "http",
      "pdfmerge",
    ]);
    expect(() => validateModuleDefinitions(modules)).not.toThrow();
    for (const module of modules) expect(module.routes.length).toBeGreaterThan(0);
  });

  it("routes Memo search results to the detail page", () => {
    const memo = getModuleDefinition("memo")!;
    expect(
      memo.searchAdapter?.formatResult({
        id: "memo-1",
        project_id: "p1",
        module_id: "memo",
        title: "設計メモ",
        tags: [],
        payload_schema_version: 1,
        payload: { body: "本文" },
        position: 0,
        created_at: "",
        updated_at: "",
      }),
    ).toEqual({ title: "設計メモ", subtitle: "本文", targetPath: "/memo-1" });
  });

  it("is the single lookup and path authority", () => {
    expect(getModuleDefinition("color")?.displayName).toBe("カラー");
    expect(getModuleDefinition("unknown")).toBeUndefined();
    expect(modulePath("p1", "hash")).toBe("/projects/p1/m/hash");
    expect(modulePath("p1", "prompt", "/item-1")).toBe("/projects/p1/m/prompt/item-1");
  });

  it("routes Mermaid and diagram search results to their editors", () => {
    const base = {
      project_id: "p1",
      tags: [],
      payload_schema_version: 1,
      position: 0,
      created_at: "",
      updated_at: "",
    };
    expect(
      getModuleDefinition("mermaid")?.searchAdapter?.formatResult({
        ...base,
        id: "mermaid-1",
        module_id: "mermaid",
        title: "処理フロー",
        payload: { source: "flowchart LR\nA-->B" },
      }),
    ).toEqual({
      title: "処理フロー",
      subtitle: "flowchart LR A-->B",
      targetPath: "/edit/mermaid-1",
    });
    expect(
      getModuleDefinition("diagram")?.searchAdapter?.formatResult({
        ...base,
        id: "diagram-1",
        module_id: "diagram",
        title: "構成図",
        payload: { xml: "<mxfile/>", text: "Client Server" },
      }),
    ).toEqual({
      title: "構成図",
      subtitle: "Client Server",
      targetPath: "/edit/diagram-1",
    });
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
    const enabled = enabledModules({ color: false }).map((module) => module.id);
    expect(enabled).not.toContain("color");
    expect(enabled).not.toContain("http");
    expect(enabled).toContain("codec");
    expect(enabledModules({ http: true }).map((module) => module.id)).toContain("http");
  });

  it("groups modules by the shared category registry", () => {
    const groups = groupedModules(modules);
    expect(groups.map((group) => group.category.id)).toEqual([
      "manage",
      "design",
      "text",
      "web",
      "generate",
      "time",
      "other",
    ]);
    expect(
      groups.find((group) => group.category.id === "web")?.modules.map((module) => module.id),
    ).toEqual(["urlquery", "jwt", "http"]);
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
