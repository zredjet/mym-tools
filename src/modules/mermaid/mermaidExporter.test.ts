import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_MERMAID_PNG_PIXELS, mermaidPngDimensions, renderMermaidPng } from "./mermaidExporter";

describe("Mermaid PNG exporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the SVG viewBox and renders at double resolution", () => {
    expect(mermaidPngDimensions('<svg viewBox="0 0 320 180"/>')).toEqual({
      width: 640,
      height: 360,
    });
    expect(mermaidPngDimensions('<svg width="120px" height="80px"/>')).toEqual({
      width: 240,
      height: 160,
    });
  });

  it("rejects missing, oversized, and excessive-pixel dimensions", () => {
    expect(() => mermaidPngDimensions("<svg/>")).toThrow("有効なviewBoxまたは寸法");
    expect(() => mermaidPngDimensions('<svg viewBox="0 0 9000 10"/>')).toThrow("上限");
    expect(MAX_MERMAID_PNG_PIXELS).toBe(16_777_216);
    expect(() => mermaidPngDimensions('<svg viewBox="0 0 3000 2000"/>')).toThrow("上限");
  });

  it("paints a white background, draws at 2x, and revokes the Blob URL", async () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const context = { fillStyle: "", fillRect, drawImage };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
      }),
    };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) =>
      tagName === "canvas"
        ? (canvas as unknown as HTMLCanvasElement)
        : createElement(tagName, options),
    );
    const createObjectURL = vi.fn(() => "blob:mermaid-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", MockImage);

    const result = await renderMermaidPng('<svg viewBox="0 0 100 50"/>');

    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
    expect(context.fillStyle).toBe("#ffffff");
    expect(fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
    expect(drawImage).toHaveBeenCalledWith(expect.any(MockImage), 0, 0, 200, 100);
    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mermaid-preview");
  });
});
