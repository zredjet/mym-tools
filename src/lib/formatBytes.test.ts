import { describe, expect, it } from "vitest";

import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it("uses 1024-based units up to petabytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
    expect(formatBytes(3 * 1024 ** 5)).toBe("3.0 PB");
    expect(formatBytes(2048 * 1024 ** 5)).toBe("2048.0 PB");
  });
});
