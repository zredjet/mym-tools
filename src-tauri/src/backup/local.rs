//! `LocalBackupService`: `<userdata>/backups/{auto,pre-op,manual}/` 上に SQLite
//! ファイルを置くローカルバックアップ実装 (ADR-0007 / `data-model.md` §13)。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone};
use rusqlite::{Connection, OpenFlags};

use crate::backup::{BackupKind, BackupRecord, BackupService};
use crate::error::AppError;
use crate::storage::StorageService;
use crate::time::{format_jst_iso8601, jst_offset, now_jst_filename_timestamp, now_jst_iso8601};

/// auto バックアップの 24 時間ゲート (`data-model.md` §13.3)。
const AUTO_BACKUP_INTERVAL_SECS: i64 = 24 * 60 * 60;

/// `<userdata>/backups/{auto,pre-op,manual}/` を管理するバックアップサービス。
pub struct LocalBackupService {
    /// バックアップを置くルート (`<userdata>/backups/`)。
    backups_root: PathBuf,
    /// アクティブな DB を握るストレージ (Online Backup の src として使う + meta 更新)。
    storage: Arc<dyn StorageService>,
}

impl std::fmt::Debug for LocalBackupService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalBackupService")
            .field("backups_root", &self.backups_root)
            .finish()
    }
}

impl LocalBackupService {
    /// `<userdata>/backups/` をルートとするバックアップサービスを作成する。
    /// 初回呼び出し時にサブディレクトリ (`auto` / `pre-op` / `manual`) は作られていなくて
    /// よい (`take` 時に必要なディレクトリだけ作る)。
    pub fn new(backups_root: PathBuf, storage: Arc<dyn StorageService>) -> Self {
        Self {
            backups_root,
            storage,
        }
    }

    /// 指定 kind のサブディレクトリ (`<root>/auto`, `<root>/pre-op`, `<root>/manual`)。
    fn dir_for(&self, kind: &BackupKind) -> PathBuf {
        self.backups_root.join(kind.dir_name())
    }

    /// 取得後ファイル名を生成する: `<prefix>-<JST_FILENAME_TIMESTAMP>-r<revision>.sqlite`。
    fn build_filename(&self, kind: &BackupKind, revision: i64, ts: &str) -> String {
        format!("{}-{ts}-r{revision}.sqlite", kind.file_prefix())
    }

