/**
 * PNG の書き出し (§4.9)。上限は今の書き出しと同じ (20 MiB、1 辺 16,384 px、16,777,216 画素)。
 *
 * 大きさと上限の判定は純関数。描画は `src/modules/mermaid/mermaidExporter.ts` と同じ経路
 * (SVG を Blob の URL にして画像として読み込み、canvas に描いて `toBlob`) で、背景は透明のまま。
 */
import {
  MAX_MERMAID_EXPORT_BYTES,
  MAX_MERMAID_PNG_PIXELS,
  MAX_MERMAID_PNG_SIDE,
} from "@/modules/mermaid/mermaidExporter";

import type { Rect } from "../model/geometry";
import type { ExportScale } from "./types";

export const MAX_PNG_SIDE = MAX_MERMAID_PNG_SIDE;
export const MAX_PNG_PIXELS = MAX_MERMAID_PNG_PIXELS;
export const MAX_PNG_BYTES = MAX_MERMAID_EXPORT_BYTES;

export type PngSize = { ok: true; width: number; height: number } | { ok: false; reason: string };

/** 範囲と倍率から PNG の大きさを求める。上限を超えれば理由を返す。 */
export function pngSize(bounds: Pick<Rect, "width" | "height">, scale: ExportScale): PngSize {
  const width = Math.ceil(bounds.width * scale);
  const height = Math.ceil(bounds.height * scale);
  if (!(width > 0 && height > 0)) return { ok: false, reason: "描く範囲の大きさが 0 です。" };
  if (width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) {
    return {
      ok: false,
      reason: `${scale}x では ${width.toLocaleString()} × ${height.toLocaleString()} px になり、1 辺の上限 ${MAX_PNG_SIDE.toLocaleString()} px を超えます。`,
    };
  }
  if (width * height > MAX_PNG_PIXELS) {
    return {
      ok: false,
      reason: `${scale}x では ${width.toLocaleString()} × ${height.toLocaleString()} px になり、画素数の上限 ${MAX_PNG_PIXELS.toLocaleString()} を超えます。`,
    };
  }
  return { ok: true, width, height };
}

/**
 * SVG を PNG にして `data:image/png;base64,` の data URL で返す。
 * `svg` のルートの `width` / `height` は書き出す大きさにそろえておく (`buildExportSvg` の `scale`)。
 * 拡大して描くと WebKit では画像の大きさで描いてから引き伸ばしてぼけることがあるため。
 */
export async function renderPng(svg: string, width: number, height: number): Promise<string> {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(objectUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("PNG を描く canvas を用意できませんでした。");
    context.drawImage(image, 0, 0, width, height);
    const png = await canvasToBlob(canvas);
    if (png.size > MAX_PNG_BYTES) throw new Error("PNG は 20 MiB 以下にしてください。");
    return await blobToDataUrl(png);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("SVG を PNG に描けませんでした。"));
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("PNG を作れませんでした。"));
      else resolve(blob);
    }, "image/png");
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:image/png;base64,"))
        resolve(reader.result);
      else reject(new Error("PNG を data URL にできませんでした。"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("PNG を読めませんでした。"));
    reader.readAsDataURL(blob);
  });
}
