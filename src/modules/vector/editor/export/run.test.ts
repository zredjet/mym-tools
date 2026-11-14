import { describe, expect, it, vi } from "vitest";

import { createImage } from "../model/create";
import { deepFreeze } from "../model/testing";
import type { CanvasDocument } from "../model/types";
import { updateNodes } from "../model/transform";
import { fixedWidthMeasurer } from "../render/testing";
import { planExport } from "./plan";
import { MAX_PNG_PIXELS, MAX_PNG_SIDE, pngSize } from "./png";
import { buildExportFiles, ExportError, runExport } from "./run";
import { MAX_EXPORT_SVG_BYTES } from "./svg";
import { exportDocument } from "./testing";
import type { ExportWriter } from "./types";

const measurer = fixedWidthMeasurer();
const FAKE_PNG = "data:image/png;base64,AAAA";

describe("pngSize", () => {
  it("範囲 × 倍率の整数", () => {
    expect(pngSize({ width: 40, height: 30 }, 1)).toEqual({ ok: true, width: 40, height: 30 });
    expect(pngSize({ width: 40, height: 30 }, 3)).toEqual({ ok: true, width: 120, height: 90 });
  });

  it("1 辺の上限ちょうどは書き出せ、超えれば理由を返す", () => {
    expect(pngSize({ width: MAX_PNG_SIDE, height: 1 }, 1).ok).toBe(true);
    expect(pngSize({ width: MAX_PNG_SIDE / 2, height: 1 }, 2).ok).toBe(true);
    const over = pngSize({ width: MAX_PNG_SIDE / 2 + 1, height: 1 }, 2);
    expect(over).toEqual({
      ok: false,
      reason: expect.stringContaining("1 辺の上限 16,384 px を超えます") as unknown,
    });
  });

  it("画素数の上限ちょうどは書き出せ、超えれば理由を返す", () => {
    expect(pngSize({ width: 4096, height: 4096 }, 1)).toEqual({
      ok: true,
      width: 4096,
      height: 4096,
    });
    expect(4096 * 4096).toBe(MAX_PNG_PIXELS);
    expect(pngSize({ width: 2048, height: 2048 }, 2).ok).toBe(true);
    const over = pngSize({ width: 2048, height: 2049 }, 2);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain("画素数の上限 16,777,216 を超えます");
    expect(pngSize({ width: 2000, height: 2000 }, 3).ok).toBe(false);
  });

  it("大きさが 0 なら理由を返す", () => {
    expect(pngSize({ width: 0, height: 10 }, 1).ok).toBe(false);
  });
});

describe("buildExportFiles", () => {
  it("SVG は対象ごとに 1 ファイル。名前は重ならない", async () => {
    const doc = deepFreeze(exportDocument());
    const plan = planExport(doc, "p1", ["fa", "fb"], measurer);
    const files = await buildExportFiles(doc, plan, { format: "svg", scale: 2, measurer });
    expect(files.map((file) => [file.fileName, file.format])).toEqual([
      ["表紙.svg", "svg"],
      ["表紙 (2).svg", "svg"],
    ]);
    expect(files[0]?.data).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="200" height="100"/,
    );
  });

  it("PNG は倍率をそろえた SVG を描く関数に渡し、data URL を中身にする", async () => {
    const doc = exportDocument();
    const plan = planExport(doc, "p1", ["fn"], measurer);
    const render = vi.fn(async () => FAKE_PNG);
    const files = await buildExportFiles(doc, plan, { format: "png", scale: 3, measurer, render });
    expect(files).toEqual([{ fileName: "中.png", format: "png", data: FAKE_PNG }]);
    expect(render).toHaveBeenCalledTimes(1);
    const [svg, width, height] = render.mock.calls[0] as unknown as [string, number, number];
    expect([width, height]).toEqual([120, 90]);
    expect(svg).toContain('width="120" height="90" viewBox="150 70 40 30"');
  });

  it("どれか 1 つでも PNG の上限を超えれば、何も描かずに理由を投げる", async () => {
    const doc = updateNodes(exportDocument(), ["fb"], { width: 6000, height: 500 });
    const plan = planExport(doc, "p1", ["fa", "fb"], measurer);
    const render = vi.fn(async () => FAKE_PNG);
    await expect(
      buildExportFiles(doc, plan, { format: "png", scale: 3, measurer, render }),
    ).rejects.toThrow(ExportError);
    expect(render).not.toHaveBeenCalled();
    await expect(
      buildExportFiles(doc, plan, { format: "png", scale: 2, measurer, render }),
    ).resolves.toHaveLength(2);
  });

  it("PNG の中間の SVG は大きさを見ない (大きな画像を複製して置いても PNG は書き出せる)", async () => {
    // アセットは共有でも、SVG にはノードごとに data URL が入る
    const base = exportDocument();
    const data = "A".repeat(15 * 1024 * 1024);
    const doc: CanvasDocument = {
      ...base,
      pages: [{ ...base.pages[0]!, children: ["i1", "i2"] }],
      nodes: {
        ...base.nodes,
        i1: createImage("big", { id: "i1", x: 0, y: 0, width: 100, height: 100 }),
        i2: createImage("big", { id: "i2", x: 100, y: 0, width: 100, height: 100 }),
      },
      assets: { big: { kind: "image", mime: "image/jpeg", data, width: 100, height: 100 } },
    };
    const plan = planExport(doc, "p1", [], measurer);
    const render = vi.fn(async (svg: string) => {
      expect(svg.length).toBeGreaterThan(MAX_EXPORT_SVG_BYTES);
      return FAKE_PNG;
    });
    await expect(
      buildExportFiles(doc, plan, { format: "png", scale: 1, measurer, render }),
    ).resolves.toEqual([{ fileName: "ページ 1.png", format: "png", data: FAKE_PNG }]);
    // SVG のファイルとしては上限を超える
    await expect(
      buildExportFiles(doc, plan, { format: "svg", scale: 1, measurer }),
    ).rejects.toThrow("SVG は 28 MiB 以下にしてください。");
  });

  it("書き出せない対象は理由を投げる", async () => {
    const doc = updateNodes(exportDocument(), ["hid"], { visible: false });
    const plan = planExport(doc, "p1", ["hid"], measurer);
    await expect(
      buildExportFiles(doc, plan, { format: "svg", scale: 1, measurer }),
    ).rejects.toThrow("選択したノードはすべて非表示です。");
  });
});

describe("runExport", () => {
  it("作ったファイルをまとめて登録された関数に渡す", async () => {
    const doc = deepFreeze(exportDocument());
    const plan = planExport(doc, "p1", [], measurer);
    const writer = vi.fn<ExportWriter>(async (files) => ({ written: files.length }));
    const result = await runExport(doc, plan, writer, { format: "svg", scale: 1, measurer });
    expect(result).toEqual({ written: 1, total: 1 });
    expect(writer.mock.calls[0]?.[0].map((file) => file.fileName)).toEqual(["ページ 1.svg"]);
  });

  it("書き込みの失敗はそのまま投げる", async () => {
    const doc = exportDocument();
    const plan = planExport(doc, "p1", [], measurer);
    const writer: ExportWriter = () => Promise.reject(new Error("disk full"));
    await expect(
      runExport(doc, plan, writer, { format: "svg", scale: 1, measurer }),
    ).rejects.toThrow("disk full");
  });
});
