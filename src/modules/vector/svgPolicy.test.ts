import { describe, expect, it } from "vitest";
import { validateSvg, MAX_SVG_BYTES, MAX_TEXT_BYTES } from "../../../scripts/svgedit/svg-policy.js";
import policy from "../../../scripts/svgedit/policy.json";
import fixtures from "../../../scripts/svgedit/validation-fixtures.json";

describe("SVG persistence policy (shared Rust/browser fixtures)", () => {
  for (const fixture of fixtures)
    it(fixture.name, () => {
      if (fixture.valid)
        expect(validateSvg(fixture.svg, policy)).toEqual({ svg: fixture.svg, text: fixture.text });
      else expect(() => validateSvg(fixture.svg, policy)).toThrow();
    });
  it("enforces UTF-8 byte boundaries without silently shortening documents", () => {
    const wrap = (text: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`;
    expect(validateSvg(wrap("a".repeat(MAX_TEXT_BYTES)), policy).text.length).toBe(MAX_TEXT_BYTES);
    expect(() => validateSvg(wrap("a".repeat(MAX_TEXT_BYTES) + "あ"), policy)).toThrow("1MiB");
    const base = '<svg xmlns="http://www.w3.org/2000/svg"><!-- --></svg>';
    const exact = base.replace("<!-- -->", `<!--${"a".repeat(MAX_SVG_BYTES - base.length + 1)}-->`);
    expect(new TextEncoder().encode(exact).length).toBe(MAX_SVG_BYTES);
    expect(validateSvg(exact, policy).svg).toBe(exact);
    expect(() => validateSvg(exact + " ", policy)).toThrow("20MiB");
  });
});
