/**
 * 読んだファイルをアセットにする (§4.8 / §3.4)。
 *
 * - 画像: data URL を mime と base64 に分け、読み込んで本来の大きさを求める。読み込めなければ取り込まない
 * - SVG: 今のベクター描画と同じ SVG ポリシー (`scripts/svgedit/svg-policy.js` の `validateSvg`) を通し、
 *   抽出した文字が読む関数の返した `text` (Rust の抽出結果) と一致することを確かめる。
 *   U+0085 をそのまま含む SVG は Rust とブラウザで抽出が違い、置いても保存できないため
 */
import policy from "../../../../../scripts/svgedit/policy.json";
import { validateSvg } from "../../../../../scripts/svgedit/svg-policy.js";
import { DEFAULT_NODE_NAMES } from "../model/create";
import { CANVAS_LIMITS } from "../model/limits";
import type { Asset, ImageAsset } from "../model/types";
import { hasLoneSurrogate } from "../model/validate";
import { svgIntrinsicSize } from "./svgSize";
import type { ImportedFile } from "./types";

export type ImageMime = ImageAsset["mime"];
const IMAGE_MIMES: readonly ImageMime[] = ["image/png", "image/jpeg", "image/webp"];

/** 画像の本来の大きさを求める関数 (テストでは差し替える)。読み込めなければ例外を投げる。 */
export type MeasureImage = (dataUrl: string) => Promise<{ width: number; height: number }>;

/** 画像の読み込みを待つ上限 (ms)。終わらなければ取り込まない (取込中のまま止まらないように)。 */
export const MEASURE_IMAGE_TIMEOUT = 30_000;

/**
 * ブラウザで画像を読み込み、本来の大きさを求める。
 * `decode()` は、描画していないページ (隠れた WebView など) では終わらないことがあるので、`load` を待つ。
 */
export const measureImageInBrowser: MeasureImage = (dataUrl) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => finish(new Error("timeout")), MEASURE_IMAGE_TIMEOUT);
    function finish(error: Error | null) {
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve({ width: image.naturalWidth, height: image.naturalHeight });
    }
    image.onload = () => finish(null);
    image.onerror = () => finish(new Error("load"));
    image.src = dataUrl;
  });

/**
 * `data:image/png;base64,...` を mime と base64 に分ける。形が違えば null。
 * 20 MiB の文字列にも正規表現を当てない (先頭だけを見る)。
 */
export function parseImageDataUrl(dataUrl: string): { mime: ImageMime; data: string } | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || comma > 64) return null;
  const header = dataUrl.slice(0, comma);
  const match = /^data:([a-z/]+);base64$/i.exec(header);
  const mime = match?.[1]?.toLowerCase() as ImageMime | undefined;
  if (!mime || !IMAGE_MIMES.includes(mime)) return null;
  const data = dataUrl.slice(comma + 1);
  return data.length === 0 ? null : { mime, data };
}

/** ノードの名前 (ファイル名)。使えない名前なら種別の既定の名前。上限の文字数で切る。 */
export function importedName(name: string | undefined, kind: "image" | "svg"): string {
  const fallback = DEFAULT_NODE_NAMES[kind];
  if (name === undefined || hasLoneSurrogate(name)) return fallback;
  const trimmed = name.trim();
  if (trimmed.length === 0) return fallback;
  const chars = Array.from(trimmed);
  return chars.length > CANVAS_LIMITS.maxNameLength
    ? chars.slice(0, CANVAS_LIMITS.maxNameLength).join("")
    : trimmed;
}

export type PreparedImport =
  | { ok: true; asset: Asset; name: string; notices: readonly string[] }
  | { ok: false; reason: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 読んだファイルをアセットにする。取り込めなければ理由を返す。 */
export async function prepareImport(
  file: ImportedFile,
  measureImage: MeasureImage = measureImageInBrowser,
): Promise<PreparedImport> {
  if (file.kind === "image") {
    const parsed = parseImageDataUrl(file.dataUrl);
    if (!parsed)
      return { ok: false, reason: "PNG / JPEG / WebP の画像ではないため、取り込めません。" };
    let size: { width: number; height: number };
    try {
      size = await measureImage(file.dataUrl);
    } catch {
      return { ok: false, reason: "画像を読み込めないため、取り込めません。" };
    }
    if (!(size.width > 0 && size.height > 0))
      return { ok: false, reason: "画像の大きさが分からないため、取り込めません。" };
    return {
      ok: true,
      asset: { kind: "image", ...parsed, width: size.width, height: size.height },
      name: importedName(file.name, "image"),
      notices: [],
    };
  }

  let extracted: string;
  try {
    extracted = validateSvg(file.svg, policy).text;
  } catch (error) {
    return { ok: false, reason: `この SVG は取り込めません (${message(error)})。` };
  }
  if (extracted !== file.text)
    return {
      ok: false,
      reason:
        "SVG から取り出した文字がアプリ本体の結果と一致しないため、取り込めません (U+0085 などの文字を含む SVG は保存できません)。",
    };
  const size = svgIntrinsicSize(file.svg);
  return {
    ok: true,
    asset: { kind: "svg", svg: file.svg, text: file.text, ...size },
    name: importedName(file.name, "svg"),
    notices: file.notices ?? [],
  };
}
