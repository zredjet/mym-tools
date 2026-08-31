import { describe, expect, it } from "vitest";

import {
  MAX_DRAWIO_MESSAGE_CHARS,
  drawioEditorUrl,
  drawioLoadMessage,
  drawioTargetOrigin,
  isTrustedDrawioOrigin,
  parseDrawioMessage,
} from "./drawioBridge";

describe("draw.io parent bridge", () => {
  it("accepts only a loopback editor URL and adds offline flags", () => {
    const editorUrl = drawioEditorUrl("http://127.0.0.1:43123/index.html");
    const url = new URL(editorUrl);
    expect(url.origin).toBe("http://127.0.0.1:43123");
    expect(url.searchParams.get("offline")).toBe("1");
    expect(url.searchParams.get("lockdown")).toBe("1");
    expect(url.searchParams.get("suppressNewWindows")).toBe("1");
    expect(editorUrl).not.toContain("diagrams.net");
    expect(() => drawioEditorUrl("https://127.0.0.1:43123/index.html")).toThrow();
    expect(() => drawioEditorUrl("http://localhost:43123/index.html")).toThrow();
    expect(() => drawioEditorUrl("http://127.0.0.1:43123/other.html")).toThrow();
  });

  it("accepts only the exact random-port editor origin", () => {
    const editorUrl = "http://127.0.0.1:43123/index.html?offline=1";
    const expected = drawioTargetOrigin(editorUrl);
    expect(expected).toBe("http://127.0.0.1:43123");
    expect(isTrustedDrawioOrigin(expected, expected)).toBe(true);
    expect(isTrustedDrawioOrigin("http://127.0.0.1:43124", expected)).toBe(false);
    expect(isTrustedDrawioOrigin("https://embed.diagrams.net", expected)).toBe(false);
    expect(isTrustedDrawioOrigin("null", expected)).toBe(false);
  });

  it("parses supported messages and preserves request ordering tokens", () => {
    expect(parseDrawioMessage('{"event":"init"}')).toEqual({ event: "init" });
    expect(
      parseDrawioMessage(
        JSON.stringify({
          event: "textContent",
          data: "Client Server",
          message: { action: "textContent", requestId: "request-1" },
        }),
      ),
    ).toEqual({ event: "textContent", data: "Client Server", requestId: "request-1" });
    expect(
      parseDrawioMessage(
        JSON.stringify({
          event: "export",
          format: "png",
          data: "data:image/png;base64,AAAA",
          message: { requestId: "export-1" },
        }),
      ),
    ).toEqual({
      event: "export",
      format: "png",
      data: "data:image/png;base64,AAAA",
      requestId: "export-1",
    });
  });

  it("rejects malformed, unknown and oversized messages", () => {
    expect(parseDrawioMessage("not-json")).toBeNull();
    expect(parseDrawioMessage('{"event":"unknown"}')).toBeNull();
    expect(parseDrawioMessage({ event: "init" })).toBeNull();
    expect(parseDrawioMessage("x".repeat(MAX_DRAWIO_MESSAGE_CHARS + 1))).toBeNull();
  });

  it("builds an offline load command with autosave and export protocol", () => {
    expect(JSON.parse(drawioLoadMessage("<mxfile/>", "構成図"))).toEqual({
      action: "load",
      xml: "<mxfile/>",
      title: "構成図",
      autosave: 1,
      exportProtocol: true,
      noSaveBtn: 1,
      noExitBtn: 1,
      saveAndExit: 0,
    });
  });
});
