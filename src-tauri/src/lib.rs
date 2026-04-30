//! MyMyTools のエントリポイント。
//!
//! Phase 1 着手時に各モジュール (M-Prompt / M-LinkMemo / M-Color / M-Hash) のコマンドを
//! `modules::registry::register_all` 経由で集中登録する (ADR-0004 / module-contract.md §5.3)。
//! 現在は CI を通すための最小実装のみ。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// `tauri::generate_context!()` マクロがコンパイル時にスレッド生成プリミティブへ展開するため、
// clippy.toml の disallowed-methods (ADR-0009 R-2) が誤検知する。フレームワーク内部の
// スレッド生成でありユーザーコードの規約違反ではないため局所的に許可する。
// 直接スレッドを生成するユーザーコードは ADR-0010 §2.5 の grep fallback で検出される。
#[allow(clippy::disallowed_methods)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
