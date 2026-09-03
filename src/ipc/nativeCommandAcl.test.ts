import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC_COMMANDS = [
  "pdfmerge_inspect_files",
  "pdfmerge_merge_files",
  "nrbf_inspect_file",
] as const;

describe("Native command ACL", () => {
  it.each(PUBLIC_COMMANDS)("registers and permits %s", (command) => {
    const root = process.cwd();
    const buildScript = readFileSync(resolve(root, "src-tauri/build.rs"), "utf8");
    const defaultPermissions = readFileSync(
      resolve(root, "src-tauri/permissions/default.toml"),
      "utf8",
    );
    const permission = `allow-${command.replace(/_/g, "-")}`;

    expect(buildScript).toContain(`"${command}"`);
    expect(defaultPermissions).toContain(`"${permission}"`);
  });
});
