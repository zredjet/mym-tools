import { describe, expect, it } from "vitest";

import { generatePassword, generateToken } from "./secretGenerator";

describe("secret generator", () => {
  it("includes each enabled character group and excludes ambiguous characters", () => {
    const value = generatePassword({
      length: 64,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
      excludeAmbiguous: true,
    });
    expect(value).toHaveLength(64);
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[2-9]/);
    expect(value).toMatch(/[^A-Za-z0-9]/);
    expect(value).not.toMatch(/[0OolI1]/);
  });

  it("uses the requested token byte length", () => {
    expect(generateToken(16, "hex")).toHaveLength(32);
    expect(generateToken(32, "base64url")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
