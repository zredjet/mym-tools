//! モジュール群のサブツリー (`module-contract.md` §11 / ADR-0004)。
//!
//! 新モジュール追加時はここに `pub mod <id>;` を 1 行足し、`registry.rs` の Arc 配列
//! と `generate_handler!` リストにそれぞれ 1 行ずつ追記する。**コアサービス・既存
//! モジュールのコードは編集しない** (ADR-0004 §5.1)。

pub mod color;
pub mod hash;
pub mod linkmemo;
pub mod prompt;
pub mod registry;
