/**
 * プロンプト本文の `{{name}}` を `variables` で差し込んだ完成プロンプトを返す
 * (`docs/data-model.md` §10.1 / `docs/module-contract.md` §12.1)。
 *
 * Rust 側 `template::render_template` (`src-tauri/src/modules/prompt/template.rs`)
 * と同じ振る舞いを TS で再実装したもの。pure function で IPC 越し呼び出し
 * (`prompt_render_template` Tauri command) を介さずに UI 側で同期計算できる
 * ようにする (PromptDetailPage の preview 表示で round-trip ラグを排除)。
 *
 * 規約 (Rust 実装と一致):
 * - 変数名は `[A-Za-z0-9_]+` のみ
 * - 未定義変数は `{{name}}` のままリテラルとして残す (部分プレビュー対応)
 * - 不正な変数名 (`{{a-b}}` 等) はリテラル扱い
 * - 値の中に含まれる `{{x}}` は再展開しない (無限ループ回避)
 * - `}}` で閉じない `{{` 以降はリテラル
 */
export function renderPromptTemplate(body: string, variables: Record<string, string>): string {
  let result = "";
  let rest = body;
  while (true) {
    const start = rest.indexOf("{{");
    if (start === -1) {
      result += rest;
      break;
    }
    result += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end === -1) {
      result += "{{" + after;
      break;
    }
    const name = after.slice(0, end);
    if (isValidVarName(name)) {
      if (Object.prototype.hasOwnProperty.call(variables, name)) {
        result += variables[name] ?? "";
      } else {
        result += "{{" + name + "}}";
      }
    } else {
      result += "{{" + name + "}}";
    }
    rest = after.slice(end + 2);
  }
  return result;
}

function isValidVarName(s: string): boolean {
  return s.length > 0 && /^[A-Za-z0-9_]+$/.test(s);
}
