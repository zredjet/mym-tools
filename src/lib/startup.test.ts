import { describe, expect, it } from "vitest";

import { resolveStartupTarget } from "./startup";

const projects = [
  { id: "p1", name: "One", description: null, position: 0, created_at: "", updated_at: "" },
  { id: "p2", name: "Two", description: null, position: 1, created_at: "", updated_at: "" },
];

describe("resolveStartupTarget", () => {
  it("restores the last valid project and module", () => {
    expect(
      resolveStartupTarget({
        projects,
        lastProjectId: "p2",
        defaultProjectId: "p1",
        lastModuleId: "color",
        moduleEnabled: {},
      }),
    ).toBe("/projects/p2/m/color");
  });

  it("falls back to default project then first enabled module", () => {
    expect(
      resolveStartupTarget({
        projects,
        lastProjectId: "missing",
        defaultProjectId: "p2",
        lastModuleId: "color",
        moduleEnabled: { color: false, prompt: false },
      }),
    ).toBe("/projects/p2/m/linkmemo");
  });

  it("returns welcome with no projects and settings with no enabled modules", () => {
    expect(
      resolveStartupTarget({
        projects: [],
        lastProjectId: null,
        defaultProjectId: null,
        lastModuleId: null,
        moduleEnabled: {},
      }),
    ).toBe("/welcome");
    expect(
      resolveStartupTarget({
        projects,
        lastProjectId: null,
        defaultProjectId: null,
        lastModuleId: null,
        moduleEnabled: {
          prompt: false,
          linkmemo: false,
          color: false,
          hash: false,
          palette: false,
        },
      }),
    ).toBe("/settings");
  });
});
