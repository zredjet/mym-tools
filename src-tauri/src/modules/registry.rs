//! モジュールの集中登録 (`architecture.md` §5.1 / `module-contract.md` §5.3 / Q-22 PoC)。
//!
//! - `MODULE_BACKENDS()` が `Arc<dyn ModuleBackend>` の配列を返す
//! - `register_invoke_handler()` が Tauri Builder に各モジュールの `#[tauri::command]` を
//!   一括登録する。`generate_handler!` マクロは展開上 1 か所に集約するのが安全
//!
//! ## 新モジュール追加時の編集箇所 (ADR-0004 §5.1: 「2 ファイル追加 + registry 1 行追記 × 2」)
//! 1. `MODULE_BACKENDS()` の Vec に `Arc::new(<NewModule>::new())` を追加 (1 行)
//! 2. `register_invoke_handler()` の `generate_handler!` リストに固有コマンドを列挙
//!    (固有コマンド数で行数が変わる)

use std::sync::Arc;

use crate::module::ModuleBackend;
use crate::modules::hash::HashModule;

/// アプリで利用するすべての ModuleBackend を順序付きで返す。
///
/// 順序は AppState 構築時にこの配列をそのまま `HashMap<&'static str, Arc<dyn ModuleBackend>>`
/// に詰め直す前提なので意味を持たないが、UI のサイドバー表示順を制御したい場合に
/// 利用できる (Phase 1 後の検討)。
pub fn module_backends() -> Vec<Arc<dyn ModuleBackend>> {
    vec![
        Arc::new(HashModule),
        // 新モジュールはここに 1 行追加する
    ]
}

/// 各モジュールの Tauri コマンドを集中登録する。
///
/// `tauri::generate_handler!` の制約で、すべてのコマンドを 1 か所に列挙する必要がある
/// (`module-contract.md` §5.3)。新モジュール追加時はこの `generate_handler!` リストに
/// 固有コマンドを追記する。
pub fn register_invoke_handler<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        // M-Hash
        crate::modules::hash::commands::hash_compute_text,
        // 新モジュールの固有コマンドはここに追加する
    ])
}
