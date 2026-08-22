import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readCss = () => readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  if (match?.[1] == null) throw new Error(`CSS rule not found: ${selector}`);
  return match[1];
}

function hexVariable(rule: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = rule.match(new RegExp(`${escaped}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (value == null) throw new Error(`CSS variable not found: ${name}`);
  return value;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("UI scale viewport contract", () => {
  it("gives every root container a percentage-sized, non-scrolling viewport", () => {
    const css = readCss();

    // CSS zoom multiplies viewport-unit lengths such as 100vw/100vh. The root chain must instead
    // provide a 100%-sized containing block so the shell remains within the native window.
    expect(css).toMatch(
      /html,\s*body,\s*#root\s*{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
    );
  });
});

describe("Markdown syntax highlight contrast", () => {
  it("keeps dark-mode token colors at WCAG AA contrast against the code background", () => {
    const css = readCss();
    const darkTheme = ruleBody(css, '[data-theme="dark"]');
    const background = hexVariable(darkTheme, "--bg-muted");
    const foregroundTokens = [
      "--hljs-fg",
      "--hljs-keyword",
      "--hljs-entity",
      "--hljs-constant",
      "--hljs-string",
      "--hljs-variable",
      "--hljs-comment",
      "--hljs-tag",
      "--hljs-section",
      "--hljs-bullet",
      "--hljs-addition-fg",
      "--hljs-deletion-fg",
    ];

    for (const token of foregroundTokens) {
      expect(
        contrastRatio(hexVariable(darkTheme, token), background),
        token,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toMatch(
      /\[data-theme="dark"\] \.prose-mymtools \.hljs\s*{[^}]*color:\s*var\(--hljs-fg\)/s,
    );
    expect(css).toMatch(/\.hljs-string[^{]*{[^}]*color:\s*var\(--hljs-string\)/s);
  });
});
