/** 取込のテスト用のデータ。 */
import type { ImageAsset, SvgAsset } from "../model/types";

/** 先頭 24 バイトが正しい PNG (IHDR の幅と高さを持つ) の base64。中身は描画できない。 */
export function pngBase64(width: number, height: number, seed = 0): string {
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0];
  const bytes = [...signature, ...ihdr, ...u32(seed)];
  return btoa(String.fromCharCode(...bytes));
}

export function pngDataUrl(width: number, height: number, seed = 0): string {
  return `data:image/png;base64,${pngBase64(width, height, seed)}`;
}

export function imageAsset(width: number, height: number, seed = 0): ImageAsset {
  return { kind: "image", mime: "image/png", data: pngBase64(width, height, seed), width, height };
}

export const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="50">こんにちは 世界</text></svg>';
export const SAMPLE_SVG_TEXT = "こんにちは 世界";

export function svgAsset(): SvgAsset {
  return { kind: "svg", svg: SAMPLE_SVG, text: SAMPLE_SVG_TEXT, width: 200, height: 100 };
}
