import { describe, expect, it } from "vitest";

import { transformText } from "./codec";

describe("codec", () => {
  it.each(["base64", "base64url", "url", "html", "unicode"] as const)(
    "round trips Unicode with %s",
    (format) => {
      const encoded = transformText("Hello 日本語 😀 & <tag>", format, "encode");
      expect(transformText(encoded, format, "decode")).toBe("Hello 日本語 😀 & <tag>");
    },
  );

  it("rejects malformed base64", () => {
    expect(() => transformText("%%%", "base64", "decode")).toThrow(/Base64/);
  });

  it("decodes UTF-16 surrogate-pair escapes", () => {
    expect(transformText("\\uD83D\\uDE00", "unicode", "decode")).toBe("😀");
  });

  it("rejects isolated UTF-16 surrogate escapes", () => {
    expect(() => transformText("\\uD83D", "unicode", "decode")).toThrow(/Unicode/);
    expect(() => transformText("\\uDE00", "unicode", "decode")).toThrow(/Unicode/);
  });
});
