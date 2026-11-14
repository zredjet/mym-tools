/**
 * 書き出しの型 (`docs/canvas-editor-design.md` §4.9)。
 *
 * ファイルへの書き込みは、`writer.ts` の登録口に渡された `ExportWriter` が行う。
 * 中身の形は Rust の `vector_write_file(path, format, data)` に合わせる
 * (SVG は文字列そのまま、PNG は `data:image/png;base64,` の data URL)。
 */
import type { Rect } from "../model/geometry";
import type { NodeId } from "../model/types";

export type ExportFormat = "svg" | "png";

/** PNG の倍率 (§4.9)。 */
export type ExportScale = 1 | 2 | 3;

export const EXPORT_SCALES: readonly ExportScale[] = [1, 2, 3];

/** 書き出すファイル 1 つ。 */
export interface ExportFile {
  /** ファイル名の候補 (拡張子付き、ファイル名に使えない文字は置き換え済み、同じ書き出しの中で重ならない)。path を決めるのは `ExportWriter` */
  fileName: string;
  format: ExportFormat;
  /** SVG は XML の文字列、PNG は `data:image/png;base64,` の data URL */
  data: string;
}

export interface ExportWriteResult {
  /** 書き込んだファイルの数。利用者が保存ダイアログを取り消したら、それまでに書いた数 (0 もありうる) */
  written: number;
}

/**
 * ファイルを書き込む関数。1 回の書き出しのファイルをまとめて受け取る
 * (1 つずつ保存ダイアログを出すか、フォルダを選ぶかは、この関数が決める)。
 * 書き込みに失敗したら reject する。
 */
export type ExportWriter = (files: readonly ExportFile[]) => Promise<ExportWriteResult>;

/** 書き出す範囲の種類。 */
export type ExportKind =
  /** 選択がすべて frame。frame ごとに 1 ファイル */
  | "frames"
  /** frame でないノードを含む選択。選択全体を 1 ファイル */
  | "selection"
  /** 選択なし。ページのすべてのノードを 1 ファイル */
  | "page";

/** ファイル 1 つ分の対象。 */
export interface ExportTarget {
  /** 描くノード (重なり順、背面が先)。祖先が選ばれているノードは含まない */
  nodeIds: readonly NodeId[];
  /** 書き出す範囲 (ページ座標)。位置は切り下げ、右端と下端は切り上げた整数 */
  bounds: Rect;
  /** ファイル名のもとにする名前 (置き換えの前) */
  name: string;
}

export type ExportPlan =
  | { ok: true; kind: ExportKind; targets: readonly ExportTarget[] }
  | { ok: false; kind: ExportKind; reason: string };
