//! M-Prompt の変数差し込みテンプレート機能 (`module-contract.md` §12.1 /
//! `data-model.md` §10.1 / `requirements.md` §M-Prompt)。
//!
//! - `extract_variables(body)`: 本文から `{{name}}` プレースホルダを抽出 (重複なし、出現順)
//! - `render_template(body, variables)`: `{{name}}` を `variables[name]` で置換。
//!   未定義変数は `{{name}}` のまま残す (部分レンダリング許容)
//!
//! ## 変数名の許容文字
//! `[A-Za-z0-9_]+` (英数字 + アンダースコア、1 文字以上)。日本語を変数名にすると
//! 識別子としての扱いが UI で煩雑になるためサポート外 (タイトル / body 本文では当然許容)。

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

/// 変数名として許容される文字列か (`[A-Za-z0-9_]+`)。
fn is_valid_var_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
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
        // 日本語変数名・スペース入り変数名は無効として無視
        assert!(extract_variables("{{こんにちは}}").is_empty());
        assert!(extract_variables("{{a b}}").is_empty());
        assert!(extract_variables("{{a-b}}").is_empty());
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
}
