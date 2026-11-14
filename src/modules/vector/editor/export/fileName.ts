/**
 * 書き出すファイル名の候補 (純関数、§4.9)。
 *
 * macOS と Windows の両方で使える名前にする。使えない文字は `_` に置き換え、
 * 空になれば既定の名前、同じ書き出しの中で重なれば ` (2)` のように番号を付ける。
 * 重なりは大文字と小文字を区別せずに比べる (どちらの OS も既定では区別しないため)。
 */
import type { ExportFormat } from "./types";

/** 名前が空のときの既定。 */
export const DEFAULT_EXPORT_FILE_NAME = "canvas";

/** 拡張子を除いた名前の上限 (コードポイント数)。パス全体の上限に余裕を残す */
export const MAX_FILE_STEM_LENGTH = 100;

/** Windows で予約されている名前 (拡張子が付いていても使えない)。 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * ファイル名に使えない文字: `\ / : * ? " < > |` と制御文字 (U+0000〜U+001F、U+007F〜U+009F)。
 * 前後の空白とピリオドも Windows で問題になるので除く (先頭のピリオドは macOS で隠しファイルになる)。
 */
// 制御文字を探すための正規表現なので、制御文字を含めるのは意図どおり
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;

/** 名前を拡張子なしのファイル名にする。空になれば `fallback`。 */
export function sanitizeFileStem(name: string, fallback = DEFAULT_EXPORT_FILE_NAME): string {
  let stem = Array.from(name.replace(/\s+/g, " ").replace(INVALID_CHARS, "_"))
    // `Array.from` はコードポイントで区切るので、対になっていないサロゲートは 1 文字で残る。
    // OS のファイル名にできないので置き換える
    .map((char) => (char.length === 1 && /[\uD800-\uDFFF]/.test(char) ? "_" : char))
    .slice(0, MAX_FILE_STEM_LENGTH)
    .join("");
  stem = stem.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (stem === "") return fallback;
  if (RESERVED.test(stem)) return `_${stem}`;
  return stem;
}

/**
 * 名前の一覧からファイル名 (拡張子付き) の一覧を作る。順番は変えない。
 * 重なった 2 つ目以降に ` (2)`、` (3)` … を付ける (付けた結果がほかの名前と重なれば次の番号にする)。
 */
export function uniqueFileNames(names: readonly string[], format: ExportFormat): string[] {
  const stems = names.map((name) => sanitizeFileStem(name));
  const taken = new Set(stems.map((stem) => stem.toLowerCase()));
  const used = new Set<string>();
  return stems.map((stem) => {
    let candidate = stem;
    if (used.has(candidate.toLowerCase())) {
      let n = 2;
      while (taken.has(`${stem} (${n})`.toLowerCase()) || used.has(`${stem} (${n})`.toLowerCase()))
        n++;
      candidate = `${stem} (${n})`;
    }
    used.add(candidate.toLowerCase());
    return `${candidate}.${format}`;
  });
}
