/**
 * 書き出す SVG の文字列 (純関数、§4.3 / §4.9)。
 *
 * ノードは画面と同じ `buildNodeSvg` で `SvgEl` にし、ルートの `<svg>` も `SvgEl` で組んで
 * `svgElToString` で文字列にする (描画の規則と XML のエスケープを書き出し側に書き直さない)。
 * `viewBox` は範囲のページ座標なので、各ノードは親の座標系の原点 (ページ座標) へ移すだけでよい。
 * 背景は透明 (frame の塗りは frame のノードとして描かれる)。
 */
import { nodeOrigin } from "../model/geometry";
import type { CanvasDocument } from "../model/types";
import { buildNodeSvg } from "../render/buildNodeSvg";
import { el, formatNumber, SVG_NS, svgElToString } from "../render/svgEl";
import type { SvgEl, TextMeasurer } from "../render/types";
import type { ExportTarget } from "./types";

/**
 * 書き出す SVG の上限 (UTF-8 のバイト数)。28 MiB。
 * 埋め込み SVG と画像は base64 の data URL で入り 4/3 倍になるので、v1 の上限いっぱい (20 MiB) の
 * 作品を v2 に包んだものも書き出せるよう、20 MiB × 4/3 に余裕を足した値にする。
 * Rust の `vector_write_file` の上限 (今は 20 MiB) は切替 PR でこの値に合わせる。
 */
export const MAX_EXPORT_SVG_BYTES = 28 * 1024 * 1024;

/**
 * `<defs>` の ID の接頭辞。1 つの文書の中ではノード ID が重ならないので、
 * 1 つの SVG に複数のノードを入れても定義の ID は重ならない。
 */
export const EXPORT_ID_PREFIX = "mym-";

export interface ExportSvgOptions {
  measurer: TextMeasurer;
  /**
   * ルートの `width` / `height` に掛ける倍率 (`viewBox` は変えない)。PNG では画像として読み込んだときの
   * 大きさを書き出す大きさにそろえ、拡大した描画がぼけないようにする。既定は 1
   */
  scale?: number;
}

/** 対象を描いた `SvgEl` (ルートの `<svg>`)。 */
export function buildExportSvgEl(
  doc: CanvasDocument,
  target: ExportTarget,
  options: ExportSvgOptions,
): SvgEl {
  const scale = options.scale ?? 1;
  const { bounds } = target;
  const children: SvgEl[] = [];
  for (const id of target.nodeIds) {
    const built = buildNodeSvg(doc, id, { measurer: options.measurer, idPrefix: EXPORT_ID_PREFIX });
    if (!built) continue;
    const origin = nodeOrigin(doc, id);
    children.push(
      origin.x === 0 && origin.y === 0
        ? built
        : el("g", { transform: `translate(${formatNumber(origin.x)} ${formatNumber(origin.y)})` }, [
            built,
          ]),
    );
  }
  return el(
    "svg",
    {
      xmlns: SVG_NS,
      width: bounds.width * scale,
      height: bounds.height * scale,
      viewBox: [bounds.x, bounds.y, bounds.width, bounds.height].map(formatNumber).join(" "),
    },
    children,
  );
}

/** 対象を描いた SVG の文字列。 */
export function buildExportSvg(
  doc: CanvasDocument,
  target: ExportTarget,
  options: ExportSvgOptions,
): string {
  return svgElToString(buildExportSvgEl(doc, target, options));
}

/**
 * 文字列の UTF-8 のバイト数。対になっていないサロゲートがあれば null (UTF-8 にできない)。
 * `TextEncoder` は U+FFFD に置き換えて通してしまい、`String.prototype.isWellFormed` は
 * Safari 16.4 からなので、1 文字ずつ数える。
 */
export function utf8ByteLength(value: string): number | null {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      bytes += 4;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return null;
    else bytes += 3;
  }
  return bytes;
}

/**
 * 書き出す SVG が UTF-8 にでき、上限以下か。だめなら理由。
 * `maxBytes` が null なら大きさを見ない (PNG の中間の SVG。同じアセットを使うノードごとに data URL が入って
 * 大きくなるが、ファイルには書かず、上限は PNG のほうで確かめる)。
 */
export function checkExportSvg(
  svg: string,
  maxBytes: number | null = MAX_EXPORT_SVG_BYTES,
): string | null {
  const bytes = utf8ByteLength(svg);
  if (bytes === null) return "SVG に UTF-8 にできない文字があります。";
  if (maxBytes !== null && bytes > maxBytes)
    return `SVG は ${Math.floor(maxBytes / 1024 / 1024)} MiB 以下にしてください。`;
  return null;
}
