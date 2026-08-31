import { beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.fn();
const parse = vi.fn();
const render = vi.fn();

vi.mock("mermaid", () => ({
  default: { initialize, parse, render },
}));

import { renderMermaid, sanitizeRenderedSvg } from "./mermaidRenderer";

describe("Mermaid offline renderer", () => {
  beforeEach(() => {
    initialize.mockReset();
    parse.mockReset().mockResolvedValue({ diagramType: "flowchart-v2" });
    render.mockReset().mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" />' });
  });

  it("fixes strict security and disables HTML labels", async () => {
    await renderMermaid("flowchart LR\nA-->B", "dark");

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      }),
    );
    expect(parse).toHaveBeenCalledBefore(render);
  });

  it("removes active content and external resource references", () => {
    const sanitized = sanitizeRenderedSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"><script>bad()</script><foreignObject/><style>@import "https://example.com/x.css"</style><image href="https://example.com/a.png"/><a href="data:text/plain,ok"><text>ok</text></a><use href="#local-symbol"/></svg>',
    );
    expect(sanitized).not.toContain("script");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("onload");
    expect(sanitized).not.toContain("https://example.com");
    expect(sanitized).not.toContain("<a");
    expect(sanitized).not.toContain("data:text/plain,ok");
    expect(sanitized).toContain('href="#local-symbol"');
  });
});
