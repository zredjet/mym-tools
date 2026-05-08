//! ローカルバックアップ層 (ADR-0007 / `data-model.md` §13)。
//!
//! - `BackupKind`: バックアップ種別 (`Auto` / `PreOp(prefix)` / `Manual`)
//! - `BackupRecord`: 1 ファイルぶんのメタ情報 (path / kind / created_at / data_revision /
//!   size_bytes)
//! - `BackupService` trait: 取得 / 一覧 / 削除 / 整合性検証 / リストアの境界
//! - `LocalBackupService`: `<userdata>/backups/{auto,pre-op,manual}/` を実装
//!
//! 高レベルなオーケストレーション (型確認入力 / アプリ再起動) は呼び出し側 (Tauri
//! コマンド / UI) の責務。本モジュールは **メカニズムのみ** を提供する。

pub mod local;

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::AppError;

pub use local::LocalBackupService;

/// バックアップ種別 (`data-model.md` §13.3 / §13.4 / §13.5)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackupKind {
    /// 日次自動取得 (`data_revision` が前回より変化 + 24h 経過 / 10 件ローテーション)。
    Auto,
    /// 破壊的操作直前。`prefix` は `"pre-import"` / `"pre-delete-project-<id>"` 等
    /// (`data-model.md` §13.4 表)。30 件ローテーション。
    PreOp { prefix: String },
    /// ユーザー手動 (自動ローテーションなし)。
    Manual,
}

impl BackupKind {
    /// このバックアップ種別を保存するサブディレクトリ名 (`<userdata>/backups/<dir>/`)。
    pub fn dir_name(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::PreOp { .. } => "pre-op",
            Self::Manual => "manual",
        }
    }

    /// バックアップファイル名の prefix (`data-model.md` §13.3 〜 §13.5)。
    /// `PreOp` のみ呼び出し側指定の文字列を返す。
    pub fn file_prefix(&self) -> String {
        match self {
            Self::Auto => "auto".into(),
            Self::PreOp { prefix } => prefix.clone(),
            Self::Manual => "manual".into(),
        }
    }

    /// 自動ローテーションで保持する最大世代数 (`Manual` は `None` = 無制限)。
    pub fn rotation_limit(&self) -> Option<usize> {
        match self {
            Self::Auto => Some(10),
            Self::PreOp { .. } => Some(30),
            Self::Manual => None,
        }
    }
}

/// バックアップ 1 ファイルぶんの情報 (UI 一覧 / リストア対象選択で使う)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupRecord {
    /// 絶対パス (UI 表示用 + 削除 / リストア時の参照)。
    pub path: PathBuf,
    /// 種別 (auto / pre-op の prefix / manual)。
    pub kind: BackupKind,
    /// 取得時刻 (`JST_FILENAME_TIMESTAMP` をパースし、`JST_ISO8601` に整形した文字列)。
    /// 不正なファイル名は `list_backups` の段階で除外される。
    pub created_at: String,
    /// 取得時の `data_revision` (ファイル名末尾 `-r<N>` から抽出)。
    pub data_revision: i64,
    /// バックアップファイルサイズ (バイト単位、UI で表示用)。
    pub size_bytes: u64,
}

/// バックアップサービス境界 (`AppState` で `Arc<dyn BackupService>` として保持される想定)。
///
/// `BackupKind::Auto` 等の取得タイミング判定は **呼び出し側 (Tauri command / lib.rs の
/// 起動フロー)** が `should_take_auto` で問い合わせ、真であれば `take(BackupKind::Auto)`
/// を呼ぶ。サービス自身は判定ロジックを持つが、いつ問い合わせるかは決めない。
pub trait BackupService: Send + Sync + std::fmt::Debug {
    /// 指定 kind のバックアップを取得し、取得後に meta を更新する。
    ///
    /// - `Auto`: `last_backup_revision` + `last_auto_backup_at` 更新 / 10 件ローテーション
    /// - `PreOp`: `last_backup_revision` 更新 / 30 件ローテーション
    /// - `Manual`: `last_backup_revision` 更新 / **ローテーションなし**
    ///
    /// 戻り値は作成された `BackupRecord` (path / kind / created_at / data_revision /
    /// size_bytes)。取得失敗時は `AppError::Storage` / `AppError::Io`。
    fn take(&self, kind: BackupKind) -> Result<BackupRecord, AppError>;

    /// auto バックアップが必要か判定する (`data-model.md` §13.3):
    /// `data_revision != last_backup_revision` **かつ** 直近の `last_auto_backup_at` から
    /// 24 時間以上経過 (or 未取得)。
    fn should_take_auto(&self) -> Result<bool, AppError>;

    /// 全バックアップ (auto / pre-op / manual) を `created_at DESC` 順で返す
    /// (UI 一覧用)。ファイル名解析失敗のものは除外し `tracing::warn!` でログ。
    fn list(&self) -> Result<Vec<BackupRecord>, AppError>;

    /// 指定 path のバックアップを物理削除する (UI からの manual 削除)。
    /// 存在しない場合は `Err(AppError::NotFound)`、`<userdata>/backups/` 配下でない
    /// 場合は `Err(AppError::Validation)` を返す (path injection 防止)。
    fn delete(&self, path: &Path) -> Result<(), AppError>;

    /// バックアップファイルの整合性検証 (`PRAGMA integrity_check`、ADR-0007 §2.4.1)。
    /// 成功すれば `Ok(())`、SQLite が "ok" 以外を返したら `Err(AppError::Storage)`。
    fn verify_integrity(&self, path: &Path) -> Result<(), AppError>;

    /// `src_path` のバックアップを **現在の DB に書き戻す** (`data-model.md` §13.6 step 6)。
    ///
    /// 実行前に **必ず** `take(BackupKind::PreOp { prefix: "pre-restore" })` で
    /// pre-restore バックアップを取り、`verify_integrity(src_path)` で整合性検証を済ませる
    /// (ADR-0007 §2.4)。本メソッドは整合性チェック未実施を信頼する低レベル API
    /// なので、呼び出し側 (Tauri command) は手順を守ること。
    ///
    /// アプリ再起動 (step 7) も呼び出し側の責務。
    fn restore_from(&self, src_path: &Path) -> Result<(), AppError>;
}
