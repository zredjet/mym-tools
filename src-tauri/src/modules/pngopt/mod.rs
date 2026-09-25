//! M-PNG最適化: shotq (ADR-0023) で PNG を非可逆に最適化するステートレスモジュール。

pub mod commands;
pub mod progress;

use crate::module::ModuleBackend;

pub struct PngOptModule;

impl ModuleBackend for PngOptModule {
    fn id(&self) -> &'static str {
        "pngopt"
    }

    fn is_stateless(&self) -> bool {
        true
    }
}
