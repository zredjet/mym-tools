import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("UI scale viewport contract", () => {
  it("gives every root container a percentage-sized, non-scrolling viewport", () => {
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

    // CSS zoom multiplies viewport-unit lengths such as 100vw/100vh. The root chain must instead
    // provide a 100%-sized containing block so the shell remains within the native window.
    expect(css).toMatch(
      /html,\s*body,\s*#root\s*{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
    );
  });
});
