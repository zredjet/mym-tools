import { describe, expect, it } from "vitest";

import { evaluateRegex } from "./regexEngine";

describe("regex engine", () => {
  it("returns all captures and replacement", () => {
    const result = evaluateRegex({
      pattern: "(?<word>\\w+)",
      flags: "g",
      text: "one two",
      replacement: "<$<word>>",
    });
    expect(result.matches.map((match) => match.groups.word)).toEqual(["one", "two"]);
    expect(result.replacement).toBe("<one> <two>");
  });

  it("advances zero-width global matches", () => {
    expect(
      evaluateRegex({ pattern: "(?=a)", flags: "g", text: "aa", replacement: "" }).matches,
    ).toHaveLength(2);
  });
});
