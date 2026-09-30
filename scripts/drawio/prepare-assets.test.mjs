import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CLIENT_DIRECTORIES,
  CLIENT_FILES,
  DRAWIO_COMMIT,
  DRAWIO_DOMPURIFY_VERSION,
  DRAWIO_VERSION,
  REQUIRED_CLIENT_ASSETS,
  drawioAssetStamp,
} from "./prepare-assets.mjs";

const APP_BUNDLE = "vendor/drawio/src/main/webapp/js/app.min.js";

describe("draw.io offline asset contract", () => {
  it("pins the approved upstream release and commit", () => {
    expect(DRAWIO_VERSION).toBe("31.5.3");
    expect(DRAWIO_COMMIT).toBe("0f419a92c769adb5fb20f2b18053a5ae8c7e4993");
    expect(DRAWIO_DOMPURIFY_VERSION).toBe("3.4.16");
  });

  it("ships the runtime bundle of the pinned release", () => {
    if (!existsSync(APP_BUNDLE)) {
      throw new Error(
        "draw.io submodule が初期化されていません。git submodule update --init --depth 1 vendor/drawio を実行してください。",
      );
    }
    const bundle = readFileSync(APP_BUNDLE, "utf8");
    expect(bundle).toContain(`@license DOMPurify ${DRAWIO_DOMPURIFY_VERSION} |`);
    expect(bundle).toContain(`EditorUi.VERSION="${DRAWIO_VERSION}"`);
  });

  it("copies every client asset family without server or service-worker assets", () => {
    expect(CLIENT_DIRECTORIES).toEqual(
      expect.arrayContaining([
        "images",
        "img",
        "js",
        "math4",
        "mxgraph",
        "plugins",
        "resources",
        "shapes",
        "stencils",
        "styles",
        "templates",
      ]),
    );
    expect(CLIENT_FILES).toContain("index.html");
    expect(REQUIRED_CLIENT_ASSETS).toContain("resources/dia_ja.txt");
    expect([...CLIENT_DIRECTORIES, ...CLIENT_FILES]).not.toEqual(
      expect.arrayContaining(["WEB-INF", "META-INF", "service-worker.js"]),
    );
  });

  it("invalidates generated assets when an offline override or bundled license changes", () => {
    expect(drawioAssetStamp()).toMatchObject({
      commit: DRAWIO_COMMIT,
      version: DRAWIO_VERSION,
      layout: 5,
      preConfigSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      mermaidLicenseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      lopdfLicenseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      shotqNoticesSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
