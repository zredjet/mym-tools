import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mermaidWriteFile } from "./mermaid";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe("Mermaid IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("uses the module-specific write command", async () => {
    invokeMock.mockResolvedValue(undefined);

    await mermaidWriteFile({
      path: "/tmp/example.svg",
      format: "svg",
      data: "<svg/>",
    });

    expect(invokeMock).toHaveBeenCalledWith("mermaid_write_file", {
      path: "/tmp/example.svg",
      format: "svg",
      data: "<svg/>",
    });
  });

  it("registers and permits the public command in the Tauri ACL", () => {
    const root = process.cwd();
    const buildScript = readFileSync(resolve(root, "src-tauri/build.rs"), "utf8");
    const defaultPermissions = readFileSync(
      resolve(root, "src-tauri/permissions/default.toml"),
      "utf8",
    );

    expect(buildScript).toContain('"mermaid_write_file"');
    expect(defaultPermissions).toContain('"allow-mermaid-write-file"');
  });
});
