//! フォルダ容量の走査の進捗をTauri Channelで通知する型。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DirSizeProgress {
    Started,
    /// 走査中の途中経過。100 ms ごとに間引いて送る
    Scanning {
        files: u64,
        dirs: u64,
        logical_bytes: u64,
        /// いま読んでいるフォルダ
        current_dir: String,
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
        let json = serde_json::to_value(DirSizeProgress::Scanning {
            files: 3,
            dirs: 1,
            logical_bytes: 10,
            current_dir: "/a".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "scanning");
        assert_eq!(json["logical_bytes"], 10);
        assert_eq!(json["current_dir"], "/a");
        let json = serde_json::to_value(DirSizeProgress::Started).unwrap();
        assert_eq!(json["type"], "started");
        let json = serde_json::to_value(DirSizeProgress::Cancelled).unwrap();
        assert_eq!(json["type"], "cancelled");
    }
}
