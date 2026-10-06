//! M-文字コード変換: テキストファイルの文字コードを判定し、別の文字コード・改行で
//! 別名保存するステートレスモジュール (ADR-0024)。

pub mod commands;
mod convert;

use crate::module::ModuleBackend;

pub struct EncodingModule;

impl ModuleBackend for EncodingModule {
    fn id(&self) -> &'static str {
        "encoding"
    }

    fn is_stateless(&self) -> bool {
        true
    }
}