    /// `<dir>` の `*.sqlite` ファイル群を、ファイル名から抽出した
    /// `JST_FILENAME_TIMESTAMP` の **昇順** (古い順) で返す。
    ///
    /// pre-op ディレクトリには複数 prefix (`pre-import-...` / `pre-delete-project-...`
    /// 等) が混在し、フルファイル名の辞書順では prefix が支配的になり時系列とずれる
    /// (PR #30 codex P2 指摘)。そのため必ず timestamp 部分でソートする。
    /// timestamp 解析に失敗したファイルは末尾 (= 「最も古い」扱い) に置き、ローテーション
    /// で先に削除されるようにする。
    fn collect_files_in_dir(&self, dir: &Path) -> Result<Vec<PathBuf>, AppError> {
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
            .map_err(AppError::from)?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "sqlite"))
            .collect();
        // タイムスタンプ抽出。`Option<String>` は `None < Some(...)` の Ord を持つため、
        // パース不可は最古扱い (rotation で先に削除される) になるよう逆転させる
        paths.sort_by_cached_key(|p| {
            extract_filename_timestamp(p)
                .map(|ts| (1, ts))
                .unwrap_or((0, String::new()))
            // (0, _) は (1, _) より小 → ASC ソートで先頭 (= 最古扱い)
        });
        Ok(paths)
    }

    /// `<dir>` を `limit` 件まで保ち、超過分は古い順 (= timestamp 昇順の先頭側) から削除する。
    fn rotate(&self, dir: &Path, limit: usize) -> Result<(), AppError> {
        let files = self.collect_files_in_dir(dir)?;
        if files.len() <= limit {
            return Ok(());
        }
        let to_delete = files.len() - limit;
        for path in files.iter().take(to_delete) {
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "rotation: failed to delete old backup; will retry on next rotate"
                );
            }
        }
        Ok(())
    }

    /// 既存バックアップ 1 件のメタデータを構築する。ファイル名解析に失敗したら `None`。
    fn record_from_path(&self, path: &Path) -> Option<BackupRecord> {
        let file_name = path.file_name()?.to_str()?;
        // `<prefix>-<YYYY-MM-DDTHH-MM-SS-sss>-r<N>.sqlite`
        // suffix `.sqlite` を剥がす
        let stem = file_name.strip_suffix(".sqlite")?;

        // 末尾 `-r<N>` を抽出
        let r_idx = stem.rfind("-r")?;
        let revision_str = &stem[r_idx + 2..];
        let data_revision: i64 = revision_str.parse().ok()?;
        let before_revision = &stem[..r_idx];

        // ファイル名末尾 23 文字が `JST_FILENAME_TIMESTAMP`
        if before_revision.len() < 24 {
            // prefix が空に等しい場合 (`-<ts>`) も許容する: 例 `-2026...-r1.sqlite`。
            // ただし通常は `auto-...` 等で prefix がある。安全側で min 24 (`p-` + 23) を要求
            return None;
        }
        // 末尾 23 文字が `YYYY-MM-DDTHH-MM-SS-sss` のはず。先頭は `-` で区切られる
        let ts_start = before_revision.len() - 23;
        if ts_start == 0 || before_revision.as_bytes().get(ts_start - 1) != Some(&b'-') {
            return None;
        }
        let timestamp_str = &before_revision[ts_start..];
        let prefix_str = &before_revision[..ts_start - 1];

        // タイムスタンプを JST_FILENAME_TIMESTAMP → DateTime にパース
        let dt = parse_filename_timestamp(timestamp_str)?;
        let created_at = format_jst_iso8601(&dt);

        // kind を prefix から判定: "auto" / "manual" / 他は PreOp(prefix)
        let kind = match prefix_str {
            "auto" => BackupKind::Auto,
            "manual" => BackupKind::Manual,
            other => BackupKind::PreOp {
                prefix: other.to_string(),
            },
        };

        let size_bytes = std::fs::metadata(path).ok().map(|m| m.len()).unwrap_or(0);

        Some(BackupRecord {
            path: path.to_path_buf(),
            kind,
            created_at,
            data_revision,
            size_bytes,
        })
    }
}

/// `<prefix>-<JST_FILENAME_TIMESTAMP>-r<N>.sqlite` 形式のパスから
/// `JST_FILENAME_TIMESTAMP` 部分の **文字列** (23 文字) を抽出する。ローテーション用の
/// ソートキーで、パース不要で済むよう生文字列で返す (JST_FILENAME_TIMESTAMP の辞書順は
/// 時系列と一致するため、文字列比較で十分)。
fn extract_filename_timestamp(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_str()?;
    let stem = file_name.strip_suffix(".sqlite")?;
    let r_idx = stem.rfind("-r")?;
    // `-r` の後がすべて数字であることを軽く確認 (`-rev` 等の文字列誤マッチ防止)
    let revision_str = &stem[r_idx + 2..];
    if revision_str.is_empty() || !revision_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let before_revision = &stem[..r_idx];
    if before_revision.len() < 24 {
        return None;
    }
    let ts_start = before_revision.len() - 23;
    if ts_start == 0 || before_revision.as_bytes().get(ts_start - 1) != Some(&b'-') {
        return None;
    }
    let ts = &before_revision[ts_start..];
    // 区切り文字を軽く検証 (4 / 7 / 13 / 16 / 19 = '-'、10 = 'T')
    let bytes = ts.as_bytes();
    if bytes.len() != 23
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b'-'
        || bytes[16] != b'-'
        || bytes[19] != b'-'
    {
        return None;
    }
    Some(ts.to_string())
}

/// `JST_FILENAME_TIMESTAMP` (`YYYY-MM-DDTHH-MM-SS-sss`) を `DateTime<FixedOffset>` にパースする。
fn parse_filename_timestamp(s: &str) -> Option<DateTime<FixedOffset>> {
    // chrono の format spec は `:` を含むため、独自パース。23 文字決め打ち
    // バイト位置: 0-3 年 / 5-6 月 / 8-9 日 / T 区切り / 11-12 時 / 14-15 分 / 17-18 秒 / 20-22 ms
    let bytes = s.as_bytes();
    // 区切りバイト位置: 4='-' 7='-' 10='T' 13='-' 16='-' 19='-'
    if bytes.len() != 23
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b'-'
        || bytes[16] != b'-'
        || bytes[19] != b'-'
    {
        return None;
    }
    let y: i32 = s[0..4].parse().ok()?;
    let mo: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    let h: u32 = s[11..13].parse().ok()?;
    let mi: u32 = s[14..16].parse().ok()?;
    let se: u32 = s[17..19].parse().ok()?;
    let ms: u32 = s[20..23].parse().ok()?;
    let naive = NaiveDateTime::new(
        chrono::NaiveDate::from_ymd_opt(y, mo, d)?,
        chrono::NaiveTime::from_hms_milli_opt(h, mi, se, ms)?,
    );
    jst_offset().from_local_datetime(&naive).single()
}

