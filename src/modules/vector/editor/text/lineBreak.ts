/**
 * 改行してよい位置 (§4.7)。UAX #14 を日本語と欧文の文書向けに簡単にしたもの。
 *
 * - 和文 (漢字、かな、全角の記号、ハングル、絵文字) は文字の間で折り返せる
 * - 欧文は空白の後で折り返す。単語の中では折り返さない (ハイフンの後は折り返せる)
 * - 行頭に来てはいけない文字 (句読点、閉じ括弧、小書きのかな、長音記号など) の前では折り返さない
 * - 行末に来てはいけない文字 (開き括弧) の後では折り返さない
 * - 空白の前では折り返さない (空白は行末にぶら下がる)
 *
 * 編集欄 (`TextEditOverlay`) は CSS の `line-break: strict` で、ブラウザの行分割がこれに近くなるようにする。
 */
import { splitGraphemes } from "./graphemes";

/** 改行の判定に使う文字の種類。 */
type BreakClass =
  /** 空白。後ろで折り返せ、行末にぶら下がる */
  | "space"
  /** ゼロ幅スペース。後ろで折り返せる */
  | "zw"
  /** 前後とも折り返さない (ノーブレークスペース、単語結合子) */
  | "glue"
  /** 前で折り返さない (句読点、閉じ括弧など) */
  | "close"
  /** 前で折り返さず、後ろで折り返せる (`!` `?`。URL の `?` の後など) */
  | "exclamation"
  /** 後ろで折り返さない (開き括弧) */
  | "open"
  /** 和文の文字。前後で折り返せる */
  | "ideographic"
  /** ハイフン。後ろで折り返せる (数字の前を除く) */
  | "hyphen"
  /** ダッシュ (U+2014)。前後で折り返せる (続くダッシュの間を除く) */
  | "dash"
  /** そのほか (欧文の文字、数字)。同じ種類の間では折り返さない */
  | "alpha";

function charSet(chars: string): ReadonlySet<number> {
  const set = new Set<number>();
  for (const ch of chars) set.add(ch.codePointAt(0) ?? 0);
  return set;
}

/** 行頭禁則。句読点、閉じ括弧、小書きのかな、長音記号、繰り返し記号、中黒など。 */
const NO_BREAK_BEFORE = charSet(
  "!),.:;?]}¢°’”‰′″‼⁇⁈⁉…‥" +
    "、。〉》」』】〕〗〙〛〟〜゠・゛゜ゝゞヽヾ々〻ー" +
    "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ" +
    "！），．：；？］｝｠｡｣､･ｧｨｩｪｫｬｭｮｯｰ％",
);

/** 感嘆符と疑問符。前では折り返さず、後ろでは欧文の前でも折り返せる (UAX #14 の EX)。 */
const EXCLAMATION = charSet("!?\uff01\uff1f");

/** 行末禁則。開き括弧。 */
const NO_BREAK_AFTER = charSet("([{‘“«〈《「『【〔〖〘〚〝（［｛｟｢");

/** 前後とも折り返さない文字 (ノーブレークスペース、単語結合子、ノーブレークハイフン)。 */
const GLUE = charSet("\u00a0\u2007\u2011\u202f\u2060\ufeff");

/** 空白として扱う文字。CSS の `white-space: pre-wrap` と同じく行末にぶら下がる。 */
const SPACE = charSet(
  "\t\u0020\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2008\u2009\u200a\u205f\u3000",
);

const HYPHEN = charSet("-\u2010\u2013");

function isIdeographic(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // ハングルの字母
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK の部首、記号、かな、漢字
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) || // ハングル
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 互換漢字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 互換形
    (cp >= 0xff00 && cp <= 0xffef) || // 全角・半角形
    (cp >= 0x2600 && cp <= 0x27bf) || // 記号と絵文字
    (cp >= 0x1f000 && cp <= 0x1faff) || // 絵文字
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 拡張 B 以降
  );
}

function classify(grapheme: string): BreakClass {
  const cp = grapheme.codePointAt(0) ?? 0;
  if (SPACE.has(cp)) return "space";
  if (cp === 0x200b) return "zw";
  if (GLUE.has(cp)) return "glue";
  if (EXCLAMATION.has(cp)) return "exclamation";
  if (NO_BREAK_BEFORE.has(cp)) return "close";
  if (NO_BREAK_AFTER.has(cp)) return "open";
  if (HYPHEN.has(cp)) return "hyphen";
  if (cp === 0x2014) return "dash";
  if (isIdeographic(cp)) return "ideographic";
  return "alpha";
}

/** 改行の判定に使う 1 文字分の情報。 */
interface BreakInfo {
  cls: BreakClass;
  /** 全角の文字 (和文の句読点・括弧を含む)。和文の文字と同じく、欧文との間で折り返せる */
  wide: boolean;
  digit: boolean;
}

function infoOf(grapheme: string): BreakInfo {
  const cp = grapheme.codePointAt(0) ?? 0;
  return { cls: classify(grapheme), wide: isIdeographic(cp), digit: cp >= 0x30 && cp <= 0x39 };
}

/** `before` と `after` の間で折り返せるか。 */
function canBreakBetween(before: BreakInfo, after: BreakInfo): boolean {
  const b = before.cls;
  const a = after.cls;
  if (a === "space") return false; // 空白の前では折り返さない (行末にぶら下げる)
  if (a === "close" || a === "exclamation" || b === "open") return false;
  if (b === "glue" || a === "glue") return false;
  if (b === "space" || b === "zw" || b === "exclamation") return true;
  if (a === "hyphen") return false;
  if (b === "hyphen") return !after.digit;
  if (b === "dash" || a === "dash") return !(b === "dash" && a === "dash");
  return before.wide || after.wide;
}

/**
 * 1 段落 (改行を含まない文字列) を、間で折り返してよい単位に分ける。
 * 単位の末尾の空白はその単位に含める (行末でぶら下がる)。単位をつなぐと元の文字列に戻る。
 */
export function breakUnits(paragraph: string): string[] {
  const graphemes = splitGraphemes(paragraph);
  const units: string[] = [];
  let current = "";
  let previous: BreakInfo | null = null;
  for (const grapheme of graphemes) {
    const info = infoOf(grapheme);
    if (previous !== null && canBreakBetween(previous, info)) {
      units.push(current);
      current = "";
    }
    current += grapheme;
    previous = info;
  }
  if (current !== "" || units.length === 0) units.push(current);
  return units;
}

/** 行末にぶら下げる空白 (`breakUnits` の空白と同じ集合) を落とす。 */
export function trimTrailingSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && SPACE.has(text.charCodeAt(end - 1))) end--;
  return end === text.length ? text : text.slice(0, end);
}
