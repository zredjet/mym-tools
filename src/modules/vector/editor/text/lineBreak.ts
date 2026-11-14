/**
 * 改行してよい位置 (§4.7)。UAX #14 を日本語と欧文の文書向けに簡単にしたもの。
 *
 * - 和文 (漢字、かな、全角の記号、ハングル、絵文字) は文字の間で折り返せる
 * - 欧文は空白の後で折り返す。単語の中では折り返さない (ハイフンの後は折り返せる)
 * - 行頭に来てはいけない文字 (句読点、閉じ括弧、小書きのかな、長音記号など) の前では折り返さない
 * - 行末に来てはいけない文字 (開き括弧、前置の通貨記号) の後では折り返さない
 * - 空白の前では折り返さない (空白は行末にぶら下がる)。空白の後は、続く文字が句読点でも折り返せる
 *
 * 編集欄 (`TextEditOverlay`) は CSS の `line-break: strict` で、ブラウザの行分割がこれに近くなるようにする。
 * エンジンで違う規則は `LineBreakOptions` で切り替える (計測がエンジンから求める)。
 */
import { splitGraphemes } from "./graphemes";

/** 改行の判定に使う文字の種類。 */
type BreakClass =
  /** 空白。後ろで折り返せ、行末にぶら下がる */
  | "space"
  /** ゼロ幅スペース。後ろで折り返せる */
  | "zw"
  /** 前後とも折り返さない (ノーブレークスペース、単語結合子、ASCII の引用符) */
  | "glue"
  /** 前で折り返さない (句読点、閉じ括弧など) */
  | "close"
  /** 前で折り返さず、後ろで折り返せる (`!` `?` `…`。URL の `?` の後など) */
  | "exclamation"
  /** 後ろで折り返さない (開き括弧、全角の通貨記号) */
  | "open"
  /** 前置の記号 (`\` `$` `+` `¥` `€` など)。後ろで折り返さない。前は `prefixBreak` で決める */
  | "prefix"
  /** `/`。前で折り返さない。後ろは `solidusBreak` で決める */
  | "solidus"
  /** 和文の文字。前後で折り返せる */
  | "ideographic"
  /** ハイフン。後ろで折り返せる (`-` は数字の前を除く) */
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
  "!),.:;?]}¢°’”‰′″‼⁇⁈⁉" +
    "、。〉》」』】〕〗〙〛〟〜゠・゛゜ゝゞヽヾ々〻ー" +
    "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ" +
    "！），．：；？］｝｠｡｣､･ｧｨｩｪｫｬｭｮｯｰ％",
);

/**
 * 感嘆符・疑問符と三点リーダ。前では折り返さず、後ろでは欧文の前でも折り返せる
 * (UAX #14 の EX と IN。`……――` や `…abc` の間で折り返す)。
 */
const EXCLAMATION = charSet("!?\uff01\uff1f\u2026\u2025");

/** 行末禁則。開き括弧と全角の通貨記号 (`￥1,000` の間で折り返さない)。 */
const NO_BREAK_AFTER = charSet("([{‘“«〈《「『【〔〖〘〚〝（［｛｟｢\uffe5\uff04\uffe1");

/** 前後とも折り返さない文字 (ノーブレークスペース、単語結合子、ノーブレークハイフン、ASCII の引用符)。 */
const GLUE = charSet("\u00a0\u2007\u2011\u202f\u2060\ufeff\"'");

/** 空白として扱う文字。CSS の `white-space: pre-wrap` と同じく行末にぶら下がる。 */
const SPACE = charSet(
  "\t\u0020\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2008\u2009\u200a\u205f\u3000",
);

const IDEOGRAPHIC_SPACE = 0x3000;

const HYPHEN = charSet("-\u2010\u2013");

/** 前置の記号 (UAX #14 の PR のうち半角のもの)。 */
const PREFIX = charSet("\\$+\u00a3\u00a5\u20a9\u20ac");

/** 前置の記号の前で折り返せる、区切りの記号 (UAX #14 の IS)。 */
const INFIX = charSet(",.:;");

/** 閉じの引用符。欧文の後ろにあるときは、続く和文との間で折り返さない (`‘a’は`)。 */
const CLOSE_QUOTE = charSet("\u2019\u201d");

