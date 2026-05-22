//! M-Prompt の変数差し込みテンプレート機能 (`module-contract.md` §12.1 /
//! `data-model.md` §10.1 / `requirements.md` §M-Prompt)。
//!
//! - `extract_variables(body)`: 本文から `{{name}}` プレースホルダを抽出 (重複なし、出現順)
//! - `render_template(body, variables)`: `{{name}}` を `variables[name]` で置換。
//!   未定義変数は `{{name}}` のまま残す (部分レンダリング許容)
//!
//! ## 変数名の許容文字 (PR-AD で日本語対応)
//!
//! Unicode の **letter / number + `_`** を許容 (1 文字以上)。具体的には Rust の
//! `char::is_alphanumeric()` (= Unicode "Alphabetic" / "Numeric" 派生プロパティ) と
//! アンダースコア。
//!
//! - ✅ `{{topic}}` / `{{lang_1}}` (ASCII)
//! - ✅ `{{トピック}}` (カタカナ) / `{{言語}}` (漢字) / `{{ぷろんぷと}}` (ひらがな)
//! - ✅ ASCII + CJK 混在 (`{{topic1}}` と `{{topic１}}` は **別変数** として扱う、全角/半角は区別)
//! - ❌ 空白 (`{{ topic }}` / `{{a b}}`) — Phase 1 ではエラーではなく **silently 無視**。
//!   Mustache 慣例の前後空白許容は U-13 候補 (別 PR)
//! - ❌ ハイフン (`{{a-b}}`) / 記号類
//!
//! TS 側の `src/lib/promptVars.ts` / `src/lib/promptRender.ts` も同じ規則 (`\p{L}\p{N}_`)
//! で実装する。

use std::collections::HashMap;

/// 本文から変数プレースホルダ `{{name}}` を抽出する (重複なし、出現順を保持)。
///
/// 不正な形式 (`{{}` で閉じない / `{{}}` 空 / 不正文字含む) は **無視** する
/// (例外を投げず、有効な変数だけ拾う)。
pub fn extract_variables(body: &str) -> Vec<String> {
    let mut vars: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        let after_open = &rest[start + 2..];
        if let Some(end) = after_open.find("}}") {
            let name = &after_open[..end];
            if is_valid_var_name(name) && !vars.iter().any(|v| v == name) {
                vars.push(name.to_string());
            }
            rest = &after_open[end + 2..];
        } else {
            break;
        }
    }
    vars
}

/// 本文の `{{name}}` を `variables[name]` で置換する。未定義変数はそのまま残す
/// (部分レンダリング)。`}}` で閉じない `{{` や不正な変数名のリテラルもそのまま残す。
pub fn render_template(body: &str, variables: &HashMap<String, String>) -> String {
    let mut result = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        match after_open.find("}}") {
            Some(end) => {
                let name = &after_open[..end];
                if is_valid_var_name(name) {
                    match variables.get(name) {
                        Some(value) => result.push_str(value),
                        None => {
                            // 未定義変数は元のまま残す (UI が「未入力」状態で部分プレビューできる)
                            result.push_str("{{");
                            result.push_str(name);
                            result.push_str("}}");
                        }
                    }
                } else {
                    // 不正な変数名: リテラル `{{...}}` としてそのまま残す
                    result.push_str("{{");
                    result.push_str(name);
                    result.push_str("}}");
                }
                rest = &after_open[end + 2..];
            }
            None => {
                // `}}` が見つからない場合: `{{` 以降は全てリテラルとして残し終了
                result.push_str("{{");
                result.push_str(after_open);
                rest = "";
            }
        }
    }
    result.push_str(rest);
    result
}

