/**
 * プロンプト本文から変数プレースホルダ `{{name}}` を抽出する
 * (`docs/data-model.md` §10.1 / `docs/module-contract.md` §12.1)。
 *
 * バックエンドの `template::extract_variables` (Rust) と同じ振る舞いをする TS 実装。
 * UI でリスト行に「4 vars」等の件数表示や、編集フォームでの変数チップ表示に使う。
 *
 * 規約 (PR-AD で日本語対応):
 * - 変数名は **Unicode letter / number + `_`** (1 文字以上)。`\p{L}` (Letter) +
 *   `\p{N}` (Number) + `_` を `u` flag で照合
 * - ✅ ASCII (`topic` / `lang_1`) と CJK (`トピック` / `言語` / `ぷろんぷと`) を許容
 * - ❌ 空白 (`{{ topic }}`) / ハイフン (`{{a-b}}`) / 記号類は無効 → silently 無視
 *   (Mustache 慣例の前後空白許容は U-13 候補、別 PR)
 * - 重複は除外、出現順を保持
 * - Rust `char::is_alphanumeric()` と概ね一致 (Latin / CJK の範囲では完全一致)
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

// `u` flag を必須にすることで `\p{...}` (Unicode property escapes) を有効化する。
// `\p{L}` = Letter 全般 (Lu, Ll, Lt, Lm, Lo)。`\p{N}` = Number 全般 (Nd, Nl, No)。
const VALID_VAR_NAME = /^[\p{L}\p{N}_]+$/u;

function isValidVarName(s: string): boolean {
  return s.length > 0 && VALID_VAR_NAME.test(s);
}
