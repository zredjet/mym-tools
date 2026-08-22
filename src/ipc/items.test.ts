import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Item } from "@/lib/types";

import { listAllItems } from "./items";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

function createItems(count: number, start: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${start + index}`,
    project_id: "project-1",
    module_id: "palette",
    title: `Palette ${start + index}`,
    tags: [],
    payload_schema_version: 1,
    payload: {},
    position: start + index,
    created_at: "2026-08-23T00:00:00+09:00",
    updated_at: "2026-08-23T00:00:00+09:00",
  }));
}

describe("listAllItems", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads every page so full-scope ordering has every item id", async () => {
    invokeMock
      .mockResolvedValueOnce(createItems(100, 0))
      .mockResolvedValueOnce(createItems(100, 100))
      .mockResolvedValueOnce(createItems(1, 200));

    await expect(
      listAllItems({ moduleId: "palette", projectId: "project-1" }),
    ).resolves.toHaveLength(201);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "core_list_items", {
      moduleId: "palette",
      projectId: "project-1",
      limit: 100,
      offset: 0,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "core_list_items", {
      moduleId: "palette",
      projectId: "project-1",
      limit: 100,
      offset: 100,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "core_list_items", {
      moduleId: "palette",
      projectId: "project-1",
      limit: 100,
      offset: 200,
    });
  });
});
