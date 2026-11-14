/**
 * 書き出しの手順 (§4.9): 対象を決め、ファイルの中身を作り、登録された関数で書き込む。
 *
 * 文書は呼び出した時点のもの (store の今の文書) を使い、変えない (履歴も `revision` も増やさない)。
 * 上限の判定は、PNG を描く前と書き込む前に済ませる (1 つでも超えれば、どのファイルも書き込まない)。
 */
import type { CanvasDocument } from "../model/types";
import type { TextMeasurer } from "../render/types";
import { uniqueFileNames } from "./fileName";
import { pngSize, renderPng } from "./png";
import { buildExportSvg, checkExportSvg } from "./svg";
import type {
  ExportFile,
  ExportFormat,
  ExportPlan,
  ExportScale,
  ExportWriteResult,
  ExportWriter,
} from "./types";

export interface BuildFilesOptions {
  format: ExportFormat;
  /** PNG の倍率。SVG では使わない */
  scale: ExportScale;
  measurer: TextMeasurer;
  /** PNG を描く関数 (テストで差し替える)。既定は `renderPng` */
  render?: (svg: string, width: number, height: number) => Promise<string>;
}

/** 書き出せない理由を表す例外。表示する文はそのまま利用者に見せる。 */
export class ExportError extends Error {
  override name = "ExportError";
}

/** 対象ごとのファイルを作る。書き出せなければ `ExportError` を投げる。 */
export async function buildExportFiles(
  doc: CanvasDocument,
  plan: ExportPlan,
  options: BuildFilesOptions,
): Promise<ExportFile[]> {
  if (!plan.ok) throw new ExportError(plan.reason);
  const { format, scale, measurer } = options;
  const names = uniqueFileNames(
    plan.targets.map((target) => target.name),
    format,
  );

  if (format === "svg") {
    return plan.targets.map((target, index) => {
      const data = buildExportSvg(doc, target, { measurer });
      const problem = checkExportSvg(data);
      if (problem) throw new ExportError(problem);
      return { fileName: names[index] ?? "", format, data };
    });
  }

  // PNG: 大きさをすべて確かめてから描く
  const sizes = plan.targets.map((target) => {
    const size = pngSize(target.bounds, scale);
    if (!size.ok) throw new ExportError(size.reason);
    return size;
  });
  const render = options.render ?? renderPng;
  const files: ExportFile[] = [];
  for (const [index, target] of plan.targets.entries()) {
    const size = sizes[index];
    if (!size) continue;
    // 画像としての大きさを書き出す大きさにそろえる (倍率は整数なので範囲の整数 × 倍率と一致する)
    const svg = buildExportSvg(doc, target, { measurer, scale });
    // 中間の SVG はファイルにしないので大きさは見ない (上限は PNG の大きさで確かめる)
    const problem = checkExportSvg(svg, null);
    if (problem) throw new ExportError(problem);
    const data = await render(svg, size.width, size.height);
    files.push({ fileName: names[index] ?? "", format, data });
  }
  return files;
}

/** ファイルを作り、登録された関数で書き込む。 */
export async function runExport(
  doc: CanvasDocument,
  plan: ExportPlan,
  writer: ExportWriter,
  options: BuildFilesOptions,
): Promise<ExportWriteResult & { total: number }> {
  const files = await buildExportFiles(doc, plan, options);
  const result = await writer(files);
  return { written: result.written, total: files.length };
}
