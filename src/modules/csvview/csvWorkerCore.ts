import { convertRows, type OutputFormat } from "./csvConvert";
import { type CsvWarning, type Delimiter, detectDelimiter, parseCsv } from "./csvParser";

/** 表に出すのは見出しを含めて先頭 1,001 レコード、100 列、1 セル 200 文字まで。 */
export const MAX_PREVIEW_ROWS = 1001;
export const MAX_PREVIEW_COLUMNS = 100;
export const MAX_CELL_CHARS = 200;

export type DelimiterChoice = Delimiter | "auto";

export type CsvRequest =
  | { id: number; type: "parse"; text: string; delimiter: DelimiterChoice }
  | { id: number; type: "convert"; format: OutputFormat; header: boolean };

export interface ParseSummary {
  kind: "parse";
  delimiter: Delimiter;
  rowCount: number;
  columnCount: number;
  preview: string[][];
  /** プレビューで切り詰めたセルや列があるか */
  previewTrimmed: boolean;
  warnings: CsvWarning[];
  warningCount: number;
}

export interface ConvertSummary {
  kind: "convert";
  format: OutputFormat;
  text: string;
  warnings: string[];
}

export interface CsvResponse {
  id: number;
  result?: ParseSummary | ConvertSummary;
  error?: string;
}

/** Worker の中で解析済みの行を持ち続ける。行そのものはメインスレッドへ送らない。 */
export interface CsvSession {
  rows: string[][] | null;
}

export function createCsvSession(): CsvSession {
  return { rows: null };
}

export function handleCsvRequest(session: CsvSession, request: CsvRequest): CsvResponse {
  try {
    if (request.type === "parse") {
      session.rows = null;
      const delimiter =
        request.delimiter === "auto" ? detectDelimiter(request.text) : request.delimiter;
      const parsed = parseCsv(request.text, delimiter);
      session.rows = parsed.rows;
      let previewTrimmed = parsed.columnCount > MAX_PREVIEW_COLUMNS;
      const preview = parsed.rows.slice(0, MAX_PREVIEW_ROWS).map((row) =>
        row.slice(0, MAX_PREVIEW_COLUMNS).map((cell) => {
          if (cell.length <= MAX_CELL_CHARS) return cell;
          previewTrimmed = true;
          return `${cell.slice(0, MAX_CELL_CHARS)}…`;
        }),
      );
      return {
        id: request.id,
        result: {
          kind: "parse",
          delimiter,
          rowCount: parsed.rows.length,
          columnCount: parsed.columnCount,
          preview,
          previewTrimmed,
          warnings: parsed.warnings,
          warningCount: parsed.warningCount,
        },
      };
    }
    if (session.rows == null) return { id: request.id, error: "先に CSV を読み込んでください" };
    const converted = convertRows(session.rows, request.format, request.header);
    return {
      id: request.id,
      result: { kind: "convert", format: request.format, ...converted },
    };
  } catch (cause) {
    return { id: request.id, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
