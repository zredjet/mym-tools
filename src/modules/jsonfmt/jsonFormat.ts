/**
 * JSON (RFC 8259) を検証して、空白と改行だけを組み替える。
 *
 * `JSON.parse` → `JSON.stringify` は使わない。往復させると、大きな整数の桁落ち、
 * `1.0` → `1`、`1e400` → `null`、重複したキーの消失が黙って起こるうえ、エラーの位置が
 * WebView (V8 / JavaScriptCore) ごとに違う形でしか取れないため。ここでは数値と文字列を
 * 元の書き方のまま持ち、位置を自分で数える。
 */

export const MAX_INPUT_LENGTH = 1024 * 1024;
export const MAX_OUTPUT_LENGTH = 8 * 1024 * 1024;
export const MAX_DEPTH = 512;
export const MAX_REPORTED_DUPLICATE_KEYS = 20;

export type JsonOutputMode = "pretty" | "minify";
export type JsonIndent = "2" | "4" | "tab";

export interface JsonFormatOptions {
  mode: JsonOutputMode;
  /** mode が pretty のときの 1 段のインデント。 */
  indent: JsonIndent;
  /** オブジェクトのキーを UTF-16 コード単位の昇順に並べ替える (配列の順序は変えない)。 */
  sortKeys: boolean;
}

export const defaultJsonFormatOptions: JsonFormatOptions = {
  mode: "pretty",
  indent: "2",
  sortKeys: false,
};

export interface JsonPosition {
  /** 入力の先頭からの UTF-16 コード単位の位置 (0 始まり)。 */
  offset: number;
  /** 1 始まり。 */
  line: number;
  /** 1 始まり、UTF-16 コード単位。 */
  column: number;
}

export interface JsonStats {
  objects: number;
  arrays: number;
  /** 文字列・数値・true / false / null の個数。 */
  values: number;
  /** オブジェクトと配列の入れ子の深さ。最上位が文字列や数値なら 0。 */
  maxDepth: number;
}

export interface JsonDuplicateKey {
  key: string;
  position: JsonPosition;
}

export interface JsonFormatResult {
  output: string;
  stats: JsonStats;
  /** 同じオブジェクトの中で 2 回目以降に現れたキー。先頭 MAX_REPORTED_DUPLICATE_KEYS 件。 */
  duplicateKeys: JsonDuplicateKey[];
  duplicateKeyCount: number;
  /** 入力の先頭にあった BOM (U+FEFF) を取り除いた。 */
  removedBom: boolean;
}

export class JsonSyntaxError extends Error {
  readonly position: JsonPosition;

  constructor(message: string, position: JsonPosition) {
    super(message);
    this.name = "JsonSyntaxError";
    this.position = position;
  }
}

type JsonNode =
  | { kind: "scalar"; raw: string }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "object"; members: JsonMember[] };

interface JsonMember {
  /** 引用符とエスケープを含む、入力に書かれていたままのキー。 */
  rawKey: string;
  /** エスケープを解いたキー。重複の判定と並べ替えに使う。 */
  key: string;
  value: JsonNode;
}

