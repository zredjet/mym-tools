//! M-Prompt の Tauri コマンド (`module-contract.md` §12.1)。
//!
//! - `prompt_render_template`: 本文と変数マップを受け、`{{name}}` を変数値で差し込んだ
//!   完成プロンプトを返す。pure function (state 不要、副作用なし)

use std::collections::HashMap;

use crate::error::AppError;
use crate::modules::prompt::template::render_template;

/// プロンプト本文の `{{name}}` 変数を差し込んだ結果文字列を返す
/// (`module-contract.md` §12.1 / `data-model.md` §10.1)。
///
/// pure function: 同じ `body` + `variables` から常に同じ結果を返す。エラー経路は無く
/// 戻り値は `Result<String, AppError>` だが Phase 1 では常に `Ok`。
/// 将来 syntax error 等を返す余地のため `Result` を残してある。
#[tauri::command]
pub fn prompt_render_template(
    body: String,
    variables: HashMap<String, String>,
) -> Result<String, AppError> {
    Ok(render_template(&body, &variables))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_with_variables() {
        let body = "Translate {{text}} to {{lang}}".to_string();
        let mut vars = HashMap::new();
        vars.insert("text".into(), "hello".into());
        vars.insert("lang".into(), "Japanese".into());
        let result = prompt_render_template(body, vars).unwrap();
        assert_eq!(result, "Translate hello to Japanese");
    }

    #[test]
    fn no_variables_passes_through() {
        let result = prompt_render_template("plain text".into(), HashMap::new()).unwrap();
        assert_eq!(result, "plain text");
    }

    #[test]
    fn missing_variable_remains_as_placeholder() {
        let result = prompt_render_template("Hello {{name}}".into(), HashMap::new()).unwrap();
        assert_eq!(result, "Hello {{name}}");
    }
}
