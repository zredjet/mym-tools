/// <reference lib="es2022.intl" />

import sjisTable from "./sjisTable.json";

export const MAX_INPUT_LENGTH = 1024 * 1024;
const MAX_UNENCODABLE_SAMPLES = 20;

export type CharKind =
  | "hiragana"
  | "katakana"
  | "kanji"
  | "latin"
  | "digit"
  | "space"
  | "newline"
  | "other";

export interface UnencodableChar {
  codePoint: number;
  char: string;
  count: number;
  invisible: boolean;
}

export interface CharCountResult {
  graphemes: number;
  codePoints: number;
  utf16Units: number;
  /** 空白・改行だけの書記素を除いた文字数。 */
  nonWhitespace: number;
  lines: number;
  /** 空の行と、空白だけの行。 */
  blankLines: number;
  bytes: { utf8: number; sjis: number; utf16: number };
  /** Shift_JIS で 1 バイトなら半角、2 バイトなら全角、表せなければその他。改行は数えない。 */
  width: { half: number; full: number; unencodable: number };
  kinds: Record<CharKind, number>;
  /** Shift_JIS で表せない文字。最初に現れた順で先頭 20 種類まで。 */
  unencodable: UnencodableChar[];
}

export interface CharCountOptions {
  /** バイト数を数えるとき、改行を CRLF (2 文字) として数える。 */
  crlf: boolean;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const whitespaceOnly = /^\s+$/u;
const blankLine = /^[^\S\r\n]*$/u;
const lineBreak = /\r\n|\r|\n/;
const invisible = /^[\p{Cc}\p{Cf}\p{Z}\p{M}]$/u;
const hiragana = /^[\p{Script=Hiragana}゛゜]$/u;
const katakana = /^[\p{Script=Katakana}ーｰﾞﾟ]$/u;
const kanji = /^[\p{Script=Han}々〆〇]$/u;
const digit = /^\p{Nd}$/u;
const latin = /^(?=\p{L})\p{Script=Latin}$/u;
const space = /^[^\S\r\n]$/u;

let doubleByteBitmap: Uint8Array | null = null;

function bitmap(): Uint8Array {
  if (doubleByteBitmap == null) {
    const binary = atob(sjisTable.doubleByteBitmap);
    doubleByteBitmap = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  return doubleByteBitmap;
}

/**
 * encoding_rs の Shift_JIS encoder で 1 文字が何バイトになるか。表せなければ 0。
 * 1 バイトの規則と 2 バイトの表は `src-tauri/src/modules/charcount/mod.rs` のテストで
 * encoding_rs と一致することを確かめている。
 */
export function sjisByteLength(codePoint: number): 0 | 1 | 2 {
  if (isSjisSingleByte(codePoint)) return 1;
  if (codePoint > 0xffff) return 0;
  return (bitmap()[codePoint >> 3]! >> (codePoint & 7)) & 1 ? 2 : 0;
}

export function isSjisSingleByte(codePoint: number): boolean {
  return (
    codePoint <= 0x80 ||
    codePoint === 0xa5 ||
    codePoint === 0x203e ||
    (codePoint >= 0xff61 && codePoint <= 0xff9f)
  );
}

/** 文字種の規則。かなの長音・濁点は かな、々〆〇 は漢字、中黒は記号・その他に入れる。 */
export function charKind(char: string): CharKind {
  if (char === "\n" || char === "\r") return "newline";
  if (space.test(char)) return "space";
  if (hiragana.test(char)) return "hiragana";
  if (katakana.test(char)) return "katakana";
  if (kanji.test(char)) return "kanji";
  if (digit.test(char)) return "digit";
  if (latin.test(char)) return "latin";
  return "other";
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** 空文字は 0 行。最後の改行の後ろが空なら行に数えない。 */
function countLines(text: string): { lines: number; blankLines: number } {
  if (text === "") return { lines: 0, blankLines: 0 };
  const segments = text.split(lineBreak);
  if (segments[segments.length - 1] === "") segments.pop();
  return {
    lines: segments.length,
    blankLines: segments.filter((line) => blankLine.test(line)).length,
  };
}

export function countText(text: string, options: CharCountOptions): CharCountResult {
  if (text.length > MAX_INPUT_LENGTH) throw new Error("入力は1MiB以下にしてください");

  let graphemes = 0;
  let nonWhitespace = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    graphemes += 1;
    if (!whitespaceOnly.test(segment)) nonWhitespace += 1;
  }

  const kinds: Record<CharKind, number> = {
    hiragana: 0,
    katakana: 0,
    kanji: 0,
    latin: 0,
    digit: 0,
    space: 0,
    newline: 0,
    other: 0,
  };
  const width = { half: 0, full: 0, unencodable: 0 };
  const bytes = { utf8: 0, sjis: 0, utf16: 0 };
  const unencodable = new Map<number, UnencodableChar>();
  let codePoints = 0;
  let lineBreaks = 0;
  let previous = "";

  for (const char of text) {
    codePoints += 1;
    const codePoint = char.codePointAt(0)!;
    kinds[charKind(char)] += 1;
    if (char === "\n" || char === "\r") {
      // CRLF は 1 つの改行として数える。
      if (!(char === "\n" && previous === "\r")) lineBreaks += 1;
      previous = char;
      continue;
    }
    previous = char;
    bytes.utf8 += utf8Length(codePoint);
    bytes.utf16 += char.length * 2;
    const sjis = sjisByteLength(codePoint);
    bytes.sjis += sjis;
    if (sjis === 1) width.half += 1;
    else if (sjis === 2) width.full += 1;
    else {
      width.unencodable += 1;
      const seen = unencodable.get(codePoint);
      if (seen) seen.count += 1;
      else if (unencodable.size < MAX_UNENCODABLE_SAMPLES) {
        unencodable.set(codePoint, { codePoint, char, count: 1, invisible: invisible.test(char) });
      }
    }
  }

  const newlineUnits = options.crlf ? 2 : 1;
  bytes.utf8 += lineBreaks * newlineUnits;
  bytes.sjis += lineBreaks * newlineUnits;
  bytes.utf16 += lineBreaks * newlineUnits * 2;

  return {
    graphemes,
    codePoints,
    utf16Units: text.length,
    nonWhitespace,
    ...countLines(text),
    bytes,
    width,
    kinds,
    unencodable: [...unencodable.values()],
  };
}

export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}
