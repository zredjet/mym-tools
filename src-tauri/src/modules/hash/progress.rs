//! M-Hash の進捗 Channel 型 (ADR-0009 §2.4)。
//!
//! `tauri::ipc::Channel<HashFileProgress>` でフロントへ送る。Tauri Event は使わない
//! (ADR-0009 §3.1: Event は型安全性が低く、broadcast で複数同時実行時に listener 側で
//! operation_id フィルタが必要になるため Channel を採用)。
//!
//! ADR-0009 §2.3 R-9: 完了 / キャンセル成立直前に **最終状態を 1 件 send** する。
//! `send` の失敗 (フロントが Channel を既に drop した等) は panic させず
//! `tracing::warn!` でログのみ残して続行する。

use serde::Serialize;

/// M-Hash ファイルハッシュ計算の進捗イベント。
///
/// `#[serde(tag = "type")]` で内部タグ付き enum としてシリアライズされ、フロントは
/// TypeScript の discriminated union として `switch (p.type)` で網羅性チェックできる。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HashFileProgress {
    /// 計算中の進捗通知。1 MB チャンク (ADR-0009 §2.3 R-5) ごとに送られる。
    Progress {
        bytes_processed: u64,
        total_bytes: u64,
    },
    /// 完了直前。これ以降 send されない (R-9)。
    Done { duration_ms: u64 },
    /// キャンセル成立。これ以降 send されない (R-9)。
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_serializes_with_type_tag() {
        let p = HashFileProgress::Progress {
            bytes_processed: 1024,
            total_bytes: 4096,
        };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["type"], "progress");
        assert_eq!(json["bytes_processed"], 1024);
        assert_eq!(json["total_bytes"], 4096);
    }

    #[test]
    fn done_serializes_with_duration() {
        let p = HashFileProgress::Done { duration_ms: 1234 };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["type"], "done");
        assert_eq!(json["duration_ms"], 1234);
    }

    #[test]
    fn cancelled_serializes_as_just_type() {
        let p = HashFileProgress::Cancelled;
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["type"], "cancelled");
        // 余計なフィールドは持たない
        assert_eq!(json.as_object().unwrap().len(), 1);
    }
}
