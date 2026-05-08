/**
 * プロンプト本文から変数プレースホルダ `{{name}}` を抽出する
 * (`docs/data-model.md` §10.1 / `docs/module-contract.md` §12.1)。
 *
 * バックエンドの `template::extract_variables` (Rust) と同じ振る舞いをする TS 実装。
 * UI でリスト行に「4 vars」等の件数表示や、編集フォームでの変数チップ表示に使う。
 *
 * 規約:
 * - 変数名は `[A-Za-z0-9_]+` のみ
 * - 不正形式 (`{{ }}` 空 / `{{a-b}}` 等) は無視
 * - 重複は除外、出現順を保持
 */
export function extractPromptVariables(body: string): string[] {
  const vars: string[] = [];
  let rest = body;
  while (true) {
    const start = rest.indexOf("{{");
    if (start === -1) break;
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end === -1) break;
    const name = after.slice(0, end);
    if (isValidVarName(name) && !vars.includes(name)) {
      vars.push(name);
    }
    rest = after.slice(end + 2);
  }
  return vars;
}

function isValidVarName(s: string): boolean {
  return s.length > 0 && /^[A-Za-z0-9_]+$/.test(s);
}