interface ParsedJson {
  root: JsonNode;
  stats: JsonStats;
  duplicateOffsets: { key: string; offset: number }[];
  duplicateKeyCount: number;
  removedBom: boolean;
}

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** offset の行と列を求める。改行は LF / CRLF / CR のどれも 1 つと数える。 */
export function positionAt(input: string, offset: number): JsonPosition {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    const code = input.charCodeAt(index);
    if (code === LF) {
      line += 1;
      lineStart = index + 1;
    } else if (code === CR) {
      if (index + 1 < offset && input.charCodeAt(index + 1) === LF) index += 1;
      line += 1;
      lineStart = index + 1;
    }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isWordChar(code: number): boolean {
  return (
    isDigit(code) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x24
  );
}

/** エラーメッセージに出す 1 文字。見えない文字はコードポイントで示す。 */
function describeChar(input: string, offset: number): string {
  const codePoint = input.codePointAt(offset)!;
  const isInvisible =
    codePoint <= SPACE ||
    (codePoint >= 0x7f && codePoint <= 0xa0) ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff ||
    (codePoint >= 0x2000 && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff);
  if (isInvisible) return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  return `「${String.fromCodePoint(codePoint)}」`;
}

function parseJson(input: string): ParsedJson {
  const removedBom = input.charCodeAt(0) === 0xfeff;
  let pos = removedBom ? 1 : 0;
  const stats: JsonStats = { objects: 0, arrays: 0, values: 0, maxDepth: 0 };
  const duplicateOffsets: { key: string; offset: number }[] = [];
  let duplicateKeyCount = 0;

  function fail(message: string, offset: number = pos): never {
    throw new JsonSyntaxError(message, positionAt(input, offset));
  }

  function skipWhitespace(): void {
    while (pos < input.length) {
      const code = input.charCodeAt(pos);
      if (code !== SPACE && code !== TAB && code !== LF && code !== CR) break;
      pos += 1;
    }
  }

  /** 開き引用符の位置から読み、引用符を含む元の書き方のまま返す。 */
  function scanString(): string {
    const start = pos;
    pos += 1;
    for (;;) {
      if (pos >= input.length) fail("文字列が閉じていません", start);
      const code = input.charCodeAt(pos);
      if (code === QUOTE) {
        pos += 1;
        return input.slice(start, pos);
      }
      if (code === LF || code === CR) {
        fail("文字列の途中で改行されています (改行は \\n と書きます)");
      }
      if (code < SPACE) {
        fail("文字列の中に制御文字はそのまま書けません (タブは \\t と書きます)");
      }
      if (code !== BACKSLASH) {
        pos += 1;
        continue;
      }
      if (pos + 1 >= input.length) fail("文字列が閉じていません", start);
      const escape = input[pos + 1]!;
      if ('"\\/bfnrt'.includes(escape)) {
        pos += 2;
      } else if (escape === "u") {
        for (let index = pos + 2; index < pos + 6; index += 1) {
          if (index >= input.length || !isHexDigit(input.charCodeAt(index))) {
            fail("\\u の後ろには 16 進数が 4 桁必要です");
          }
        }
        pos += 6;
      } else {
        fail(`使えないエスケープです: \\${escape}`);
      }
    }
  }

  function scanNumber(): string {
    const start = pos;
    if (input[pos] === "-") pos += 1;
    if (input[pos] === "0") {
      pos += 1;
      if (isDigit(input.charCodeAt(pos))) fail("数値の先頭に余分な 0 は付けられません", start);
    } else if (isDigit(input.charCodeAt(pos))) {
      while (isDigit(input.charCodeAt(pos))) pos += 1;
    } else {
      fail("- の後ろに数字がありません", start);
    }
    if (input[pos] === ".") {
      pos += 1;
      if (!isDigit(input.charCodeAt(pos))) fail("小数点の後ろに数字がありません");
      while (isDigit(input.charCodeAt(pos))) pos += 1;
    }
    if (input[pos] === "e" || input[pos] === "E") {
      pos += 1;
      if (input[pos] === "+" || input[pos] === "-") pos += 1;
      if (!isDigit(input.charCodeAt(pos))) fail("指数に数字がありません");
      while (isDigit(input.charCodeAt(pos))) pos += 1;
    }
    return input.slice(start, pos);
  }

  function scanLiteral(): string {
    for (const literal of ["true", "false", "null"]) {
      if (input.startsWith(literal, pos) && !isWordChar(input.charCodeAt(pos + literal.length))) {
        pos += literal.length;
        return literal;
      }
    }
    const char = input[pos]!;
    if (char === "'") fail('文字列は二重引用符 (") で囲んでください');
    if (char === "/") fail("コメントは JSON では使えません");
    if (char === "+" || char === ".") fail("数値は + や . で始められません");
    if (char === "," || char === "]" || char === "}" || char === ":") fail("値がありません");
    if (isWordChar(input.charCodeAt(pos))) {
      let end = pos;
      while (isWordChar(input.charCodeAt(end))) end += 1;
      fail(
        `「${input.slice(pos, end)}」は JSON の値ではありません (引用符のない値は true / false / null と数値だけです)`,
      );
    }
    return fail(`使えない文字です: ${describeChar(input, pos)}`);
  }

  function parseValue(depth: number): JsonNode {
    skipWhitespace();
    if (pos >= input.length) fail("JSON が途中で終わっています");
    const code = input.charCodeAt(pos);
    if (code === 0x7b) return parseObject(depth + 1);
    if (code === 0x5b) return parseArray(depth + 1);
    stats.values += 1;
    if (code === QUOTE) return { kind: "scalar", raw: scanString() };
    if (code === 0x2d || isDigit(code)) return { kind: "scalar", raw: scanNumber() };
    return { kind: "scalar", raw: scanLiteral() };
  }

  function enterContainer(depth: number): void {
    if (depth > MAX_DEPTH) fail(`入れ子が深すぎます (${MAX_DEPTH} 段まで)`);
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    pos += 1;
  }

  function parseArray(depth: number): JsonNode {
    enterContainer(depth);
    stats.arrays += 1;
    const items: JsonNode[] = [];
    skipWhitespace();
    if (input[pos] === "]") {
      pos += 1;
      return { kind: "array", items };
    }
    for (;;) {
      items.push(parseValue(depth));
      skipWhitespace();
      if (pos >= input.length) fail("JSON が途中で終わっています (配列が閉じていません)");
      const char = input[pos]!;
      if (char === "]") {
        pos += 1;
        return { kind: "array", items };
      }
      if (char !== ",") fail("「,」か「]」が必要です");
      const comma = pos;
      pos += 1;
      skipWhitespace();
      if (input[pos] === "]") fail("末尾のカンマは使えません", comma);
    }
  }

  function parseObject(depth: number): JsonNode {
    enterContainer(depth);
    stats.objects += 1;
    const members: JsonMember[] = [];
    const seen = new Set<string>();
    skipWhitespace();
    if (input[pos] === "}") {
      pos += 1;
      return { kind: "object", members };
    }
    for (;;) {
      skipWhitespace();
      if (pos >= input.length) fail("JSON が途中で終わっています (オブジェクトが閉じていません)");
      if (input.charCodeAt(pos) !== QUOTE) {
        if (input[pos] === "'" || isWordChar(input.charCodeAt(pos))) {
          fail('キーは二重引用符 (") で囲んでください');
        }
        fail("キー (二重引用符で囲んだ文字列) が必要です");
      }
      const keyOffset = pos;
      const rawKey = scanString();
      // scanString が JSON の文字列として正しいことを確かめているので、ここの parse は失敗しない。
      const key = rawKey.includes("\\") ? (JSON.parse(rawKey) as string) : rawKey.slice(1, -1);
      if (seen.has(key)) {
        duplicateKeyCount += 1;
        if (duplicateOffsets.length < MAX_REPORTED_DUPLICATE_KEYS) {
          duplicateOffsets.push({ key, offset: keyOffset });
        }
      } else {
        seen.add(key);
      }
      skipWhitespace();
      if (input[pos] !== ":") fail("キーの後ろに「:」が必要です");
      pos += 1;
      members.push({ rawKey, key, value: parseValue(depth) });
      skipWhitespace();
      if (pos >= input.length) fail("JSON が途中で終わっています (オブジェクトが閉じていません)");
      const char = input[pos]!;
      if (char === "}") {
        pos += 1;
        return { kind: "object", members };
      }
      if (char !== ",") fail("「,」か「}」が必要です");
      const comma = pos;
      pos += 1;
      skipWhitespace();
      if (input[pos] === "}") fail("末尾のカンマは使えません", comma);
    }
  }

  skipWhitespace();
  if (pos >= input.length) fail("JSON がありません");
  const root = parseValue(0);
  skipWhitespace();
  if (pos < input.length) {
    fail("値の後ろに余分な文字があります (JSON に書ける値は 1 つだけです)");
  }
  return { root, stats, duplicateOffsets, duplicateKeyCount, removedBom };
}

function compareMembers(left: JsonMember, right: JsonMember): number {
  if (left.key < right.key) return -1;
  return left.key > right.key ? 1 : 0;
}

function serialize(root: JsonNode, options: JsonFormatOptions): string {
  const pretty = options.mode === "pretty";
  const unit = options.indent === "tab" ? "\t" : " ".repeat(Number(options.indent));
  const lineBreaks = ["\n"];
  const parts: string[] = [];
  let length = 0;

  function push(part: string): void {
    length += part.length;
    if (length > MAX_OUTPUT_LENGTH) {
      throw new Error(
        "整形した結果が8MiBを超えます。インデントを小さくするか、圧縮を選んでください",
      );
    }
    parts.push(part);
  }

  /** 改行と、その段のインデント。 */
  function lineBreak(level: number): string {
    while (lineBreaks.length <= level) lineBreaks.push(lineBreaks[lineBreaks.length - 1]! + unit);
    return lineBreaks[level]!;
  }

  function write(node: JsonNode, level: number): void {
    if (node.kind === "scalar") {
      push(node.raw);
      return;
    }
    if (node.kind === "array") {
      if (node.items.length === 0) {
        push("[]");
        return;
      }
      push("[");
      node.items.forEach((item, index) => {
        if (index > 0) push(",");
        if (pretty) push(lineBreak(level + 1));
        write(item, level + 1);
      });
      if (pretty) push(lineBreak(level));
      push("]");
      return;
    }
    if (node.members.length === 0) {
      push("{}");
      return;
    }
    // Array.prototype.sort は安定なので、重複したキーは元の順序のまま並ぶ。
    const members = options.sortKeys ? [...node.members].sort(compareMembers) : node.members;
    push("{");
    members.forEach((member, index) => {
      if (index > 0) push(",");
      if (pretty) push(lineBreak(level + 1));
      push(member.rawKey);
      push(pretty ? ": " : ":");
      write(member.value, level + 1);
    });
    if (pretty) push(lineBreak(level));
    push("}");
  }

  write(root, 0);
  return parts.join("");
}

/**
 * JSON を検証し、整形または圧縮する。構文エラーは位置付きの `JsonSyntaxError` を投げる。
 * 数値と文字列は入力に書かれていたまま出力する (変わるのは空白・改行と、指定した時のキーの順序だけ)。
 */
export function formatJson(input: string, options: JsonFormatOptions): JsonFormatResult {
  if (input.length > MAX_INPUT_LENGTH) throw new Error("入力は1MiB以下にしてください");
  const parsed = parseJson(input);
  return {
    output: serialize(parsed.root, options),
    stats: parsed.stats,
    duplicateKeys: parsed.duplicateOffsets.map(({ key, offset }) => ({
      key,
      position: positionAt(input, offset),
    })),
    duplicateKeyCount: parsed.duplicateKeyCount,
    removedBom: parsed.removedBom,
  };
}
