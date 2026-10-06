import type { EncodingInspection, NewlineMode, NewlineStats, TargetEncoding } from "@/ipc/encoding";
import { textEncodingLabels } from "@/lib/textEncoding";

export { confidenceLabels, sourceOptions, textEncodingLabels } from "@/lib/textEncoding";

export const targetOptions: { value: TargetEncoding; label: string }[] = [
  { value: "utf8", label: "UTF-8" },
  { value: "utf8_bom", label: "UTF-8 (BOM 付き)" },
  { value: "shift_jis", label: textEncodingLabels.shift_jis },
  { value: "euc_jp", label: textEncodingLabels.euc_jp },
];

export const newlineOptions: { value: NewlineMode; label: string }[] = [
  { value: "keep", label: "そのまま" },
  { value: "lf", label: "LF" },
  { value: "crlf", label: "CRLF" },
];

const targetSuffixes: Record<TargetEncoding, string> = {
  utf8: "utf8",
  utf8_bom: "utf8bom",
  shift_jis: "sjis",
  euc_jp: "eucjp",
};

/** 別名で保存するときの既定のパス: 入力と同じフォルダの `<名前>-<変換先>.<拡張子>` */
export function defaultOutputPath(inputPath: string, target: TargetEncoding): string {
  const cut = Math.max(inputPath.lastIndexOf("/"), inputPath.lastIndexOf("\\")) + 1;
  const directory = inputPath.slice(0, cut);
  const name = inputPath.slice(cut);
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${directory}${stem}-${targetSuffixes[target]}${extension}`;
}

/** 改行の内訳を「CRLF」「LF」「混在」「なし」で表す。 */
export function newlineSummary(stats: NewlineStats): string {
  const kinds = (["crlf", "lf", "cr"] as const).filter((kind) => stats[kind] > 0);
  if (kinds.length === 0) return "なし";
  if (kinds.length > 1) return "混在";
  return kinds[0]!.toUpperCase();
}

/**
 * 変換しても元と同じバイト列になる組み合わせなら、その理由を返す。
 * 文字コードと BOM が同じで、改行も既に揃っていて、記号の置換もしない場合。
 */
export function noChangeReason(
  inspection: EncodingInspection,
  target: TargetEncoding,
  newline: NewlineMode,
  normalizeMacSymbols: boolean,
): string | null {
  const source = inspection.encoding;
  if (source == null || normalizeMacSymbols) return null;
  const hasBom = inspection.bom != null;
  const sameEncoding =
    (source === "utf8" && target === "utf8" && !hasBom) ||
    (source === "utf8" && target === "utf8_bom" && hasBom) ||
    (source === "shift_jis" && target === "shift_jis") ||
    (source === "euc_jp" && target === "euc_jp");
  const { crlf, lf, cr } = inspection.newlines;
  const sameNewline =
    newline === "keep" ||
    (newline === "lf" && crlf === 0 && cr === 0) ||
    (newline === "crlf" && lf === 0 && cr === 0);
  return sameEncoding && sameNewline
    ? "元のファイルと同じ文字コード・改行なので、変換しても内容は変わりません。"
    : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Mac で入力されやすく、Shift_JIS / EUC-JP に無い記号。表せない文字に含まれていれば置換を勧める。 */
const macSymbols = new Set(["〜", "‖", "—", "¢", "£", "¬", "−"]);

export function includesMacSymbol(chars: readonly string[]): boolean {
  return chars.some((char) => macSymbols.has(char));
}
