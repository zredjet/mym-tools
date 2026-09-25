//! 同梱エディタ (draw.io / SVG-Edit) の loopback asset server が使う、埋め込み asset の存在確認。
//!
//! `AssetResolver::get` は該当キーが無いと `{path}.html` → `{path}/index.html` → アプリ本体の
//! `index.html` の順にフォールバックする。そのまま使うと、エディタ用の IPC 無し origin に
//! 存在しないパスで 200 + アプリ本体の HTML を返してしまい、404 分岐も働かない。
//! キーが完全一致で存在するときだけ取得させる。

use std::collections::HashSet;
use std::sync::OnceLock;

use tauri::AppHandle;

static BUNDLED_KEYS: OnceLock<HashSet<String>> = OnceLock::new();

/// `relative_key` (例: `drawio/js/app.min.js`) が埋め込み asset に完全一致で存在するか。
/// 埋め込み asset はビルド時に固定されるため、キー集合は初回に 1 度だけ作る。
#[cfg_attr(debug_assertions, allow(dead_code))]
pub(crate) fn contains(app: &AppHandle, relative_key: &str) -> bool {
    BUNDLED_KEYS
        .get_or_init(|| {
            app.asset_resolver()
                .iter()
                .map(|(key, _)| normalize_key(&key).to_string())
                .collect()
        })
        .contains(normalize_key(relative_key))
}

/// `AssetKey` は先頭に `/` を持つ (`/drawio/index.html`)。比較用に取り除く。
fn normalize_key(key: &str) -> &str {
    key.trim_start_matches('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_asset_keys_with_or_without_root() {
        assert_eq!(normalize_key("/drawio/index.html"), "drawio/index.html");
        assert_eq!(normalize_key("drawio/index.html"), "drawio/index.html");
    }
}