/**
 * 小書きのかなと長音記号 (UAX #14 の CJ)。`line-break: strict` では前で折り返さないが、
 * WebKit の HTML は組むとき (`shapingUnits`) にはこの前でも区切る。
 */
const CONDITIONAL_JAPANESE = charSet(
  "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿーｧｨｩｪｫｬｭｮｯｰ",
);

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

/** エンジンによって違う折り返しの規則。編集欄 (`<textarea>`) と行分割をそろえるため、計測がエンジンから求める。 */
export interface LineBreakOptions {
  /**
   * `/` の後で欧文の前でも折り返すか (WebKit。URL やパスを `/` の後で折る)。数字の前は、`/` の前も
   * 数字のとき (`1/2`) だけ折り返さない。Chromium は和文の前だけで折り返す
   */
  breakAfterSolidus?: boolean;
  /**
   * HTML が文字列を折り返せる単位ごとに組み、単位をまたぐカーニングを入れないか (WebKit)。
   * そのときは、折り返すかどうかを単位ごとの幅の和で判定する (編集欄の `<textarea>` と同じ)。
   * Chromium は行全体を組むので、行全体の幅で判定する
   */
  shapePerUnit?: boolean;
  /**
   * 全角空白 (U+3000) を行末にぶら下げず、幅に数えるか (WebKit)。そのときは前で折り返さず、後ろで折り返す。
   * Chromium はほかの空白と同じくぶら下げる
   */
  keepIdeographicSpace?: boolean;
  /** `-` の後で数字の前でも折り返すか (Chromium。`1-|2`。`-` が単語の先頭のとき (`-1`) を除く) */
  breakHyphenBeforeDigit?: boolean;
  /**
   * 半角の前置の記号 (`\` `$` `+`) の前で、`:` `,` `.` `;` と前置の記号の後から折り返すか
   * (WebKit。Windows のパスの `C:|\Users`)。`¥` `€` などは、どのエンジンでも `:` などの後から折り返す
   */
  breakBeforeAsciiPrefix?: boolean;
}

function classify(cp: number, options: LineBreakOptions, shaping: boolean): BreakClass {
  if (cp === 0x2f) return "solidus";
  if (cp === IDEOGRAPHIC_SPACE && options.keepIdeographicSpace === true) return "exclamation";
  if (SPACE.has(cp)) return "space";
  if (cp === 0x200b) return "zw";
  if (GLUE.has(cp)) return "glue";
  if (EXCLAMATION.has(cp)) return "exclamation";
  if (shaping && CONDITIONAL_JAPANESE.has(cp)) return "ideographic";
  if (NO_BREAK_BEFORE.has(cp)) return "close";
  if (NO_BREAK_AFTER.has(cp)) return "open";
  if (PREFIX.has(cp)) return "prefix";
  if (HYPHEN.has(cp)) return "hyphen";
  if (cp === 0x2014) return "dash";
  if (isIdeographic(cp)) return "ideographic";
  return "alpha";
}

/** 改行の判定に使う 1 文字分の情報。 */
interface BreakInfo {
  cp: number;
  cls: BreakClass;
  /** 全角の文字 (和文の句読点・括弧を含む)。和文の文字と同じく、欧文との間で折り返せる */
  wide: boolean;
  digit: boolean;
}

function infoOf(grapheme: string, options: LineBreakOptions, shaping: boolean): BreakInfo {
  const cp = grapheme.codePointAt(0) ?? 0;
  return {
    cp,
    cls: classify(cp, options, shaping),
    wide: isIdeographic(cp),
    digit: cp >= 0x30 && cp <= 0x39,
  };
}

/** `/` の後で折り返せるか。 */
function solidusBreak(earlier: BreakInfo | null, after: BreakInfo, options: LineBreakOptions) {
  if (after.wide) return true;
  if (options.breakAfterSolidus !== true) return false;
  // 数字にはさまれた `/` (`1/2`) は数の一部として折り返さない
  return !(after.digit && earlier !== null && earlier.digit);
}

/** ハイフンの後で折り返せるか。 */
function hyphenBreak(
  earlier: BreakInfo | null,
  before: BreakInfo,
  after: BreakInfo,
  options: LineBreakOptions,
): boolean {
  if (!after.digit || before.cp !== 0x2d) return true;
  // `-` の後の数字 (`1-2`): Chromium は単語の途中なら折り返す。`-1` は負の数として折り返さない
  return (
    options.breakHyphenBeforeDigit === true &&
    earlier !== null &&
    earlier.cls !== "space" &&
    earlier.cls !== "zw" &&
    earlier.cls !== "open"
  );
}

