//! M-フォルダ容量: 指定フォルダ配下の容量をフォルダごとに集計するステートレスモジュール (ADR-0025)。

pub mod commands;
mod platform;
pub mod progress;
mod root;
mod scan;

use crate::module::ModuleBackend;

pub struct DirSizeModule;

impl ModuleBackend for DirSizeModule {
    fn id(&self) -> &'static str {
        "dirsize"
    }

    fn is_stateless(&self) -> bool {
        true
    }
}
