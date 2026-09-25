import { describe, expect, it } from "vitest";

import { requiresOpenConfirmation } from "./openSafety";

describe("requiresOpenConfirmation", () => {
  it.each([
    "/Applications/Calculator.app",
    "/Applications/Calculator.app/",
    "/Users/x/Downloads/run.command",
    "C:\\Users\\x\\Downloads\\invoice.EXE",
    "C:\\Users\\x\\Desktop\\shortcut.lnk",
    "D:\\tools\\setup.msi",
    "/tmp/install.sh",
  ])("asks before opening %s", (target) => {
    expect(requiresOpenConfirmation(target)).toBe(true);
  });

  it.each([
    "/Users/x/Documents",
    "/Users/x/Documents/report.pdf",
    "C:\\Users\\x\\notes.txt",
    "/Users/x/.bashrc",
    "",
  ])("opens %s without asking", (target) => {
    expect(requiresOpenConfirmation(target)).toBe(false);
  });
});
