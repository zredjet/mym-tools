//! フォルダ単位のPNG最適化の進捗をTauri Channelで通知する型。

use serde::Serialize;

/// 1ファイルの処理結果。CLI の終了コード 0 / 99 / 98 と、処理できなかった場合の `failed`。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PngOptStatus {
    Optimized,
    QualityTooLow,
    NotSmaller,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PngOptProgress {
    Started {
        total: u32,
    },
    File {
        /// 0 始まりの処理順
        index: u32,
        total: u32,
        name: String,
        status: PngOptStatus,
        input_bytes: u64,
        output_bytes: u64,
        /// shotq の処理内容 (英語) か、失敗理由 (日本語)
        detail: String,
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
        let json = serde_json::to_value(PngOptProgress::File {
            index: 0,
            total: 2,
            name: "a.png".into(),
            status: PngOptStatus::QualityTooLow,
            input_bytes: 10,
            output_bytes: 10,
            detail: String::new(),
        })
        .unwrap();
        assert_eq!(json["type"], "file");
        assert_eq!(json["status"], "quality_too_low");
        assert_eq!(json["input_bytes"], 10);
        let json = serde_json::to_value(PngOptProgress::Cancelled).unwrap();
        assert_eq!(json["type"], "cancelled");
    }
}
