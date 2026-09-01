export const MERMAID_PNG_SCALE = 2;
export const MAX_MERMAID_PNG_SIDE = 16_384;
export const MAX_MERMAID_PNG_PIXELS = 16_777_216;
export const MAX_MERMAID_EXPORT_BYTES = 20 * 1024 * 1024;

export interface MermaidPngDimensions {
  width: number;
  height: number;
}

export function mermaidPngDimensions(svg: string): MermaidPngDimensions {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (document.querySelector("parsererror") != null || root.localName.toLowerCase() !== "svg") {
    throw new Error("Mermaid SVGの寸法を取得できませんでした。");
  }

  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  let sourceWidth: number | undefined;
  let sourceHeight: number | undefined;
  if (
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2] != null &&
    viewBox[3] != null &&
    viewBox[2] > 0 &&
    viewBox[3] > 0
  ) {
    sourceWidth = viewBox[2];
    sourceHeight = viewBox[3];
  } else {
    sourceWidth = numericSvgLength(root.getAttribute("width"));
    sourceHeight = numericSvgLength(root.getAttribute("height"));
  }

  if (sourceWidth == null || sourceHeight == null) {
    throw new Error("Mermaid SVGに有効なviewBoxまたは寸法がありません。");
  }
  const width = Math.ceil(sourceWidth * MERMAID_PNG_SCALE);
  const height = Math.ceil(sourceHeight * MERMAID_PNG_SCALE);
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_MERMAID_PNG_SIDE ||
    height > MAX_MERMAID_PNG_SIDE ||
    width * height > MAX_MERMAID_PNG_PIXELS
  ) {
    throw new Error(
      `PNGの寸法が上限を超えています（最大${MAX_MERMAID_PNG_SIDE.toLocaleString()}px／${MAX_MERMAID_PNG_PIXELS.toLocaleString()}画素）。`,
    );
  }
  return { width, height };
}

export async function renderMermaidPng(svg: string): Promise<string> {
  const { width, height } = mermaidPngDimensions(svg);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(objectUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context == null) throw new Error("PNG描画用Canvasを初期化できませんでした。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const png = await canvasToBlob(canvas);
    if (png.size > MAX_MERMAID_EXPORT_BYTES) {
      throw new Error("PNGは20MiB以下にしてください。");
    }
    return blobToDataUrl(png);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function numericSvgLength(value: string | null): number | undefined {
  if (value == null || !/^\d+(?:\.\d+)?(?:px)?$/i.test(value.trim())) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Mermaid SVGをPNGへ描画できませんでした。"));
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob == null) {
        reject(new Error("PNGの生成に失敗しました。"));
      } else {
        resolve(blob);
      }
    }, "image/png");
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("PNGのエンコードに失敗しました。"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("PNGの読込みに失敗しました。"));
    reader.readAsDataURL(blob);
  });
}
