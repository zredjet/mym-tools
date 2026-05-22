/**
 * プロンプト本文から変数プレースホルダ `{{name}}` を抽出する
 * (`docs/data-model.md` §10.1 / `docs/module-contract.md` §12.1)。
 *
 * バックエンドの `template::extract_variables` (Rust) と同じ振る舞いをする TS 実装。
 * UI でリスト行に「4 vars」等の件数表示や、編集フォームでの変数チップ表示に使う。
 *
 * 規約 (PR-AD で日本語対応):
 * - 変数名は **Unicode `Alphabetic` プロパティ / Number + `_`** (1 文字以上)。
 *   `\p{Alphabetic}` (Alphabetic property: Lu+Ll+Lt+Lm+Lo+Nl+Other_Alphabetic) +
 *   `\p{N}` (Number 全般) + `_` を `u` flag で照合
 * - ✅ ASCII (`topic` / `lang_1`) / CJK (`トピック` / `言語` / `ぷろんぷと`) /
 *   Indic 等の combining marks 含む綴り (`किताब` = क+ि+त+ा+ब)
 * - ❌ 空白 (`{{ topic }}`) / ハイフン (`{{a-b}}`) / 記号類は無効 → silently 無視
 *   (Mustache 慣例の前後空白許容は U-13 候補、別 PR)
 * - 重複は除外、出現順を保持
 * - **Rust `char::is_alphanumeric()` と完全一致**: Rust の `is_alphabetic` は Unicode
 *   "Alphabetic" 派生プロパティを使うため、`\p{Alphabetic}` と等価 (codex PR-AD P1)
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
// `\p{Alphabetic}` は **Unicode 派生プロパティ** で `Letter + Nl + Other_Alphabetic` を含む。
// これにより Hindi `ि` (U+093F, Mc) や Arabic vowel marks など **combining marks 経由で
// アルファベット扱いされる文字** を許容できる (Rust `char::is_alphabetic()` と等価、
// codex PR-AD P1)。Letter (`\p{L}`) だけでは Mc / Mn が漏れる。
// `\p{N}` は Number 全般 (Nd, Nl, No)。Rust `is_numeric` と一致。
const VALID_VAR_NAME = /^[\p{Alphabetic}\p{N}_]+$/u;

function isValidVarName(s: string): boolean {
  return s.length > 0 && VALID_VAR_NAME.test(s);
}
