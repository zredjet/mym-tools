import { describe, expect, it } from "vitest";

import {
  defaultJsonFormatOptions,
  formatJson,
  type JsonFormatOptions,
  JsonSyntaxError,
  MAX_DEPTH,
  MAX_INPUT_LENGTH,
  MAX_REPORTED_DUPLICATE_KEYS,
  positionAt,
} from "./jsonFormat";

function format(input: string, options: Partial<JsonFormatOptions> = {}) {
  return formatJson(input, { ...defaultJsonFormatOptions, ...options });
}

function syntaxError(input: string): JsonSyntaxError {
  try {
    format(input);
  } catch (cause) {
    if (cause instanceof JsonSyntaxError) return cause;
    throw cause;
  }
  throw new Error(`構文エラーになりませんでした: ${input}`);
}

describe("formatJson: 整形と圧縮", () => {
  const sample = '{"name":"mym","tags":["a","b"],"nested":{"ok":true,"none":null},"n":-1.5}';

  it("2 スペースで整形した結果が JSON.stringify と一致する", () => {
    expect(format(sample).output).toBe(JSON.stringify(JSON.parse(sample), null, 2));
  });

  it("4 スペースとタブで整形できる", () => {
    expect(format(sample, { indent: "4" }).output).toBe(
      JSON.stringify(JSON.parse(sample), null, 4),
    );
    expect(format(sample, { indent: "tab" }).output).toBe(
      JSON.stringify(JSON.parse(sample), null, "\t"),
    );
  });

  it("圧縮すると空白と改行がなくなる", () => {
    const pretty = format(sample).output;
    expect(format(pretty, { mode: "minify" }).output).toBe(sample);
  });

  it("空の配列とオブジェクトは 1 行のままにする", () => {
    expect(format('{"a":[],"b":{},"c":[ [ ] , { } ]}').output).toBe(
      '{\n  "a": [],\n  "b": {},\n  "c": [\n    [],\n    {}\n  ]\n}',
    );
  });

  it("最上位が文字列・数値・リテラルでも扱える", () => {
    expect(format(' "x" ').output).toBe('"x"');
    expect(format("42\n").output).toBe("42");
    expect(format("null").output).toBe("null");
    expect(format("42").stats).toEqual({ objects: 0, arrays: 0, values: 1, maxDepth: 0 });
  });

  it("文字列の中の空白や記号には触らない", () => {
    const input = '{"a b":" [1, 2] ","c":"{\\"x\\": 1}"}';
    expect(format(input, { mode: "minify" }).output).toBe(input);
  });
});

describe("formatJson: 値を書き換えない", () => {
  it("数値を書かれていたまま出力する", () => {
    const input = "[1.0,1e400,12345678901234567890,-0,1E+2,0.10]";
    expect(format(input, { mode: "minify" }).output).toBe(input);
    expect(format(input).output).toBe(
      "[\n  1.0,\n  1e400,\n  12345678901234567890,\n  -0,\n  1E+2,\n  0.10\n]",
    );
  });

  it("文字列とキーのエスケープを書かれていたまま出力する", () => {
    const input = '{"\\u00e9\\/":"\\ud83d\\ude00\\n\\u0041","é":"\\ud800"}';
    expect(format(input, { mode: "minify" }).output).toBe(input);
  });

  it("重複したキーを両方とも残す", () => {
    const result = format('{"a":1,"a":2}', { mode: "minify" });
    expect(result.output).toBe('{"a":1,"a":2}');
  });
});

describe("formatJson: キーの並べ替え", () => {
  it("入れ子の中も UTF-16 コード単位の順に並べ、配列の順序は変えない", () => {
    const input = '{"b":1,"a":{"z":[3,1,2],"y":null},"B":2,"あ":3,"10":4,"9":5}';
    expect(format(input, { mode: "minify", sortKeys: true }).output).toBe(
      '{"10":4,"9":5,"B":2,"a":{"y":null,"z":[3,1,2]},"b":1,"あ":3}',
    );
  });

  it("エスケープされたキーは解いた文字で比べ、書き方は残す", () => {
    expect(format('{"c":1,"\\u0062":2,"a":3}', { mode: "minify", sortKeys: true }).output).toBe(
      '{"a":3,"\\u0062":2,"c":1}',
    );
  });

  it("重複したキーは元の順序のまま並ぶ", () => {
    expect(format('{"b":1,"a":"x","a":"y"}', { mode: "minify", sortKeys: true }).output).toBe(
      '{"a":"x","a":"y","b":1}',
    );
  });

  it("並べ替えない時は元の順序のまま", () => {
    expect(format('{"b":1,"a":2}', { mode: "minify" }).output).toBe('{"b":1,"a":2}');
  });
});

