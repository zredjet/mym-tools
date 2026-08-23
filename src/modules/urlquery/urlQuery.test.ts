import { describe, expect, it } from "vitest";

import { buildAbsoluteUrl, parseAbsoluteUrl } from "./urlQuery";

describe("URL query editor", () => {
  it("preserves duplicate keys and their order", () => {
    const parsed = parseAbsoluteUrl("https://example.com:8443/a?x=1&x=2&y=%E6%97%A5#part");
    expect(parsed.query).toEqual([
      { key: "x", value: "1" },
      { key: "x", value: "2" },
      { key: "y", value: "日" },
    ]);
    expect(buildAbsoluteUrl(parsed)).toBe("https://example.com:8443/a?x=1&x=2&y=%E6%97%A5#part");
  });

  it("rejects an invalid port", () => {
    expect(() =>
      buildAbsoluteUrl({ ...parseAbsoluteUrl("https://example.com"), port: "70000" }),
    ).toThrow(/port/);
  });
});
