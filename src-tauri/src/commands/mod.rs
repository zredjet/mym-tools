//! コア共通の Tauri コマンド (`core_*` 命名規則)。
//!
//! `module-contract.md` §6.2 により、モジュール配下の UI から `core_*` を直接呼ぶことは
//! 禁止されている。Shell や共通フックからのみ呼ばれる想定。

pub mod backup;
pub mod cancel;
pub mod items;
pub mod projects;
pub mod search;
pub mod transfer;
