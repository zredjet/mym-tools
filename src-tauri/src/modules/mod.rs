//! モジュール群のサブツリー (`module-contract.md` §11 / ADR-0004)。
//!
//! 新モジュール追加時はここに `pub mod <id>;` を 1 行足し、`registry.rs` の Arc 配列
//! と `generate_handler!` リストにそれぞれ 1 行ずつ追記する。**コアサービス・既存
//! モジュールのコードは編集しない** (ADR-0004 §5.1)。

pub mod a11y;
pub mod codec;
pub mod color;
pub mod cron;
pub mod datetime;
pub mod diagram;
pub mod hash;
pub mod http;
pub mod idgen;
mod image_export;
pub mod jwt;
pub mod linkmemo;
pub mod memo;
pub mod mermaid;
pub mod nrbf;
pub mod palette;
pub mod pdfmerge;
pub mod prompt;
pub mod regex;
pub mod registry;
pub mod secretgen;
pub mod textdiff;
pub mod urlquery;
