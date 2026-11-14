/**
 * 書記素クラスタ (利用者が 1 文字と感じる単位) への分割 (§4.7)。
 * 行分割と字間の計算が、サロゲートペア・結合文字・絵文字の並びを途中で割らないために使う。
 *
 * `Intl.Segmenter` は tsconfig の lib (ES2020) にも古い WebView にもない環境があるので使わず、
 * UAX #29 の規則のうち日本語と欧文の文書で出会うものだけを自前で扱う:
 * - 結合文字 (一般カテゴリ M。濁点の U+3099 / U+309A、異体字セレクタ、囲みのキーキャップを含む)
 * - ゼロ幅接合子 (U+200D) とその次の文字 (家族の絵文字などの並び)
 * - 肌の色の修飾 (U+1F3FB〜U+1F3FF)、タグ文字 (U+E0020〜U+E007F。地域の旗)
 * - 地域指示記号 (U+1F1E6〜U+1F1FF) の 2 つ組 (国旗)
 * - 半角カナの濁点・半濁点 (U+FF9E / U+FF9F)
 * - ハングルの字母の並び、CR LF
 * 改行などの制御文字の前後では必ず分ける。
 */

/** 一般カテゴリ M (結合文字)。Unicode プロパティのエスケープは Safari 11.1 から使える。 */
const MARK = /\p{M}/u;

function isControl(cp: number): boolean {
  return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0x2028 || cp === 0x2029;
}

/** 直前の文字にくっつく文字か (結合文字、ZWJ、修飾、タグ)。 */
function isExtend(cp: number, ch: string): boolean {
  if (cp < 0x300) return false; // ASCII とラテン 1 は結合しない (速い道)
  if (cp === 0x200d || cp === 0xff9e || cp === 0xff9f) return true;
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true;
  if (cp >= 0xe0020 && cp <= 0xe007f) return true;
  return MARK.test(ch);
}

const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const isHangulLeading = (cp: number) => cp >= 0x1100 && cp <= 0x115f;
const isHangulJamo = (cp: number) => cp >= 0x1100 && cp <= 0x11ff;
const isHangulVowelOrTrailing = (cp: number) => cp >= 0x1160 && cp <= 0x11ff;
const isHangulSyllable = (cp: number) => cp >= 0xac00 && cp <= 0xd7a3;

interface ClusterState {
  /** 直前の文字 */
  prev: number;
  /** 今のクラスタに入っている地域指示記号の数 */
  regional: number;
}

/** 直前のクラスタに `cp` をつなげるか。 */
function joins(state: ClusterState, cp: number, ch: string): boolean {
  const { prev } = state;
  if (prev === 0x0d && cp === 0x0a) return true;
  if (isControl(prev) || isControl(cp)) return false;
  if (isExtend(cp, ch)) return true;
  if (prev === 0x200d) return true; // ZWJ の次 (絵文字の並び)
  if (isRegionalIndicator(cp)) return isRegionalIndicator(prev) && state.regional % 2 === 1;
  if (isHangulVowelOrTrailing(cp)) return isHangulJamo(prev) || isHangulSyllable(prev);
  if (isHangulLeading(cp)) return isHangulLeading(prev);
  return false;
}

/** 書記素クラスタごとに `visit` を呼ぶ。 */
export function forEachGrapheme(text: string, visit: (grapheme: string) => void): void {
  let current = "";
  const state: ClusterState = { prev: -1, regional: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (current !== "" && joins(state, cp, ch)) current += ch;
    else {
      if (current !== "") visit(current);
      current = ch;
      state.regional = 0;
    }
    if (isRegionalIndicator(cp)) state.regional++;
    state.prev = cp;
  }
  if (current !== "") visit(current);
}

/** 書記素クラスタの配列にする。 */
export function splitGraphemes(text: string): string[] {
  const out: string[] = [];
  forEachGrapheme(text, (grapheme) => out.push(grapheme));
  return out;
}

/** 書記素クラスタの数。字間はこの数だけ付く (CSS / SVG の `letter-spacing` と同じ単位)。 */
export function graphemeCount(text: string): number {
  // ASCII だけなら文字数そのもの (よくある場合を速く)
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80 || (code < 0x20 && code !== 0x09)) {
      ascii = false;
      break;
    }
  }
  if (ascii) return text.length;
  let count = 0;
  forEachGrapheme(text, () => count++);
  return count;
}
