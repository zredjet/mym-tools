import { describe, expect, it } from "vitest";

import { knownFolderHint, unreadableGuidance } from "./knownFolders";

describe("knownFolderHint", () => {
  it("explains well-known Windows folders regardless of case", () => {
    expect(knownFolderHint("System Volume Information", "C:\\", true)?.title).toBe(
      "復元ポイント・シャドウコピー",
    );
    expect(knownFolderHint("$RECYCLE.BIN", "C:\\", true)?.title).toBe("ごみ箱");
    expect(knownFolderHint("WindowsApps", "Program Files", true)?.title).toBe("ストアアプリ");
  });

  it("explains per-user folders inside the recycle bin", () => {
    expect(knownFolderHint("S-1-5-21-1000", "$Recycle.Bin", true)?.title).toBe("ごみ箱");
  });

  it("has nothing for other folders or on macOS", () => {
    expect(knownFolderHint("Users", "C:\\", true)).toBeNull();
    expect(knownFolderHint("WindowsApps", null, false)).toBeNull();
  });
});

describe("unreadableGuidance", () => {
  it("points to administrator rights on Windows and Full Disk Access on macOS", () => {
    expect(unreadableGuidance(true)).toContain("管理者権限");
    expect(unreadableGuidance(false)).toContain("フルディスクアクセス");
  });
});
