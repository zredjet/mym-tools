//! M-Hash: ハッシュ計算モジュール (`requirements.md` §2.2 M-Hash / D-06)。
//!
//! ステートレスモジュール (items テーブルに何も書かない)。Q-22 PoC では
//! `hash_compute_text` のみを実装し、ファイルハッシュ + キャンセル機構 (ADR-0009) は
//! 後続で追加する。

pub mod commands;

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
