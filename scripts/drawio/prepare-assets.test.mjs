import { describe, expect, it } from "vitest";

import {
  CLIENT_DIRECTORIES,
  CLIENT_FILES,
  DRAWIO_COMMIT,
  DRAWIO_VERSION,
  drawioAssetStamp,
} from "./prepare-assets.mjs";

describe("draw.io offline asset contract", () => {
  it("pins the approved upstream release and commit", () => {
    expect(DRAWIO_VERSION).toBe("31.4.1");
    expect(DRAWIO_COMMIT).toBe("fea5e877f3e6f849331ad09894f7edb9771708fa");
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
    expect([...CLIENT_DIRECTORIES, ...CLIENT_FILES]).not.toEqual(
      expect.arrayContaining(["WEB-INF", "META-INF", "service-worker.js"]),
    );
  });

  it("invalidates generated assets when an offline override or bundled license changes", () => {
    expect(drawioAssetStamp()).toMatchObject({
      commit: DRAWIO_COMMIT,
      version: DRAWIO_VERSION,
      layout: 4,
      preConfigSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      mermaidLicenseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
