import { describe, expect, it } from "vitest";

import { convertDateTime } from "./dateTime";

describe("date time conversion", () => {
  it("converts Unix seconds to UTC and JST", () => {
    const result = convertDateTime("0", "unix_seconds", "Asia/Tokyo");
    expect(result.utc).toBe("1970-01-01T00:00:00.000Z");
    expect(result.zoned).toContain("1970-01-01T09:00:00.000+09:00[Asia/Tokyo]");
  });

  it("rejects a DST gap and overlap", () => {
    expect(() => convertDateTime("2024-03-10T02:30", "local", "America/Los_Angeles")).toThrow();
    expect(() => convertDateTime("2024-11-03T01:30", "local", "America/Los_Angeles")).toThrow();
  });
});
