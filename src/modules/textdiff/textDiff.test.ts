import { describe, expect, it } from "vitest";

import { computeTextDiff } from "./textDiff";

describe("text diff", () => {
  it("detects added and removed lines", () => {
    const result = computeTextDiff({
      left: "one\ntwo\n",
      right: "one\nthree\n",
      mode: "lines",
      ignoreWhitespace: false,
      ignoreCase: false,
    });
    expect(result.some((change) => change.added && change.value.includes("three"))).toBe(true);
    expect(result.some((change) => change.removed && change.value.includes("two"))).toBe(true);
  });

  it("can ignore case and whitespace", () => {
    const result = computeTextDiff({
      left: "Hello   World",
      right: "hello world",
      mode: "words",
      ignoreWhitespace: true,
      ignoreCase: true,
    });
    expect(result.every((change) => !change.added && !change.removed)).toBe(true);
  });
});
