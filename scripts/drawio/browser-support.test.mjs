import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DRAWIO_VERSION } from "./prepare-assets.mjs";
import {
  EXPECTED_JA,
  MAX_DIAGRAM_BYTES,
  atlassian2DiagramXml,
  contentTypeFor,
  editorAssetContract,
  largeDiagramXml,
  normalizeDrawioFile,
  pngSize,
  runtimeExpectations,
  safeAssetPath,
  smokeDiagramXml,
  strayCellXml,
} from "./browser-support.mjs";

const protocolSource = readFileSync("src-tauri/src/modules/diagram/protocol.rs", "utf8");
// 1x1 の不透明な PNG。
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("draw.io browser smoke support", () => {
  it("reads the release and debug editor CSP from protocol.rs", () => {
    const contract = editorAssetContract(protocolSource);
    expect(contract.releaseCsp).toContain("connect-src 'self'");
    expect(contract.releaseCsp).toContain("worker-src 'none'");
    expect(contract.releaseCsp).toContain("frame-ancestors 'self' tauri: http://tauri.localhost");
    expect(contract.releaseCsp).not.toContain("localhost:1420");
    expect(contract.debugCsp).toBe(`${contract.releaseCsp} http://localhost:1420`);
  });

  it("reads the asset MIME table from protocol.rs", () => {
    const contract = editorAssetContract(protocolSource);
    expect(Object.keys(contract.contentTypes).length).toBeGreaterThanOrEqual(15);
    expect(contentTypeFor(contract, "js/app.min.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor(contract, "img/photo.JPEG")).toBe("image/jpeg");
    expect(contentTypeFor(contract, "math4/es5/core.wasm")).toBe("application/wasm");
    expect(contentTypeFor(contract, "resources/dia_ja.txt")).toBe("application/octet-stream");
    expect(contentTypeFor(contract, "a.b/LICENSE")).toBe("application/octet-stream");
  });

  it("rejects the same asset paths as protocol.rs", () => {
    expect(safeAssetPath("/")).toBe("index.html");
    expect(safeAssetPath("/img/Azure%20API.svg")).toBe("img/Azure API.svg");
    expect(safeAssetPath("/../secret")).toBeNull();
    expect(safeAssetPath("/%2e%2e/secret")).toBeNull();
    expect(safeAssetPath("//server/share")).toBeNull();
    expect(safeAssetPath("/./index.html")).toBeNull();
    expect(safeAssetPath("/%E0%A4%A")).toBeNull();
  });

  it("builds well-formed fixtures within the diagram size limit", () => {
    for (const xml of [smokeDiagramXml(), atlassian2DiagramXml(), strayCellXml()]) {
      expect(xml.startsWith("<mxfile ")).toBe(true);
      expect(xml).not.toContain("<!DOCTYPE");
      expect(Buffer.byteLength(xml)).toBeLessThanOrEqual(MAX_DIAGRAM_BYTES);
    }
    expect(smokeDiagramXml().match(/<diagram /g)).toHaveLength(2);
    expect(strayCellXml()).toMatch(/<mxCell id="stray" value="迷子セル" style="[^"]*" vertex="1">/);
  });

  it("builds a large diagram just under the requested size", () => {
    const xml = largeDiagramXml(850_000);
    const bytes = Buffer.byteLength(xml);
    expect(bytes).toBeLessThanOrEqual(850_000);
    expect(bytes).toBeGreaterThan(800_000);
  });

  it("normalizes only the attributes that change on every save", () => {
    const xml =
      '<mxfile host="a" agent="b" version="1" modified="2" etag="3" pages="2"><diagram id="p"><mxGraphModel dx="1" dy="2" grid="1"><root/></mxGraphModel></diagram></mxfile>';
    expect(normalizeDrawioFile(xml)).toBe(
      '<mxfile pages="2"><diagram id="p"><mxGraphModel grid="1"><root/></mxGraphModel></diagram></mxfile>',
    );
  });

  it("ignores the attribute order but keeps values and text", () => {
    const a =
      '<mxGraphModel page="1" grid="1"><mxCell id="2" value="a &gt; b" vertex="1" /></mxGraphModel>';
    const b =
      '<mxGraphModel grid="1" page="1"><mxCell vertex="1" id="2" value="a &gt; b"/></mxGraphModel>';
    expect(normalizeDrawioFile(a)).toBe(normalizeDrawioFile(b));
    expect(normalizeDrawioFile(a)).not.toBe(normalizeDrawioFile(b.replace('"2"', '"3"')));
  });

  it("reads the PNG size and rejects other data", () => {
    expect(pngSize(ONE_PIXEL_PNG)).toEqual({ width: 1, height: 1 });
    expect(() => pngSize(Buffer.from("not a png"))).toThrow("PNG ではありません。");
  });

  it("has runtime expectations for the pinned draw.io", () => {
    expect(runtimeExpectations(DRAWIO_VERSION)).toBeDefined();
    expect(() => runtimeExpectations("0.0.0")).toThrow("draw.io 0.0.0");
    expect(EXPECTED_JA.save).toBe("保存");
  });
});