/// 変数名として許容される文字列か (Unicode letter / number / `_`、1 文字以上)。
///
/// `char::is_alphanumeric()` は Unicode "Alphabetic" / "Numeric" 派生プロパティを使うため、
/// ASCII (`a`-`z`, `A`-`Z`, `0`-`9`) に加えて CJK (漢字 / ひらがな / カタカナ) や
/// 他言語の文字も許容される。詳細はファイル先頭ドキュメント参照。
fn is_valid_var_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    // -------- extract_variables --------

    #[test]
    fn extract_simple_single_variable() {
        assert_eq!(extract_variables("Hello {{name}}"), vec!["name"]);
    }

    #[test]
    fn extract_multiple_distinct_variables_in_order() {
        assert_eq!(
            extract_variables("{{topic}} を {{language}} に翻訳"),
            vec!["topic", "language"]
        );
    }

    #[test]
    fn extract_dedupes_repeats_keeps_first_occurrence_order() {
        assert_eq!(
            extract_variables("{{a}} {{b}} {{a}} {{c}} {{b}}"),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn extract_no_variables() {
        assert!(extract_variables("plain text without any placeholder").is_empty());
    }

    #[test]
    fn extract_skips_empty_braces() {
        assert!(extract_variables("text {{}} more").is_empty());
    }

    #[test]
    fn extract_skips_invalid_chars_in_name() {
        // 空白入り・ハイフン入りの変数名は無効として無視。
        // (Phase 1: Mustache 慣例の `{{ name }}` 前後空白許容は U-13 候補で別 PR)
        assert!(extract_variables("{{a b}}").is_empty());
        assert!(extract_variables("{{a-b}}").is_empty());
        assert!(extract_variables("{{a.b}}").is_empty());
        assert!(extract_variables("{{a@b}}").is_empty());
    }

    /// PR-AD 回帰: 日本語 (ひらがな / カタカナ / 漢字) を変数名として許容する。
    #[test]
    fn extract_supports_japanese_variable_names() {
        assert_eq!(extract_variables("{{こんにちは}}"), vec!["こんにちは"]);
        assert_eq!(extract_variables("{{トピック}}"), vec!["トピック"]);
        assert_eq!(extract_variables("{{言語}}"), vec!["言語"]);
        assert_eq!(extract_variables("{{ぷろんぷと}}"), vec!["ぷろんぷと"]);
    }

    /// PR-AD 回帰: ASCII と CJK の混在 + 出現順保持。
    #[test]
    fn extract_mixed_ascii_and_japanese_in_order() {
        assert_eq!(
            extract_variables("Translate {{topic}} into {{言語}}"),
            vec!["topic", "言語"]
        );
    }

    /// PR-AD 回帰: 全角数字と半角数字は **別変数** として区別される
    /// (Unicode コードポイントが違うため、文字列比較で一致しない)。
    #[test]
    fn extract_treats_fullwidth_and_halfwidth_digits_as_distinct() {
        // Unicode エスケープで明示: `1` (U+0031) vs `1` (U+FF11)
        let body = "{{topic1}} と {{topic\u{FF11}}}";
        let result = extract_variables(body);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], "topic1");
        assert_eq!(result[1], "topic\u{FF11}");
        assert_ne!(result[0], result[1]);
    }

    #[test]
    fn extract_handles_unclosed_brace() {
        // `{{` で始まり `}}` で閉じないケース: 抽出停止 (panic しない)
        assert!(extract_variables("text {{abc no closing").is_empty());
        assert_eq!(extract_variables("{{ok}} but {{no_close"), vec!["ok"]);
    }

    #[test]
    fn extract_underscore_and_digits() {
        assert_eq!(
            extract_variables("{{user_id_1}} and {{topic42}}"),
            vec!["user_id_1", "topic42"]
        );
    }

    // -------- render_template --------

    #[test]
    fn render_replaces_provided_variable() {
        let s = render_template("Hello {{name}}", &vars(&[("name", "Alice")]));
        assert_eq!(s, "Hello Alice");
    }

    #[test]
    fn render_leaves_undefined_variables_as_is() {
        let s = render_template("Hello {{name}}, age {{age}}", &vars(&[("name", "Alice")]));
        assert_eq!(s, "Hello Alice, age {{age}}");
    }

    #[test]
    fn render_replaces_repeated_variable_each_occurrence() {
        let s = render_template("{{x}} and {{x}}", &vars(&[("x", "Y")]));
        assert_eq!(s, "Y and Y");
    }

    #[test]
    fn render_no_variables_returns_input() {
        let s = render_template("plain text", &HashMap::new());
        assert_eq!(s, "plain text");
    }

    #[test]
    fn render_handles_unclosed_brace_as_literal() {
        let s = render_template("Hello {{name", &vars(&[("name", "Alice")]));
        assert_eq!(s, "Hello {{name");
    }

    #[test]
    fn render_preserves_invalid_variable_literally() {
        // `{{a-b}}` のように不正な変数名は変換せずにそのまま残す
        let s = render_template("{{a-b}} ok", &vars(&[("a-b", "X")]));
        assert_eq!(s, "{{a-b}} ok");
    }

    #[test]
    fn render_translation_example_from_spec() {
        // data-model.md §10.1 の例: "Translate the following to {{language}}: {{text}}"
        let s = render_template(
            "Translate the following to {{language}}: {{text}}",
            &vars(&[("language", "Japanese"), ("text", "hello")]),
        );
        assert_eq!(s, "Translate the following to Japanese: hello");
    }

    #[test]
    fn render_empty_value_replaces_with_empty() {
        let s = render_template("Hello [{{name}}]", &vars(&[("name", "")]));
        assert_eq!(s, "Hello []");
    }

    #[test]
    fn render_does_not_recurse_into_replaced_value() {
        // 値に `{{x}}` が含まれていても再展開しない (無限ループ・置換順依存を避ける)
        let s = render_template("{{a}}", &vars(&[("a", "{{b}}"), ("b", "VALUE")]));
        assert_eq!(s, "{{b}}");
    }

    /// PR-AD 回帰: 日本語変数名の置換。
    #[test]
    fn render_replaces_japanese_variable_names() {
        let s = render_template(
            "{{言語}} で {{トピック}} について書いてください",
            &vars(&[("言語", "日本語"), ("トピック", "猫")]),
        );
        assert_eq!(s, "日本語 で 猫 について書いてください");
    }

    /// PR-AD 回帰: ASCII と CJK 混在の placeholder と value の組合せ。
    #[test]
    fn render_mixed_ascii_and_japanese_placeholders() {
        let s = render_template(
            "Translate {{topic}} into {{言語}}",
            &vars(&[("topic", "hello"), ("言語", "日本語")]),
        );
        assert_eq!(s, "Translate hello into 日本語");
    }

    /// PR-AD 回帰: 日本語の未定義変数も「そのまま残す」フォールバックが動く。
    #[test]
    fn render_leaves_undefined_japanese_variable_as_is() {
        let s = render_template("{{topic}} と {{言語}}", &vars(&[("topic", "hello")]));
        assert_eq!(s, "hello と {{言語}}");
    }
}