describe("formatJson: 集計と警告", () => {
  it("オブジェクト・配列・値の個数と深さを数える", () => {
    expect(format('{"a":[1,"x",{"b":null}],"c":{}}').stats).toEqual({
      objects: 3,
      arrays: 1,
      values: 3,
      maxDepth: 3,
    });
  });

  it("重複したキーを位置付きで報告する", () => {
    const result = format('{\n  "a": 1,\n  "b": {"a": 1},\n  "\\u0061": 2\n}');
    expect(result.duplicateKeyCount).toBe(1);
    expect(result.duplicateKeys).toEqual([
      { key: "a", position: { offset: 31, line: 4, column: 3 } },
    ]);
  });

  it("__proto__ などの名前もキーとして扱う", () => {
    const result = format('{"__proto__":1,"constructor":2,"__proto__":3}', { mode: "minify" });
    expect(result.output).toBe('{"__proto__":1,"constructor":2,"__proto__":3}');
    expect(result.duplicateKeys.map((duplicate) => duplicate.key)).toEqual(["__proto__"]);
  });

  it("重複の報告は先頭の件数だけにし、総数は数える", () => {
    const members = Array.from({ length: MAX_REPORTED_DUPLICATE_KEYS + 6 }, () => '"k":0');
    const result = format(`{${members.join(",")}}`);
    expect(result.duplicateKeyCount).toBe(MAX_REPORTED_DUPLICATE_KEYS + 5);
    expect(result.duplicateKeys).toHaveLength(MAX_REPORTED_DUPLICATE_KEYS);
  });

  it("先頭の BOM を取り除いて知らせる", () => {
    const result = format('﻿{"a":1}', { mode: "minify" });
    expect(result.output).toBe('{"a":1}');
    expect(result.removedBom).toBe(true);
    expect(format('{"a":1}').removedBom).toBe(false);
  });
});

