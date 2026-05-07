//! MyMyTools のエントリポイント (`architecture.md` §2)。
//!
//! - `modules::registry::module_backends()` で `Arc<dyn ModuleBackend>` の Vec を取得し
//!   `AppState::build` で `HashMap<&'static str, Arc<dyn ModuleBackend>>` に詰める
//! - `manage(state)` で Tauri Builder に共有状態として登録する
//!   (`module-contract.md` §5.1)
//! - `modules::registry::register_invoke_handler` が `generate_handler!` で各モジュールの
//!   `#[tauri::command]` を集中登録する (ADR-0004 §5.1)
//!
//! 後続フェーズで:
//! - `AppState` に `OperationRegistry` (ADR-0009) を追加 (PR-C)
//! - `AppState` に `StorageService` (data-model.md §13) を追加 (PR-D)

pub mod error;
pub mod module;
pub mod modules;
pub mod state;
pub mod time;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// `tauri::generate_context!()` マクロがコンパイル時にスレッド生成プリミティブへ展開するため、
// clippy.toml の disallowed-methods (ADR-0009 R-2) が誤検知する。フレームワーク内部の
// スレッド生成でありユーザーコードの規約違反ではないため局所的に許可する。
// 直接スレッドを生成するユーザーコードは ADR-0010 §2.5 の grep fallback で検出される。
#[allow(clippy::disallowed_methods)]
pub fn run() {
    // モジュールレジストリ → AppState へ (`module-contract.md` §2: id 重複は起動停止)
    let backends = modules::registry::module_backends();
    let app_state = AppState::build(backends).expect("module registry must have unique ids");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state);
    let builder = modules::registry::register_invoke_handler(builder);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
