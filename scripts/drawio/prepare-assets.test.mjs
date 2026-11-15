import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLIENT_DIRECTORIES,
  CLIENT_FILES,
  DRAWIO_COMMIT,
  DRAWIO_DOMPURIFY_VERSION,
  DRAWIO_VERSION,
  REQUIRED_CLIENT_ASSETS,
  RETIRED_GENERATED_PATHS,
  drawioAssetStamp,
  removeRetiredAssets,
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

describe("retired generated assets", () => {
  it("removes SVG-Edit leftovers and keeps everything else", () => {
    const root = mkdtempSync(join(tmpdir(), "mym-generated-"));
    try {
      mkdirSync(join(root, "svgedit/dist"), { recursive: true });
      writeFileSync(join(root, "svgedit/dist/index.html"), "old");
      mkdirSync(join(root, "licenses/svgedit"), { recursive: true });
      writeFileSync(join(root, "licenses/svgedit/LICENSE"), "old");
      writeFileSync(join(root, "licenses/drawio-LICENSE.txt"), "keep");
      writeFileSync(join(root, ".svgedit-stamp.json"), "{}");
      mkdirSync(join(root, "drawio"), { recursive: true });
      writeFileSync(join(root, ".drawio-stamp.json"), "{}");

      expect(removeRetiredAssets(root)).toEqual(RETIRED_GENERATED_PATHS);
      for (const path of RETIRED_GENERATED_PATHS) expect(existsSync(join(root, path))).toBe(false);
      expect(readFileSync(join(root, "licenses/drawio-LICENSE.txt"), "utf8")).toBe("keep");
      expect(existsSync(join(root, "drawio"))).toBe(true);
      expect(existsSync(join(root, ".drawio-stamp.json"))).toBe(true);
      // 2 回目は何もしない
      expect(removeRetiredAssets(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
