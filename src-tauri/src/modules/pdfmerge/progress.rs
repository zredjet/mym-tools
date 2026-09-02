//! PDF検査・結合の進捗をTauri Channelで通知する型。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PdfMergeProgress {
    Reading {
        completed_files: u32,
        total_files: u32,
        file_name: String,
    },
    Merging {
        completed_files: u32,
        total_files: u32,
        pages_processed: u32,
    },
    Writing {
        total_pages: u32,
    },
    Done {
        duration_ms: u64,
    },
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_a_discriminated_union() {
        let json = serde_json::to_value(PdfMergeProgress::Reading {
            completed_files: 1,
            total_files: 2,
            file_name: "a.pdf".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "reading");
        assert_eq!(json["completed_files"], 1);

        let json = serde_json::to_value(PdfMergeProgress::Cancelled).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "cancelled" }));
    }
}
