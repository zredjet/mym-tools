export const MAX_INPUT_LENGTH = 1024 * 1024;

export interface ReplaceRule {
  find: string;
  replace: string;
}

export type TabMode = "keep" | "delete" | "spaces";
export type TabScope = "all" | "leading";
export type BlankLineMode = "keep" | "delete" | "collapse";

export interface TextCleanOptions {
  rules: readonly ReplaceRule[];
  caseSensitive: boolean;
  /** 検索・置換文字列の `\t` `\n` `\\` を文字として解釈する。 */
  interpretEscapes: boolean;
  tabMode: TabMode;
  /** tabMode が spaces のとき、1 タブを何個のスペースにするか。タブ位置には揃えない。 */
  tabWidth: number;
  /** leading は行頭の空白が続く部分にあるタブだけを対象にする。 */
  tabScope: TabScope;
  trimTrailing: boolean;
  blankLines: BlankLineMode;
  /** 空白だけの行も空行とみなす。 */
  whitespaceLinesAreBlank: boolean;
}

export interface TextCleanResult {
  output: string;
  replacements: number;
  tabs: number;
  trimmedLines: number;
  removedBlankLines: number;
}

export const defaultTextCleanOptions: TextCleanOptions = {
  rules: [],
  caseSensitive: true,
  interpretEscapes: false,
  tabMode: "keep",
  tabWidth: 4,
  tabScope: "all",
  trimTrailing: false,
  blankLines: "keep",
  whitespaceLinesAreBlank: true,
};

// 空白は JavaScript の \s から改行を除いたもの (全角スペースと NBSP を含む)。
const leadingWhitespace = /^[^\S\r\n]*/u;
const trailingWhitespace = /[^\S\r\n]+$/u;
const whitespaceOnly = /^[^\S\r\n]*$/u;

/** `\t` `\n` `\\` だけを文字にする。それ以外の `\x` はそのまま残す。 */
export function interpretEscapes(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const next = value[index + 1];
    if (char === "\\" && (next === "t" || next === "n" || next === "\\")) {
      result += next === "t" ? "\t" : next === "n" ? "\n" : "\\";
      index += 1;
    } else {
      result += char;
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyRule(
  text: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
): { text: string; count: number } {
  if (caseSensitive) {
    // split / join なら置換文字列の `$&` などを特別扱いしない。
    const parts = text.split(find);
    return { text: parts.join(replace), count: parts.length - 1 };
  }
  let count = 0;
  const replaced = text.replace(new RegExp(escapeRegExp(find), "giu"), () => {
    count += 1;
    return replace;
  });
  return { text: replaced, count };
}

function countTabs(value: string): number {
  return value.split("\t").length - 1;
}

export function cleanText(input: string, options: TextCleanOptions): TextCleanResult {
  if (input.length > MAX_INPUT_LENGTH) throw new Error("入力は1MiB以下にしてください");

  // 1. 置換ルール (上から順に適用する)
  let text = input;
  let replacements = 0;
  for (const rule of options.rules) {
    const find = options.interpretEscapes ? interpretEscapes(rule.find) : rule.find;
    if (find === "") continue;
    const replace = options.interpretEscapes ? interpretEscapes(rule.replace) : rule.replace;
    const result = applyRule(text, find, replace, options.caseSensitive);
    text = result.text;
    replacements += result.count;
  }

  // 置換で入った改行も含めて、ここから行単位で処理する。最後の改行は残す。
  const endsWithNewline = text.endsWith("\n");
  let lines = text === "" ? [] : text.split("\n");
  if (endsWithNewline) lines.pop();

  // 2. タブ
  let tabs = 0;
  if (options.tabMode !== "keep") {
    const replacement = options.tabMode === "spaces" ? " ".repeat(options.tabWidth) : "";
    lines = lines.map((line) => {
      if (options.tabScope === "all") {
        tabs += countTabs(line);
        return line.split("\t").join(replacement);
      }
      const indent = leadingWhitespace.exec(line)![0];
      tabs += countTabs(indent);
      return indent.split("\t").join(replacement) + line.slice(indent.length);
    });
  }

  // 3. 行末の空白
  let trimmedLines = 0;
  if (options.trimTrailing) {
    lines = lines.map((line) => {
      const trimmed = line.replace(trailingWhitespace, "");
      if (trimmed !== line) trimmedLines += 1;
      return trimmed;
    });
  }

  // 4. 空行
  let removedBlankLines = 0;
  if (options.blankLines !== "keep") {
    const isBlank = (line: string) =>
      options.whitespaceLinesAreBlank ? whitespaceOnly.test(line) : line === "";
    const kept: string[] = [];
    let previousBlank = false;
    for (const line of lines) {
      const blank = isBlank(line);
      if (blank && (options.blankLines === "delete" || previousBlank)) {
        removedBlankLines += 1;
      } else {
        kept.push(line);
      }
      previousBlank = blank;
    }
    lines = kept;
  }

  const output = lines.join("\n") + (endsWithNewline && lines.length > 0 ? "\n" : "");
  return { output, replacements, tabs, trimmedLines, removedBlankLines };
}
