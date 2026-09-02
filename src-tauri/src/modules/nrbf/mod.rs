//! M-NRBF: BinaryFormatterのNRBFペイロードを型生成せず読み取るステートレスモジュール。

pub mod commands;
pub mod protocol;

use crate::module::ModuleBackend;

pub struct NrbfModule;

impl ModuleBackend for NrbfModule {
    fn id(&self) -> &'static str {
        "nrbf"
    }

    fn is_stateless(&self) -> bool {
        true
    }
}
