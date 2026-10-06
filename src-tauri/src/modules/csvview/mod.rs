//! M-CSV ビューア: CSV / TSV を表で表示し、JSON・Markdown 表・CSV・TSV に変換する
//! ステートレスモジュール。ファイルの判定・復号だけを Rust で行う (ADR-0024)。

pub mod commands;

use crate::module::ModuleBackend;

pub struct CsvViewModule;

impl ModuleBackend for CsvViewModule {
    fn id(&self) -> &'static str {
        "csvview"
    }

    fn is_stateless(&self) -> bool {
        true
    }
}