describe("formatJson: 構文エラー", () => {
  it.each<[string, string, number, number]>([
    ['{"a":1,}', "末尾のカンマは使えません", 1, 7],
    ["[1,2, ]", "末尾のカンマは使えません", 1, 5],
    ["{'a':1}", "キーは二重引用符", 1, 2],
    ["{a:1}", "キーは二重引用符", 1, 2],
    ["{1:2}", "キーは二重引用符", 1, 2],
    ["{[]:2}", "キー (二重引用符で囲んだ文字列) が必要です", 1, 2],
    ["['a']", "文字列は二重引用符", 1, 2],
    ["// c\n1", "コメントは JSON では使えません", 1, 1],
    ["[1, /* c */ 2]", "コメントは JSON では使えません", 1, 5],
    ["[01]", "余分な 0", 1, 2],
    ["[-01]", "余分な 0", 1, 2],
    ["[1.]", "小数点の後ろに数字がありません", 1, 4],
    ["[.5]", "数値は + や . で始められません", 1, 2],
    ["[+1]", "数値は + や . で始められません", 1, 2],
    ["[-]", "- の後ろに数字がありません", 1, 2],
    ["[1e]", "指数に数字がありません", 1, 4],
    ["[1e+]", "指数に数字がありません", 1, 5],
    ['"abc', "文字列が閉じていません", 1, 1],
    ['["abc\\', "文字列が閉じていません", 1, 2],
    ['"a\nb"', "文字列の途中で改行されています", 1, 3],
    ['"a\tb"', "制御文字はそのまま書けません", 1, 3],
    ['"\\x41"', "使えないエスケープです: \\x", 1, 2],
    ['"\\u12g4"', "16 進数が 4 桁必要です", 1, 2],
    ['"\\u12', "16 進数が 4 桁必要です", 1, 2],
    ["[1 2]", "「,」か「]」が必要です", 1, 4],
    ["[0x10]", "「,」か「]」が必要です", 1, 3],
    ['{"a" 1}', "キーの後ろに「:」が必要です", 1, 6],
    ['{"a":1 "b":2}', "「,」か「}」が必要です", 1, 8],
    ["[1", "配列が閉じていません", 1, 3],
    ['{"a":', "JSON が途中で終わっています", 1, 6],
    ['{"a":1', "オブジェクトが閉じていません", 1, 7],
    ['{"a":1,', "オブジェクトが閉じていません", 1, 8],
    ["1 2", "値の後ろに余分な文字があります", 1, 3],
    ['{"a":1}\n{"b":2}', "値の後ろに余分な文字があります", 2, 1],
    ["NaN", "「NaN」は JSON の値ではありません", 1, 1],
    ["[undefined]", "「undefined」は JSON の値ではありません", 1, 2],
    ["True", "「True」は JSON の値ではありません", 1, 1],
    ["nullx", "「nullx」は JSON の値ではありません", 1, 1],
    ["[,1]", "値がありません", 1, 2],
    ['{"a":}', "値がありません", 1, 6],
    [" \n\t ", "JSON がありません", 2, 3],
    [" 1", "使えない文字です: U+00A0", 1, 1],
    ["[1,　2]", "使えない文字です: U+3000", 1, 4],
    ["[“a”]", "使えない文字です: 「“」", 1, 2],
  ])("%j → %s (%i 行 %i 文字目)", (input, message, line, column) => {
    const error = syntaxError(input);
    expect(error.message).toContain(message);
    expect({ line: error.position.line, column: error.position.column }).toEqual({ line, column });
  });

  it("複数行の入力では行と列を数え、CRLF と CR も 1 つの改行として扱う", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const input = ["{", '  "a": 1,', '  "b": tru', "}"].join(newline);
      const error = syntaxError(input);
      expect(error.message).toContain("「tru」は JSON の値ではありません");
      expect(error.position.line).toBe(3);
      expect(error.position.column).toBe(8);
      expect(input.slice(error.position.offset, error.position.offset + 3)).toBe("tru");
    }
  });

  it("BOM の後ろのエラーは、BOM を含めた位置で報告する", () => {
    expect(syntaxError("﻿[1,]").position).toEqual({ offset: 3, line: 1, column: 4 });
  });
});

describe("formatJson: 上限", () => {
  it(`入れ子は ${MAX_DEPTH} 段まで扱い、それより深いと拒否する`, () => {
    const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
    const result = format(nested(MAX_DEPTH), { mode: "minify" });
    expect(result.output).toBe(nested(MAX_DEPTH));
    expect(result.stats.maxDepth).toBe(MAX_DEPTH);

    const error = syntaxError(nested(MAX_DEPTH + 1));
    expect(error.message).toContain("入れ子が深すぎます");
    expect(error.position.column).toBe(MAX_DEPTH + 1);
  });

  it("1 MiB を超える入力を拒否する", () => {
    const body = "1".repeat(MAX_INPUT_LENGTH - 2);
    expect(format(`[${body}]`, { mode: "minify" }).output).toHaveLength(MAX_INPUT_LENGTH);
    expect(() => format(`[${body}] `)).toThrow("入力は1MiB以下にしてください");
  });

  it("整形した結果が 8 MiB を超える時は拒否し、圧縮はできる", () => {
    const input = "[".repeat(500) + "0,".repeat(20_000) + "0" + "]".repeat(500);
    expect(() => format(input, { indent: "4" })).toThrow("整形した結果が8MiBを超えます");
    expect(format(input, { mode: "minify" }).output).toBe(input);
  });
});

describe("positionAt", () => {
  it("先頭と行頭を 1 行目・1 文字目から数える", () => {
    expect(positionAt("abc", 0)).toEqual({ offset: 0, line: 1, column: 1 });
    expect(positionAt("a\nbc", 2)).toEqual({ offset: 2, line: 2, column: 1 });
    expect(positionAt("a\r\nbc", 4)).toEqual({ offset: 4, line: 2, column: 2 });
    expect(positionAt("a\r\rb", 3)).toEqual({ offset: 3, line: 3, column: 1 });
  });
});
