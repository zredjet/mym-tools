/**
 * 書き出すファイル名の候補 (純関数、§4.9)。
 *
 * macOS と Windows の両方で使える名前にする。使えない文字は `_` に置き換え、
 * 空になれば既定の名前、同じ書き出しの中で重なれば ` (2)` のように番号を付ける。
 * 重なりは大文字と小文字を区別せずに比べる (どちらの OS も既定では区別しないため)。
 * 名前は NFC にそろえる (macOS は NFC の「が」と NFD の「か + 濁点」を同じファイルとして扱うため、
 * そろえずに比べると重なりを見落とす)。
 */
import type { ExportFormat } from "./types";

/** 名前が空のときの既定。 */
export const DEFAULT_EXPORT_FILE_NAME = "canvas";

/** 拡張子を除いた名前の上限 (コードポイント数)。パス全体の上限に余裕を残す */
export const MAX_FILE_STEM_LENGTH = 100;

/**
 * Windows で予約されている名前。最初のピリオドより前 (末尾の空白を除く) がこれに当たると、
 * 拡張子が付いていても使えない (`nul.tar`、`aux.v2`、`LPT1.backup`)。
 */
const RESERVED =
  /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

function isReserved(stem: string): boolean {
  const base = stem.split(".")[0] ?? "";
  return RESERVED.test(base.replace(/\s+$/, ""));
}

/**
 * ファイル名に使えない文字: `\ / : * ? " < > |` と制御文字 (U+0000〜U+001F、U+007F〜U+009F)。
 * 前後の空白とピリオドも Windows で問題になるので除く (先頭のピリオドは macOS で隠しファイルになる)。
 */
// 制御文字を探すための正規表現なので、制御文字を含めるのは意図どおり
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;

/** 名前を拡張子なしのファイル名にする。空になれば `fallback`。 */
export function sanitizeFileStem(name: string, fallback = DEFAULT_EXPORT_FILE_NAME): string {
  let stem = Array.from(name.normalize("NFC").replace(/\s+/g, " ").replace(INVALID_CHARS, "_"))
    // `Array.from` はコードポイントで区切るので、対になっていないサロゲートは 1 文字で残る。
    // OS のファイル名にできないので置き換える
    .map((char) => (char.length === 1 && /[\uD800-\uDFFF]/.test(char) ? "_" : char))
    .slice(0, MAX_FILE_STEM_LENGTH)
    .join("");
  stem = stem.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (stem === "") return fallback.normalize("NFC");
  if (isReserved(stem)) return `_${stem}`;
  return stem;
}

/** 重なりを比べる鍵。大文字と小文字を区別せず、NFC にそろえる。 */
function compareKey(stem: string): string {
  return stem.normalize("NFC").toLowerCase().normalize("NFC");
}

/**
 * 名前の一覧からファイル名 (拡張子付き、NFC) の一覧を作る。順番は変えない。
 * 重なった 2 つ目以降に ` (2)`、` (3)` … を付ける (付けた結果がほかの名前と重なれば次の番号にする)。
 */
export function uniqueFileNames(names: readonly string[], format: ExportFormat): string[] {
  const stems = names.map((name) => sanitizeFileStem(name));
  const taken = new Set(stems.map(compareKey));
  const used = new Set<string>();
  return stems.map((stem) => {
    let candidate = stem;
    if (used.has(compareKey(candidate))) {
      let n = 2;
      while (taken.has(compareKey(`${stem} (${n})`)) || used.has(compareKey(`${stem} (${n})`))) n++;
      candidate = `${stem} (${n})`;
    }
    used.add(compareKey(candidate));
    return `${candidate}.${format}`;
  });
}