impl BackupService for LocalBackupService {
    fn take(&self, kind: BackupKind) -> Result<BackupRecord, AppError> {
        let revision = self.storage.data_revision()?;
        let ts = now_jst_filename_timestamp();
        let dir = self.dir_for(&kind);
        std::fs::create_dir_all(&dir).map_err(AppError::from)?;
        let filename = self.build_filename(&kind, revision, &ts);
        let path = dir.join(&filename);

        // 1) Online Backup API で書き出し
        self.storage.take_online_backup_to(&path)?;

        // 2) meta 更新 (data_revision は増やさない、ADR-0007 §2.2)
        self.storage.set_last_backup_revision(revision)?;
        if matches!(kind, BackupKind::Auto) {
            self.storage.set_last_auto_backup_at(&now_jst_iso8601())?;
        }

        // 3) ローテーション (Manual は None)
        if let Some(limit) = kind.rotation_limit() {
            self.rotate(&dir, limit)?;
        }

        // 4) BackupRecord を返す
        let size_bytes = std::fs::metadata(&path).ok().map(|m| m.len()).unwrap_or(0);
        // 取得時の created_at は ts から再構築 (filename 解析と同じ経路)
        let created_at = parse_filename_timestamp(&ts)
            .map(|dt| format_jst_iso8601(&dt))
            .unwrap_or_else(now_jst_iso8601);
        Ok(BackupRecord {
            path,
            kind,
            created_at,
            data_revision: revision,
            size_bytes,
        })
    }

    fn should_take_auto(&self) -> Result<bool, AppError> {
        let current = self.storage.data_revision()?;
        let last_rev = self.storage.last_backup_revision()?;
        if current == last_rev {
            return Ok(false);
        }
        // last_auto_backup_at が空なら auto 未取得 → 真
        let Some(last_at) = self.storage.last_auto_backup_at()? else {
            return Ok(true);
        };
        // 24 時間経過判定
        let last_dt = match crate::time::parse_jst_iso8601(&last_at) {
            Ok(d) => d,
            Err(e) => {
                // 不正値はログを残して「未取得扱い」(=取得する) で進める。本来は schema
                // で空文字 OR JST_ISO8601 のみ許容しているが、運用中の壊れに備え defensive
                tracing::warn!(value = %last_at, error = %e, "last_auto_backup_at parse failed; treating as not taken");
                return Ok(true);
            }
        };
        let now = chrono::Utc::now().with_timezone(&jst_offset());
        let elapsed = (now - last_dt).num_seconds();
        Ok(elapsed >= AUTO_BACKUP_INTERVAL_SECS)
    }

