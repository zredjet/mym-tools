//! M-Hash: ハッシュ計算モジュール (`requirements.md` §2.2 M-Hash / D-06)。
//!
//! ステートレスモジュール (items テーブルに何も書かない)。提供コマンドは:
//! - `hash_compute_text`: テキストハッシュ (Q-22 PoC で導入)
//! - `hash_compute_file`: ファイルハッシュ + キャンセル機構 (ADR-0009 §2 / PR-F)

pub mod commands;
pub mod progress;

use crate::module::ModuleBackend;

/// M-Hash の ModuleBackend 実装。
///
/// `items` を持たない (D-06) ため `is_stateless: true`。`current_payload_version` /
/// `upgrade_payload` / `validate_payload` / `index_text` はすべてデフォルト実装で
/// 済む (StorageService からは呼ばれない)。
pub struct HashModule;

impl ModuleBackend for HashModule {
    fn id(&self) -> &'static str {
        "hash"
    }

    fn is_stateless(&self) -> bool {
        true
    }
}
