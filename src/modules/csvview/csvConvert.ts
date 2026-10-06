import type { Delimiter } from "./csvParser";

export type OutputFormat = "json" | "markdown" | "csv" | "tsv";

export interface ConvertResult {
  text: string;
  warnings: string[];
}

export const outputFormatLabels: Record<OutputFormat, string> = {
  json: "JSON",
  markdown: "Markdown 表",
  csv: "CSV",
  tsv: "TSV",
};

function placeholder(index: number): string {
  return `列${index + 1}`;
}

/**
 * 見出しの名前を決める。空の見出しは `列N`、重複は `name_2` / `name_3` のように変え、
 * 見出しより多い欄にも `列N` を付ける。
 */
export function columnNames(
  headerRow: readonly string[] | null,
  columnCount: number,
): { names: string[]; warnings: string[] } {
  const names: string[] = [];
  const used = new Set<string>();
  let renamed = 0;
  let filled = 0;
  for (let index = 0; index < columnCount; index += 1) {
    const original = headerRow?.[index];
    let name = original == null || original === "" ? placeholder(index) : original;
    if (headerRow != null && (original == null || original === "")) filled += 1;
    if (used.has(name)) {
      let suffix = 2;
      while (used.has(`${name}_${suffix}`)) suffix += 1;
      name = `${name}_${suffix}`;
      renamed += 1;
    }
    used.add(name);
    names.push(name);
  }
  const warnings: string[] = [];
  if (filled > 0) warnings.push(`空の見出し ${filled} 個を「列N」にしました`);
  if (renamed > 0) warnings.push(`重複した見出し ${renamed} 個に _2 などを付けました`);
  return { names, warnings };
}

function widthOf(rows: readonly (readonly string[])[]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

/**
 * 見出しありならオブジェクトの配列、なしなら配列の配列。値はすべて文字列のまま。
 * `Object.fromEntries` で作るので、`__proto__` という見出しも普通のキーになる。
 */
export function toJson(rows: readonly (readonly string[])[], header: boolean): ConvertResult {
  if (!header) return { text: JSON.stringify(rows, null, 2), warnings: [] };
  const [headerRow = [], ...body] = rows;
  const { names, warnings } = columnNames(headerRow, widthOf(rows));
  const objects = body.map((row) =>
    Object.fromEntries(names.map((name, i) => [name, row[i] ?? ""])),
  );
  return { text: JSON.stringify(objects, null, 2), warnings };
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/** GFM の表。見出しが無ければ `列1..N` を見出しにする。 */
export function toMarkdown(rows: readonly (readonly string[])[], header: boolean): ConvertResult {
  const width = Math.max(widthOf(rows), 1);
  const headerRow = header ? (rows[0] ?? []) : null;
  const body = header ? rows.slice(1) : rows;
  const names = Array.from({ length: width }, (_, index) => {
    const value = headerRow?.[index];
    return value == null || value === "" ? placeholder(index) : value;
  });
  const line = (cells: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, i) => escapeMarkdownCell(cells[i] ?? "")).join(" | ")} |`;
  const lines = [line(names), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`];
  for (const row of body) lines.push(line(row));
  return { text: `${lines.join("\n")}\n`, warnings: [] };
}

/** 区切り文字・引用符・改行を含む欄だけを引用符で囲む。改行は LF。 */
export function toDelimited(
  rows: readonly (readonly string[])[],
  delimiter: Delimiter,
): ConvertResult {
  const needsQuote = (value: string) =>
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r");
  const quote = (value: string) => (needsQuote(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const text = rows.map((row) => row.map(quote).join(delimiter)).join("\n");
  return { text: rows.length > 0 ? `${text}\n` : "", warnings: [] };
}

export function convertRows(
  rows: readonly (readonly string[])[],
  format: OutputFormat,
  header: boolean,
): ConvertResult {
  switch (format) {
    case "json":
      return toJson(rows, header);
    case "markdown":
      return toMarkdown(rows, header);
    case "csv":
      return toDelimited(rows, ",");
    case "tsv":
      return toDelimited(rows, "\t");
  }
}