/** `earlier` `before` と続いた後の、`before` と `after` の間で折り返せるか。 */
function canBreakBetween(
  earlier: BreakInfo | null,
  before: BreakInfo,
  after: BreakInfo,
  options: LineBreakOptions,
): boolean {
  const b = before.cls;
  const a = after.cls;
  if (a === "space") return false; // 空白の前では折り返さない (行末にぶら下げる)
  if (b === "space") return true; // 空白の後は句読点の前でも折り返す (どちらのエンジンも同じ)
  if (a === "prefix") {
    if (INFIX.has(before.cp)) return options.breakBeforeAsciiPrefix === true || after.cp > 0x7f;
    if (b === "prefix") return options.breakBeforeAsciiPrefix === true;
  }
  if (a === "close" || a === "exclamation" || a === "solidus" || b === "open" || b === "prefix")
    return false;
  if (b === "glue" || a === "glue") return false;
  if (b === "zw" || b === "exclamation") return true;
  if (b === "solidus") return solidusBreak(earlier, after, options);
  if (a === "hyphen") return false;
  if (b === "hyphen") return hyphenBreak(earlier, before, after, options);
  if (b === "dash" || a === "dash") return !(b === "dash" && a === "dash");
  // 欧文の後ろの閉じの引用符と、続く和文の間 (`‘a’は`) では折り返さない
  if (CLOSE_QUOTE.has(before.cp) && earlier !== null && !earlier.wide) return false;
  return before.wide || after.wide;
}

function splitUnits(paragraph: string, options: LineBreakOptions, shaping: boolean): string[] {
  const graphemes = splitGraphemes(paragraph);
  const units: string[] = [];
  let current = "";
  let earlier: BreakInfo | null = null;
  let previous: BreakInfo | null = null;
  for (const grapheme of graphemes) {
    const info = infoOf(grapheme, options, shaping);
    if (previous !== null && canBreakBetween(earlier, previous, info, options)) {
      units.push(current);
      current = "";
    }
    current += grapheme;
    earlier = previous;
    previous = info;
  }
  if (current !== "" || units.length === 0) units.push(current);
  return units;
}

/**
 * 1 段落 (改行を含まない文字列) を、間で折り返してよい単位に分ける。
 * 単位の末尾の空白はその単位に含める (行末でぶら下がる)。単位をつなぐと元の文字列に戻る。
 */
export function breakUnits(paragraph: string, options: LineBreakOptions = {}): string[] {
  return splitUnits(paragraph, options, false);
}

/**
 * WebKit の HTML が文字列を組む単位 (`shapePerUnit`)。`breakUnits` の区切りに加えて、小書きのかなと
 * 長音記号の前でも区切る (この間のカーニングを HTML は入れない)。単位をつなぐと元の文字列に戻る。
 */
export function shapingUnits(text: string, options: LineBreakOptions = {}): string[] {
  return splitUnits(text, options, true);
}

const LINE_END_CLOSE = charSet("」』）】〕〉》］｝〙〗〛〟｠");
const LINE_END_DOT = charSet("、。，．");

/**
 * 行末で詰めることがある約物か (全角の閉じ括弧、全角の読点・句点、閉じの引用符)。実際に詰めるかと
 * 詰める幅は、エンジンとフォントと前の文字で決まる (`MetricsTextMeasurer.lineEndTrim`)。
 */
export function mayTrimAtLineEnd(code: number): boolean {
  return LINE_END_CLOSE.has(code) || LINE_END_DOT.has(code) || CLOSE_QUOTE.has(code);
}

/** 行末にぶら下げる空白 (`breakUnits` の空白と同じ集合) を落とす。 */
export function trimTrailingSpaces(text: string, options: LineBreakOptions = {}): string {
  const keepIdeographic = options.keepIdeographicSpace === true;
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (!SPACE.has(code) || (keepIdeographic && code === IDEOGRAPHIC_SPACE)) break;
    end--;
  }
  return end === text.length ? text : text.slice(0, end);
}
