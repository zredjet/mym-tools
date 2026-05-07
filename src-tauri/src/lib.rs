//! MyMyTools のエントリポイント (`architecture.md` §2)。
//!
//! Phase 1 着手最初期の最小構成 (Q-22 PoC):
//! - モジュールはビルド時静的合成 (ADR-0004): `modules::registry::register_invoke_handler`
//!   が各モジュールの `#[tauri::command]` を `generate_handler!` で集中登録する
//! - 当面は M-Hash の `hash_compute_text` のみ動作確認用に登録される
//!
//! 後続フェーズで:
//! - `AppState` に `OperationRegistry` (ADR-0009) と `StorageService` (data-model.md §13)
//!   を持たせる
//! - `module_backends()` 配列を `HashMap<&'static str, Arc<dyn ModuleBackend>>` に詰めて
//!   AppState に渡す (`module-contract.md` §5.1)

pub mod error;
pub mod module;
pub mod modules;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// `tauri::generate_context!()` マクロがコンパイル時にスレッド生成プリミティブへ展開するため、
// clippy.toml の disallowed-methods (ADR-0009 R-2) が誤検知する。フレームワーク内部の
// スレッド生成でありユーザーコードの規約違反ではないため局所的に許可する。
// 直接スレッドを生成するユーザーコードは ADR-0010 §2.5 の grep fallback で検出される。
#[allow(clippy::disallowed_methods)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    let builder = modules::registry::register_invoke_handler(builder);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
