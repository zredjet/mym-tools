//! M-PDF Merge: 複数PDFをファイル単位の順序で結合するステートレスモジュール。

pub mod commands;
pub mod progress;

use crate::module::ModuleBackend;

pub struct PdfMergeModule;

impl ModuleBackend for PdfMergeModule {
    fn id(&self) -> &'static str {
        "pdfmerge"
    }

    fn is_stateless(&self) -> bool {
        true
    }
}
