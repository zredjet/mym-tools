/** 文字コード変換と CSV ビューアで共通の、文字コードの表示名と選択肢 (ADR-0024)。 */
import type { Confidence, SourceEncoding, TextEncoding } from "@/ipc/encoding";

export const textEncodingLabels: Record<TextEncoding, string> = {
  utf8: "UTF-8",
  utf16_le: "UTF-16LE",
  utf16_be: "UTF-16BE",
  shift_jis: "Shift_JIS (CP932 相当)",
  euc_jp: "EUC-JP",
  iso2022_jp: "ISO-2022-JP",
};

export const sourceOptions: { value: SourceEncoding; label: string }[] = [
  { value: "auto", label: "自動判定" },
  { value: "utf8", label: textEncodingLabels.utf8 },
  { value: "shift_jis", label: textEncodingLabels.shift_jis },
  { value: "euc_jp", label: textEncodingLabels.euc_jp },
  { value: "iso2022_jp", label: textEncodingLabels.iso2022_jp },
  { value: "utf16_le", label: textEncodingLabels.utf16_le },
  { value: "utf16_be", label: textEncodingLabels.utf16_be },
];

export const confidenceLabels: Record<Confidence, string> = {
  bom: "BOM で確定",
  exact: "確定",
  guess: "推定",
  none: "判定できません",
};
