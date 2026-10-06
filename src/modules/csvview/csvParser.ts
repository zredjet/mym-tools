/** RFC 4180 の CSV / TSV パーサー。引用符、`""`、引用符の中の改行、CRLF / LF / CR を扱う。 */

export type Delimiter = "," | "\t" | ";";

export interface CsvWarning {
  /** 1 始まりのレコード番号 (空行は数えない) */
  record: number;
  /** レコードが始まる行 (1 始まり) */
  line: number;
  message: string;
}

export interface ParseResult {
  rows: string[][];
  /** 先頭 20 件 */
  warnings: CsvWarning[];
  warningCount: number;
  /** 最も多い列の数 */
  columnCount: number;
}

export class CsvParseError extends Error {
  constructor(readonly line: number) {
    super(`${line} 行目で始まる引用符が閉じられていません。`);
    this.name = "CsvParseError";
  }
}

const MAX_WARNINGS = 20;
const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;

class Warnings {
  list: CsvWarning[] = [];
  count = 0;

  add(record: number, line: number, message: string) {
    this.count += 1;
    if (this.list.length < MAX_WARNINGS) this.list.push({ record, line, message });
  }
}

/**
 * `input` を `delimiter` で区切ってレコードの配列にする。空行は飛ばす。
 * 引用符で囲まれていない欄の途中の `"` と、閉じ引用符の後ろの文字は、そのまま値に含めて警告する。
 * ファイルの終わりまで閉じない引用符はエラーにする。
 */
export function parseCsv(input: string, delimiter: Delimiter): ParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const separator = delimiter.charCodeAt(0);
  const length = text.length;
  const rows: string[][] = [];
  const warnings = new Warnings();
  let index = 0;
  let line = 1;
  let row: string[] = [];
  let rowLine = 1;
  let rowQuoted = false;
  // finishRow から書き換えるので、ローカル変数ではなくオブジェクトに持つ
  const shape = {
    columnCount: 0,
    firstWidth: null as number | null,
    raggedCount: 0,
    firstRagged: null as { record: number; line: number } | null,
  };

  const isBreak = (code: number) => code === separator || code === CR || code === LF;

  const finishRow = () => {
    // 引用符の無い空の欄 1 つだけのレコードは空行として飛ばす
    if (!(row.length === 1 && row[0] === "" && !rowQuoted)) {
      rows.push(row);
      shape.columnCount = Math.max(shape.columnCount, row.length);
      if (shape.firstWidth == null) shape.firstWidth = row.length;
      else if (row.length !== shape.firstWidth) {
        shape.raggedCount += 1;
        shape.firstRagged ??= { record: rows.length, line: rowLine };
      }
    }
    row = [];
    rowQuoted = false;
    rowLine = line;
  };

  while (index < length) {
    let field: string;
    const record = rows.length + 1;
    if (text.charCodeAt(index) === QUOTE) {
      rowQuoted = true;
      const startLine = line;
      let value = "";
      let start = index + 1;
      index = start;
      for (;;) {
        if (index >= length) throw new CsvParseError(startLine);
        const code = text.charCodeAt(index);
        if (code === QUOTE) {
          if (text.charCodeAt(index + 1) === QUOTE) {
            value += text.slice(start, index + 1);
            index += 2;
            start = index;
            continue;
          }
          value += text.slice(start, index);
          index += 1;
          break;
        }
        if (code === LF || (code === CR && text.charCodeAt(index + 1) !== LF)) line += 1;
        index += 1;
      }
      const tail = index;
      while (index < length && !isBreak(text.charCodeAt(index))) index += 1;
      if (index > tail) {
        warnings.add(record, rowLine, "閉じ引用符の後ろに文字があります。そのまま値に含めました");
        value += text.slice(tail, index);
      }
      field = value;
    } else {
      const start = index;
      let strayQuote = false;
      while (index < length) {
        const code = text.charCodeAt(index);
        if (isBreak(code)) break;
        if (code === QUOTE) strayQuote = true;
        index += 1;
      }
      field = text.slice(start, index);
      if (strayQuote) {
        warnings.add(
          record,
          rowLine,
          '引用符で囲まれていない欄に " があります。そのまま値に含めました',
        );
      }
    }
    row.push(field);

    if (index >= length) break;
    const code = text.charCodeAt(index);
    if (code === separator) {
      index += 1;
      // 区切り文字で終わるレコードの最後は空の欄
      if (index >= length || text.charCodeAt(index) === CR || text.charCodeAt(index) === LF) {
        row.push("");
      }
      if (index >= length) break;
      if (text.charCodeAt(index) !== CR && text.charCodeAt(index) !== LF) continue;
    }
    // 改行
    const breakCode = text.charCodeAt(index);
    index += breakCode === CR && text.charCodeAt(index + 1) === LF ? 2 : 1;
    line += 1;
    finishRow();
  }
  if (row.length > 0) finishRow();

  if (shape.firstRagged != null) {
    warnings.add(
      shape.firstRagged.record,
      shape.firstRagged.line,
      `列の数が 1 件目と違うレコードが ${shape.raggedCount.toLocaleString()} 件あります (最初はこのレコード)。足りない欄は空として扱います`,
    );
  }
  return {
    rows,
    warnings: warnings.list,
    warningCount: warnings.count,
    columnCount: shape.columnCount,
  };
}

/**
 * 先頭 50 レコードを引用符を考慮して数え、区切り文字を推定する。
 * 各レコードの区切り文字の数が 1 件目と同じで 1 以上のレコードが最も多い候補を選ぶ。
 */
export function detectDelimiter(text: string): Delimiter {
  const candidates: Delimiter[] = [",", "\t", ";"];
  let best: { delimiter: Delimiter; score: number } = { delimiter: ",", score: 0 };
  for (const delimiter of candidates) {
    const counts = countDelimiters(text, delimiter.charCodeAt(0), 50);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((count) => count === first).length;
    const score = consistent * 1000 + first;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function countDelimiters(text: string, separator: number, maxRecords: number): number[] {
  const counts: number[] = [];
  let count = 0;
  let inQuotes = false;
  let hasContent = false;
  for (let index = 0; index < text.length && counts.length < maxRecords; index += 1) {
    const code = text.charCodeAt(index);
    if (inQuotes) {
      if (code === QUOTE) {
        if (text.charCodeAt(index + 1) === QUOTE) index += 1;
        else inQuotes = false;
      }
      continue;
    }
    if (code === QUOTE) {
      inQuotes = true;
      hasContent = true;
    } else if (code === separator) {
      count += 1;
      hasContent = true;
    } else if (code === CR || code === LF) {
      if (code === CR && text.charCodeAt(index + 1) === LF) index += 1;
      if (hasContent) counts.push(count);
      count = 0;
      hasContent = false;
    } else {
      hasContent = true;
    }
  }
  if (hasContent && counts.length < maxRecords) counts.push(count);
  return counts;
}

export const delimiterLabels: Record<Delimiter, string> = {
  ",": "カンマ",
  "\t": "タブ",
  ";": "セミコロン",
};