    fn list(&self) -> Result<Vec<BackupRecord>, AppError> {
        let mut out: Vec<BackupRecord> = Vec::new();
        for sub in &["auto", "pre-op", "manual"] {
            let dir = self.backups_root.join(sub);
            for path in self.collect_files_in_dir(&dir)? {
                match self.record_from_path(&path) {
                    Some(r) => out.push(r),
                    None => {
                        tracing::warn!(
                            path = %path.display(),
                            "skipping backup with unparseable filename"
                        );
                    }
                }
            }
        }
        // created_at DESC (新しい順)
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    fn delete(&self, path: &Path) -> Result<(), AppError> {
        let canonical_path = self.ensure_path_inside_root(path)?;
        std::fs::remove_file(&canonical_path).map_err(AppError::from)?;
        Ok(())
    }

    fn verify_integrity(&self, path: &Path) -> Result<(), AppError> {
        // ADR-0007 §2.4.1 / `data-model.md` §13.6: `PRAGMA integrity_check` を 1 回実行
        //
        // **PR #30 codex P1 対策**: 既定の `Connection::open` は対象ファイルが無い場合に
        // 空 DB を新規作成してしまい、`integrity_check` が "ok" を返して missing/typo の
        // ソースが「健全」と誤判定される。restore に進むと空 DB 上書き = データ消失。
        // (a) 事前に `path.exists()` を確認し
        // (b) `OpenFlags::SQLITE_OPEN_READ_ONLY` のみで開く (新規作成・書き込み禁止)
        // の二段で防御する
        if !path.exists() {
            return Err(AppError::NotFound {
                entity: "backup file".into(),
                key: path.display().to_string(),
            });
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(AppError::from)?;
        let result: String = conn
            .query_row("PRAGMA integrity_check;", [], |row| row.get(0))
            .map_err(AppError::from)?;
        if result == "ok" {
            Ok(())
        } else {
            Err(AppError::Storage(format!(
                "integrity_check failed for {}: {result}",
                path.display()
            )))
        }
    }

    fn restore_from(&self, src_path: &Path) -> Result<(), AppError> {
        // PR #35 codex P1 対応: src_path も `backups_root` 配下に必須化する。
        // `core_backup_restore` は IPC で任意の path を受け取れるため、含意のない
        // 健全な SQLite ファイル (例えばユーザーが別途持っている DB) を間違って指定して
        // アクティブ DB を上書きする事故を物理的に不可能にする。
        let canonical_src = self.ensure_path_inside_root(src_path)?;
        self.storage.restore_online_backup_from(&canonical_src)
    }
}

impl LocalBackupService {
    /// `path` が `backups_root` 配下に実在することを確認し、canonical パスを返す
    /// (path injection 防止、symlink 経路も canonicalize で同一視)。
    /// - 不在は `AppError::NotFound`
    /// - root 外 / canonicalize 失敗は `AppError::Validation`
    fn ensure_path_inside_root(&self, path: &Path) -> Result<PathBuf, AppError> {
        if !path.exists() {
            return Err(AppError::NotFound {
                entity: "backup file".into(),
                key: path.display().to_string(),
            });
        }
        let canonical_root =
            self.backups_root
                .canonicalize()
                .map_err(|e| AppError::Validation {
                    module_id: "core.backup".into(),
                    reason: format!(
                        "backups_root canonicalize failed ({}): {e}",
                        self.backups_root.display()
                    ),
                })?;
        let canonical_path = path.canonicalize().map_err(AppError::from)?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err(AppError::Validation {
                module_id: "core.backup".into(),
                reason: format!(
                    "path is outside backups_root: {} not under {}",
                    canonical_path.display(),
                    canonical_root.display()
                ),
            });
        }
        Ok(canonical_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteStorage;
    use std::fs::File;
    use std::sync::Arc;

    fn make_service() -> (tempfile::TempDir, Arc<SqliteStorage>, LocalBackupService) {
        let temp = tempfile::tempdir().unwrap();
        let backups_root = temp.path().join("backups");
        // ファイルベース (in-memory ではバックアップ src として動くが、parent 解決の
        // テストパスが付かない)。一時ディレクトリ内にファイル DB を作る。
        let db_path = temp.path().join("data.sqlite");
        let storage: Arc<SqliteStorage> = Arc::new(SqliteStorage::open(&db_path).unwrap());
        let dyn_storage: Arc<dyn StorageService> = Arc::clone(&storage) as Arc<dyn StorageService>;
        let svc = LocalBackupService::new(backups_root, dyn_storage);
        (temp, storage, svc)
    }

    // -------- BackupKind --------

    #[test]
    fn backup_kind_dir_names() {
        assert_eq!(BackupKind::Auto.dir_name(), "auto");
        assert_eq!(
            BackupKind::PreOp {
                prefix: "pre-import".into()
            }
            .dir_name(),
            "pre-op"
        );
        assert_eq!(BackupKind::Manual.dir_name(), "manual");
    }

    #[test]
    fn backup_kind_rotation_limits() {
        assert_eq!(BackupKind::Auto.rotation_limit(), Some(10));
        assert_eq!(
            BackupKind::PreOp {
                prefix: "pre-import".into()
            }
            .rotation_limit(),
            Some(30)
        );
        assert_eq!(BackupKind::Manual.rotation_limit(), None);
    }

    #[test]
    fn backup_kind_file_prefixes() {
        assert_eq!(BackupKind::Auto.file_prefix(), "auto");
        assert_eq!(BackupKind::Manual.file_prefix(), "manual");
        assert_eq!(
            BackupKind::PreOp {
                prefix: "pre-delete-project-uuid".into()
            }
            .file_prefix(),
            "pre-delete-project-uuid"
        );
    }

    // -------- take --------

    #[test]
    fn take_auto_writes_file_and_updates_meta() {
        let (_temp, storage, svc) = make_service();
        // 何かしらデータ変更を起こす (data_revision が 0 → 1)
        storage.create_project("Project", None).unwrap();
        let rev_before = storage.data_revision().unwrap();
        assert_eq!(rev_before, 1);

        let record = svc.take(BackupKind::Auto).unwrap();
        assert!(record.path.exists());
        assert_eq!(record.kind, BackupKind::Auto);
        assert_eq!(record.data_revision, 1);
        assert!(record.size_bytes > 0);
        assert!(record
            .path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("auto-"));
        // meta 更新確認: last_backup_revision = 1, last_auto_backup_at != None
        assert_eq!(storage.last_backup_revision().unwrap(), 1);
        assert!(storage.last_auto_backup_at().unwrap().is_some());
        // data_revision は増えていない (取得は編集ではない)
        assert_eq!(storage.data_revision().unwrap(), 1);
    }

    #[test]
    fn take_pre_op_does_not_update_last_auto_at() {
        let (_temp, storage, svc) = make_service();
        storage.create_project("Project", None).unwrap();

        let record = svc
            .take(BackupKind::PreOp {
                prefix: "pre-import".into(),
            })
            .unwrap();
        assert!(record.path.exists());
        // pre-op は last_auto_backup_at を更新しない (24h ゲート巻き戻し回避)
        assert!(storage.last_auto_backup_at().unwrap().is_none());
        // last_backup_revision は更新する
        assert_eq!(storage.last_backup_revision().unwrap(), 1);
        // path が pre-op ディレクトリ配下
        assert!(record.path.to_string_lossy().contains("/pre-op/"));
    }

    #[test]
    fn take_manual_does_not_rotate() {
        let (_temp, storage, svc) = make_service();
        // manual は ローテーション無し: 11 件作っても全部残る
        for i in 0..11 {
            storage.create_project(&format!("p-{i}"), None).unwrap();
            let r = svc.take(BackupKind::Manual).unwrap();
            assert!(r.path.exists());
            // 連続した同 ts で衝突しないように 1ms スリープ等は不要 (ms 解像度)
            // ただし高速マシンでは同 ms が起き得るので試行回数だけ確認
        }
        let dir = svc.dir_for(&BackupKind::Manual);
        let files = svc.collect_files_in_dir(&dir).unwrap();
        // ms 衝突で 11 未満になりうるが、少なくとも 8 件は確実 (現実的な負荷)
        assert!(files.len() >= 8, "got {}", files.len());
    }

    // -------- rotation --------

    #[test]
    fn rotate_keeps_only_n_newest() {
        let (temp, _storage, svc) = make_service();
        // 既知のファイル名 5 件を直接作成 (タイムスタンプの大小で並び)
        let dir = temp.path().join("backups").join("auto");
        std::fs::create_dir_all(&dir).unwrap();
        for ts_seed in &[
            "2026-01-01T00-00-00-000",
            "2026-01-02T00-00-00-000",
            "2026-01-03T00-00-00-000",
            "2026-01-04T00-00-00-000",
            "2026-01-05T00-00-00-000",
        ] {
            let p = dir.join(format!("auto-{ts_seed}-r1.sqlite"));
            File::create(&p).unwrap();
        }
        // limit=3 で古い 2 件 (Jan 1, 2) が削除されるはず
        svc.rotate(&dir, 3).unwrap();
        let remaining = svc.collect_files_in_dir(&dir).unwrap();
        assert_eq!(remaining.len(), 3);
        for path in &remaining {
            let name = path.file_name().unwrap().to_str().unwrap();
            assert!(
                name.contains("2026-01-03")
                    || name.contains("2026-01-04")
                    || name.contains("2026-01-05"),
                "should keep 3-5, got: {name}"
            );
        }
    }

    // -------- should_take_auto --------

    #[test]
    fn should_take_auto_false_when_no_changes() {
        let (_temp, _storage, svc) = make_service();
        // data_revision = 0, last_backup_revision = 0 → 変化なし
        assert!(!svc.should_take_auto().unwrap());
    }

    #[test]
    fn should_take_auto_true_when_revision_advanced_and_never_taken() {
        let (_temp, storage, svc) = make_service();
        storage.create_project("p", None).unwrap();
        // data_revision = 1, last_backup_revision = 0, last_auto_backup_at = None
        assert!(svc.should_take_auto().unwrap());
    }

    #[test]
    fn should_take_auto_false_when_within_24h() {
        let (_temp, storage, svc) = make_service();
        storage.create_project("p", None).unwrap();
        storage.create_project("q", None).unwrap();
        // 最初の auto を取る → last_backup_revision = 2, last_auto_backup_at = now
        let _r = svc.take(BackupKind::Auto).unwrap();

        // さらにデータ変更
        storage.create_project("r", None).unwrap();
        // 24h 未経過なので false (last_auto_backup_at が直近)
        assert!(!svc.should_take_auto().unwrap());
    }

    // -------- list --------

    #[test]
    fn list_returns_all_records_sorted_desc() {
        let (_temp, storage, svc) = make_service();
        storage.create_project("p1", None).unwrap();
        let _a1 = svc.take(BackupKind::Auto).unwrap();
        // 後の取得が created_at で新しくなるはずだが ms 衝突の可能性があるので、
        // スリープせず順番に取って "2 件以上 listed" と "kind が Auto / Manual" だけ確認
        storage.create_project("p2", None).unwrap();
        let _m1 = svc.take(BackupKind::Manual).unwrap();

        let records = svc.list().unwrap();
        assert_eq!(records.len(), 2);
        // 種別が含まれていること
        let kinds: std::collections::HashSet<_> = records
            .iter()
            .map(|r| match &r.kind {
                BackupKind::Auto => "auto",
                BackupKind::Manual => "manual",
                BackupKind::PreOp { .. } => "pre-op",
            })
            .collect();
        assert!(kinds.contains("auto"));
        assert!(kinds.contains("manual"));
    }

    #[test]
    fn list_skips_files_with_unparseable_names() {
        let (temp, _storage, svc) = make_service();
        let dir = temp.path().join("backups").join("auto");
        std::fs::create_dir_all(&dir).unwrap();
        // 解析できない名前
        File::create(dir.join("garbage.sqlite")).unwrap();
        File::create(dir.join("auto-bad-name.sqlite")).unwrap();
        // 解析できる名前
        File::create(dir.join("auto-2026-01-01T00-00-00-000-r5.sqlite")).unwrap();

        let records = svc.list().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, BackupKind::Auto);
        assert_eq!(records[0].data_revision, 5);
    }

    // -------- delete --------

    #[test]
    fn delete_removes_file_inside_root() {
        let (_temp, storage, svc) = make_service();
        storage.create_project("p", None).unwrap();
        let r = svc.take(BackupKind::Manual).unwrap();
        assert!(r.path.exists());
        svc.delete(&r.path).unwrap();
        assert!(!r.path.exists());
    }

    #[test]
    fn delete_rejects_path_outside_root() {
        let (temp, _storage, svc) = make_service();
        // backups_root の外側のファイル
        let outside = temp.path().join("not-a-backup.sqlite");
        File::create(&outside).unwrap();
        let err = svc.delete(&outside).unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
        // 元ファイルは残っている (削除しなかった)
        assert!(outside.exists());
    }

    #[test]
    fn delete_nonexistent_file_returns_not_found() {
        let (_temp, _storage, svc) = make_service();
        let path = svc
            .backups_root
            .join("auto")
            .join("nonexistent-2026-01-01T00-00-00-000-r1.sqlite");
        let err = svc.delete(&path).unwrap_err();
        assert!(matches!(err, AppError::NotFound { .. }));
    }

    // -------- verify_integrity --------

    #[test]
    fn verify_integrity_succeeds_for_valid_backup() {
        let (_temp, storage, svc) = make_service();
        storage.create_project("p", None).unwrap();
        let r = svc.take(BackupKind::Manual).unwrap();
        svc.verify_integrity(&r.path).unwrap();
    }

    #[test]
    fn verify_integrity_fails_for_corrupted_file() {
        let (temp, _storage, svc) = make_service();
        let dir = temp.path().join("backups").join("manual");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("manual-2026-01-01T00-00-00-000-r1.sqlite");
        // 不正な内容を書き込む
        std::fs::write(&path, b"not a sqlite database").unwrap();
        let err = svc.verify_integrity(&path).unwrap_err();
        // SQLite が open 段階で失敗するか、integrity_check が ok 以外を返すかどちらか
        match err {
            AppError::Storage(_) => {}
            other => panic!("expected Storage error, got: {other:?}"),
        }
    }

    #[test]
    fn verify_integrity_rejects_nonexistent_path() {
        // PR #30 codex P1 回帰: 不在 path に対して `Connection::open` が空 DB を作らないこと。
        // 結果は `AppError::NotFound`、ファイルは作られない (read-only flag + exists 二段)。
        let (temp, _storage, svc) = make_service();
        let bogus = temp
            .path()
            .join("backups")
            .join("manual")
            .join("does-not-exist-2026-01-01T00-00-00-000-r1.sqlite");
        let err = svc.verify_integrity(&bogus).unwrap_err();
        match err {
            AppError::NotFound { entity, .. } => assert_eq!(entity, "backup file"),
            other => panic!("expected NotFound, got: {other:?}"),
        }
        assert!(!bogus.exists(), "verify_integrity must not create the file");
    }

    #[test]
    fn restore_from_rejects_nonexistent_source() {
        // PR #30 codex P1 関連の二重防御: restore でも空 DB を作らない
        let (_temp, storage, svc) = make_service();
        storage.create_project("p", None).unwrap();
        let bogus = svc
            .backups_root
            .join("manual")
            .join("missing-2026-01-01T00-00-00-000-r1.sqlite");
        let err = svc.restore_from(&bogus).unwrap_err();
        match err {
            AppError::NotFound { entity, .. } => assert_eq!(entity, "backup file"),
            other => panic!("expected NotFound, got: {other:?}"),
        }
        // アクティブ DB が壊れていない (project は残っている)
        assert_eq!(storage.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn rotate_pre_op_sorts_by_timestamp_not_full_filename() {
        // PR #30 codex P2 回帰: pre-op ディレクトリは複数 prefix が混在するため、フルファイル名の
        // 辞書順だと prefix が支配的でローテーションが時系列とずれる。timestamp で比較すべき。
        //
        // 仕掛け: prefix 文字列の辞書順は `pre-aaa < pre-import < pre-zzz`、timestamp 順は
        // **逆方向**: aaa が最新 / zzz が最古 になるよう手動配置する。
        // limit=2 で残るべきは「最新の 2 つ」(`aaa` と `import`) であり、
        // フルファイル名ソートだと `aaa < import < zzz` なので最古とみなされる zzz が削除されて
        // **誤って通る**。timestamp ソートだと最古は zzz の timestamp が最も小さいべきとなる。
        let (temp, _storage, svc) = make_service();
        let dir = temp.path().join("backups").join("pre-op");
        std::fs::create_dir_all(&dir).unwrap();
        // タイムスタンプ降順 (新しい→古い): aaa(2026-03), import(2026-02), zzz(2026-01)
        let entries = [
            ("pre-zzz", "2026-01-01T00-00-00-000"),    // 最古
            ("pre-import", "2026-02-01T00-00-00-000"), // 中
            ("pre-aaa", "2026-03-01T00-00-00-000"),    // 最新
        ];
        for (prefix, ts) in entries.iter() {
            let path = dir.join(format!("{prefix}-{ts}-r1.sqlite"));
            File::create(&path).unwrap();
        }
        // limit=2 で削除されるのは「最古」= 2026-01 の zzz のみのはず
        svc.rotate(&dir, 2).unwrap();
        let remaining = svc.collect_files_in_dir(&dir).unwrap();
        assert_eq!(remaining.len(), 2);
        let names: std::collections::HashSet<&str> = remaining
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect();
        // aaa (2026-03) と import (2026-02) が残る、zzz (2026-01) が削除される
        assert!(names.iter().any(|n| n.starts_with("pre-aaa-2026-03-01")));
        assert!(names.iter().any(|n| n.starts_with("pre-import-2026-02-01")));
        assert!(!names.iter().any(|n| n.starts_with("pre-zzz-")));
    }

    #[test]
    fn extract_filename_timestamp_works_for_valid_names() {
        let p = std::path::Path::new("/tmp/auto-2026-04-30T15-23-45-123-r142.sqlite");
        assert_eq!(
            extract_filename_timestamp(p).as_deref(),
            Some("2026-04-30T15-23-45-123")
        );
        let p2 =
            std::path::Path::new("/tmp/pre-delete-project-uuid-2026-04-30T15-23-45-123-r1.sqlite");
        assert_eq!(
            extract_filename_timestamp(p2).as_deref(),
            Some("2026-04-30T15-23-45-123")
        );
    }

    #[test]
    fn extract_filename_timestamp_rejects_invalid() {
        // `-r` の後が非数字
        assert_eq!(
            extract_filename_timestamp(std::path::Path::new(
                "auto-2026-04-30T15-23-45-123-rev.sqlite"
            )),
            None
        );
        // ts 区切りが `:` (canonical JST_ISO8601 形式)
        assert_eq!(
            extract_filename_timestamp(std::path::Path::new(
                "auto-2026-04-30T15:23:45.123-r1.sqlite"
            )),
            None
        );
        // 拡張子違い
        assert_eq!(
            extract_filename_timestamp(std::path::Path::new("auto-2026-04-30T15-23-45-123-r1.bak")),
            None
        );
    }

    // -------- restore --------

    #[test]
    fn restore_from_overwrites_active_db() {
        let (_temp, storage, svc) = make_service();
        // 状態 A を作って backup
        storage.create_project("Project A", None).unwrap();
        let backup_a = svc.take(BackupKind::Manual).unwrap();
        let revision_at_a = storage.data_revision().unwrap();

        // 状態 B にして
        storage.create_project("Project B", None).unwrap();
        let revision_at_b = storage.data_revision().unwrap();
        assert!(revision_at_b > revision_at_a);

        // backup_a (= 状態 A) からリストア
        svc.verify_integrity(&backup_a.path).unwrap();
        svc.restore_from(&backup_a.path).unwrap();

        // データが状態 A に戻っているか確認 (data_revision も A 時点に巻き戻る)
        let projects = storage.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Project A");
        assert_eq!(storage.data_revision().unwrap(), revision_at_a);
    }

    // -------- filename parsing --------

    #[test]
    fn parse_filename_timestamp_round_trip() {
        let dt = jst_offset()
            .from_local_datetime(&chrono::NaiveDateTime::new(
                chrono::NaiveDate::from_ymd_opt(2026, 4, 30).unwrap(),
                chrono::NaiveTime::from_hms_milli_opt(15, 23, 45, 123).unwrap(),
            ))
            .single()
            .unwrap();
        let s = crate::time::format_jst_filename_timestamp(&dt);
        let parsed = parse_filename_timestamp(&s).unwrap();
        assert_eq!(parsed, dt);
    }

    #[test]
    fn parse_filename_timestamp_rejects_wrong_length() {
        assert!(parse_filename_timestamp("2026-04-30").is_none());
        assert!(parse_filename_timestamp("").is_none());
    }

    #[test]
    fn parse_filename_timestamp_rejects_invalid_separators() {
        // `:` を含む (canonical JST_ISO8601 形式) → 拒否
        assert!(parse_filename_timestamp("2026-04-30T15:23:45.123").is_none());
    }

    // -------- restore: containment check (PR #35 codex P1 回帰) --------

    #[test]
    fn restore_from_rejects_path_outside_root() {
        // `backups_root` 配下でない健全な SQLite ファイルを restore に渡しても拒否される
        // (path injection 防止、PR #35 codex P1)
        let (temp, storage, svc) = make_service();
        // 状態 A → backup 取得 (root 内に存在)
        storage.create_project("inside", None).unwrap();
        let _r = svc.take(BackupKind::Manual).unwrap();
        // root の **外** に有効な SQLite ファイルを別途作成 (攻撃シナリオ模倣)
        let outside_db = temp.path().join("outside-malicious.sqlite");
        let _ = SqliteStorage::open(&outside_db).unwrap();
        // restore_from に渡しても Validation で拒否される
        let err = svc.restore_from(&outside_db).unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
        // アクティブ DB は影響を受けない (project は残っている)
        assert_eq!(storage.list_projects().unwrap().len(), 1);
        assert_eq!(storage.list_projects().unwrap()[0].name, "inside");
    }
}
