//! フォルダを再帰的に走査し、容量をフォルダごとに集計する (ADR-0025)。
//!
//! - 明示スタックの深さ優先で、単一スレッドで読む。リンク (Windows のジャンクションを含む) と
//!   別のボリュームには入らない
//! - フォルダは全件を持ち、ファイルは大きい順の上位だけを名前付きで残す (`TopFiles`)
//! - 返すのは「サイズ」と「ディスク上」それぞれの上位 `top_k` 件の和集合と、読めないフォルダ。
//!   親は子以上の大きさなので、同じ大きさなら浅い方を先に並べれば祖先は必ず含まれる。
//!   含めなかった直下の項目は、フォルダごとに `other_*` へまとめる

use std::cmp::Reverse;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf, MAIN_SEPARATOR_STR};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::modules::network_path::is_network_path;

use super::platform::{self, Allocation};
use super::progress::DirSizeProgress;

const MODULE_ID: &str = "dirsize";
/// 基準ごとに返す項目の数。2 基準の和集合で最大 2 倍になる
pub const TOP_K: usize = 10_000;
/// 走査するフォルダの上限。達したら止めて途中までの集計を返す (1 フォルダ約 100 バイト)
pub const MAX_DIRS: usize = 1_000_000;
/// パスを返す読めないフォルダの数
const MAX_UNREADABLE_PATHS: usize = 100;
/// 上位に入らなくてもツリーに残す読めないフォルダの数
const MAX_UNREADABLE_NODES: usize = 1_000;
/// 進捗を送る最短間隔 (hash と同じ)
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// 1 つのフォルダに大量のファイルがある時も、この件数ごとに進捗を送れるか確かめる
const PROGRESS_CHECK_ENTRIES: u64 = 1024;
const NO_PARENT: u32 = u32::MAX;

#[derive(Debug, Clone, Copy)]
pub(super) struct Limits {
    pub top_k: usize,
    pub max_dirs: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            top_k: TOP_K,
            max_dirs: MAX_DIRS,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DirSizeNodeKind {
    Dir,
    File,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirSizeNode {
    pub id: u32,
    /// ルートだけ `None`
    pub parent_id: Option<u32>,
    /// ルートは指定されたパスそのもの
    pub name: String,
    pub kind: DirSizeNodeKind,
    /// ファイル内容のバイト数 (フォルダは配下の合計)
    pub logical: u64,
    /// ディスク上で確保された領域 (フォルダは配下の合計)
    pub allocated: u64,
    /// 配下のファイル数 (ファイル自身は 1)
    pub file_count: u64,
    /// 配下のフォルダ数 (自身は含まない)
    pub dir_count: u64,
    /// 結果に含めなかった直下の項目の数と大きさ
    pub other_count: u64,
    pub other_logical: u64,
    pub other_allocated: u64,
    /// 一覧を読めなかったフォルダ。大きさは分かった分だけ
    pub unreadable: bool,
    /// 名前を UTF-8 にできず置換文字で表した。パスを組み立てても開けない
    pub lossy_name: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct DirSizeUnreadable {
    pub count: u64,
    /// 先頭 `MAX_UNREADABLE_PATHS` 件
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct DirSizeSkipped {
    /// 辿らなかったシンボリックリンク・ジャンクション・マウントポイント
    pub links: u64,
    /// 別のボリュームのフォルダ
    pub other_volumes: u64,
    /// 2 回目以降に見つけたハードリンク
    pub hard_links: u64,
    /// 種類や大きさを読めなかった項目
    pub entries: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct VolumeUsage {
    pub total_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirSizeScanResult {
    pub root_path: String,
    /// パスの区切り文字。フロントはルートと名前からパスを組み立てる
    pub separator: String,
    pub nodes: Vec<DirSizeNode>,
    pub total_files: u64,
    pub total_dirs: u64,
    pub unreadable: DirSizeUnreadable,
    pub skipped: DirSizeSkipped,
    /// Windows でドライブ直下を走査した時だけ
    pub volume: Option<VolumeUsage>,
    /// フォルダ数の上限で走査を止めた
    pub limit_reached: bool,
    pub top_limit: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Metric {
    Logical,
    Allocated,
}

impl Metric {
    const ALL: [Metric; 2] = [Metric::Logical, Metric::Allocated];

    fn index(self) -> usize {
        match self {
            Metric::Logical => 0,
            Metric::Allocated => 1,
        }
    }
}

/// 並べる順の鍵。小さいほど上位: 大きい順、同じなら浅い順、同じ深さならフォルダが先、最後は発見順
type RankKey = (Reverse<u64>, u32, u8, u64);

struct DirRecord {
    parent: u32,
    depth: u32,
    name: Box<str>,
    lossy: bool,
    logical: u64,
    allocated: u64,
    file_count: u64,
    dir_count: u64,
    /// 数えた直下の項目 (ファイルと、入った / 読めなかったフォルダ)
    children: u64,
    unreadable: bool,
}

impl DirRecord {
    fn new(parent: u32, depth: u32, name: Box<str>, lossy: bool) -> Self {
        Self {
            parent,
            depth,
            name,
            lossy,
            logical: 0,
            allocated: 0,
            file_count: 0,
            dir_count: 0,
            children: 0,
            unreadable: false,
        }
    }

    fn key(&self, index: usize, metric: Metric) -> RankKey {
        let size = match metric {
            Metric::Logical => self.logical,
            Metric::Allocated => self.allocated,
        };
        (Reverse(size), self.depth, 0, index as u64)
    }
}

struct FileRecord {
    parent: u32,
    depth: u32,
    name: Box<str>,
    lossy: bool,
    logical: u64,
    allocated: u64,
    /// 発見順。同じ大きさ・深さの順を決める
    seq: u64,
}

impl FileRecord {
    fn key(&self, metric: Metric) -> RankKey {
        file_key(self.logical, self.allocated, self.depth, self.seq, metric)
    }
}

fn file_key(logical: u64, allocated: u64, depth: u32, seq: u64, metric: Metric) -> RankKey {
    let size = match metric {
        Metric::Logical => logical,
        Metric::Allocated => allocated,
    };
    (Reverse(size), depth, 1, seq)
}

/// 基準ごとの上位 `k` 件のファイルを残す。全件を持たずに済ませるため、`4k` 件たまったら
/// 基準ごとの上位 `k` 件の和集合へ減らし、`k` 番目より下位の候補はそれ以降受け付けない。
struct TopFiles {
    k: usize,
    files: Vec<FileRecord>,
    /// 基準ごとの `k` 番目の鍵。これより下位なら上位 `k` 件には入れない
    worst: [Option<RankKey>; 2],
}

impl TopFiles {
    fn new(k: usize) -> Self {
        Self {
            k,
            files: Vec::new(),
            worst: [None, None],
        }
    }

    fn accepts(&self, logical: u64, allocated: u64, depth: u32, seq: u64) -> bool {
        Metric::ALL.iter().any(|&metric| {
            self.worst[metric.index()]
                .is_none_or(|worst| file_key(logical, allocated, depth, seq, metric) < worst)
        })
    }

    fn push(&mut self, file: FileRecord) {
        self.files.push(file);
        if self.files.len() >= self.k.saturating_mul(4) {
            self.prune();
        }
    }

    fn prune(&mut self) {
        let k = self.k;
        if self.files.len() <= k {
            return;
        }
        let mut keep = vec![false; self.files.len()];
        let mut order: Vec<usize> = (0..self.files.len()).collect();
        for metric in Metric::ALL {
            let files = &self.files;
            order.select_nth_unstable_by_key(k - 1, |&i| files[i].key(metric));
            for &i in &order[..k] {
                keep[i] = true;
            }
            self.worst[metric.index()] = Some(files[order[k - 1]].key(metric));
        }
        let mut index = 0;
        self.files.retain(|_| {
            let kept = keep[index];
            index += 1;
            kept
        });
    }
}

struct Throttle {
    last_sent: Option<Instant>,
}

impl Throttle {
    fn due(&mut self) -> bool {
        if self
            .last_sent
            .is_none_or(|sent| sent.elapsed() >= PROGRESS_INTERVAL)
        {
            self.last_sent = Some(Instant::now());
            true
        } else {
            false
        }
    }
}

/// 走査の途中の状態
struct Walk {
    dirs: Vec<DirRecord>,
    top: TopFiles,
    hard_links: HashSet<(u64, u64)>,
    skipped: DirSizeSkipped,
    unreadable: DirSizeUnreadable,
    limit_reached: bool,
    files_seen: u64,
    logical_seen: u64,
    seq: u64,
}

/// ルートを確かめる。ネットワーク上の場所は、ファイルシステムに触る前に文字列で拒否する
/// (Windows で SMB 接続が走り、サインイン情報がサーバへ送られるのを避ける)。
pub(super) fn validate_root(root_path: &str) -> Result<(PathBuf, fs::Metadata), AppError> {
    if root_path.trim().is_empty() {
        return Err(validation("フォルダを指定してください。"));
    }
    if is_network_path(root_path) {
        return Err(validation(
            "ネットワーク上の場所は対象外です。ローカルのフォルダを指定してください。",
        ));
    }
    let root = PathBuf::from(root_path);
    if !root.is_absolute() {
        return Err(validation("フォルダは絶対パスで指定してください。"));
    }
    platform::ensure_local_volume(&root).map_err(validation)?;
    let metadata = fs::metadata(&root).map_err(|error| match error.kind() {
        ErrorKind::NotFound => validation("フォルダが見つかりません。"),
        _ => AppError::Io(format!("{root_path} を読めません: {error}")),
    })?;
    if !metadata.is_dir() {
        return Err(validation(
            "フォルダを指定してください。ファイルは対象外です。",
        ));
    }
    Ok((root, metadata))
}

pub(super) fn scan_inner(
    root_path: &str,
    limits: Limits,
    token: &CancellationToken,
    operation_id: &str,
    progress: &mut impl FnMut(DirSizeProgress),
) -> Result<DirSizeScanResult, AppError> {
    let started = Instant::now();
    ensure_not_cancelled(token, operation_id)?;
    let (root, root_metadata) = validate_root(root_path)?;
    progress(DirSizeProgress::Started);

    let mut walk = Walk {
        dirs: vec![DirRecord::new(NO_PARENT, 0, root_path.into(), false)],
        top: TopFiles::new(limits.top_k.max(1)),
        hard_links: HashSet::new(),
        skipped: DirSizeSkipped::default(),
        unreadable: DirSizeUnreadable::default(),
        limit_reached: false,
        files_seen: 0,
        logical_seen: 0,
        seq: 0,
    };
    walk_tree(
        &root,
        &root_metadata,
        limits,
        &mut walk,
        token,
        operation_id,
        progress,
    )?;
    propagate_totals(&mut walk.dirs);

    // R-10: 結果を返す直前にも確かめる
    ensure_not_cancelled(token, operation_id)?;
    let nodes = select_nodes(&walk.dirs, &walk.top.files, limits.top_k.max(1));
    let root_record = &walk.dirs[0];
    let duration_ms = elapsed_ms(started);
    progress(DirSizeProgress::Done { duration_ms });
    Ok(DirSizeScanResult {
        root_path: root_path.to_string(),
        separator: MAIN_SEPARATOR_STR.to_string(),
        total_files: root_record.file_count,
        total_dirs: root_record.dir_count,
        nodes,
        unreadable: walk.unreadable,
        skipped: walk.skipped,
        volume: platform::volume_usage(root_path),
        limit_reached: walk.limit_reached,
        top_limit: u32::try_from(limits.top_k).unwrap_or(u32::MAX),
        duration_ms,
    })
}

fn walk_tree(
    root: &Path,
    root_metadata: &fs::Metadata,
    limits: Limits,
    walk: &mut Walk,
    token: &CancellationToken,
    operation_id: &str,
    progress: &mut impl FnMut(DirSizeProgress),
) -> Result<(), AppError> {
    let root_device = platform::device_id(root_metadata);
    let allocation = Allocation::for_root(root);
    let mut throttle = Throttle { last_sent: None };
    let mut stack: Vec<(u32, PathBuf)> = vec![(0, root.to_path_buf())];

    'walk: while let Some((index, path)) = stack.pop() {
        ensure_not_cancelled(token, operation_id)?;
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if index == 0 => {
                return Err(AppError::Io(format!(
                    "{} を読めません: {error}",
                    path.display()
                )));
            }
            Err(_) => {
                walk.dirs[index as usize].unreadable = true;
                walk.unreadable.count += 1;
                if walk.unreadable.paths.len() < MAX_UNREADABLE_PATHS {
                    walk.unreadable.paths.push(path.display().to_string());
                }
                continue;
            }
        };
        if throttle.due() {
            send_progress(walk, &path, progress);
        }
        let depth = walk.dirs[index as usize].depth + 1;
        let mut read: u64 = 0;
        for entry in entries {
            ensure_not_cancelled(token, operation_id)?;
            read += 1;
            if read.is_multiple_of(PROGRESS_CHECK_ENTRIES) && throttle.due() {
                send_progress(walk, &path, progress);
            }
            let Ok(entry) = entry else {
                walk.skipped.entries += 1;
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                walk.skipped.entries += 1;
                continue;
            };
            // Windows では name surrogate の reparse point (ジャンクション・マウントポイント) も is_symlink
            if file_type.is_symlink() {
                walk.skipped.links += 1;
                continue;
            }
            // symlink を辿らない metadata。Windows は FindNextFile の値で、ファイルを開かない
            let Ok(metadata) = entry.metadata() else {
                walk.skipped.entries += 1;
                continue;
            };
            let (name, lossy) = display_name(&entry.file_name());
            if file_type.is_dir() {
                if platform::device_id(&metadata) != root_device {
                    walk.skipped.other_volumes += 1;
                    continue;
                }
                if walk.dirs.len() >= limits.max_dirs {
                    walk.limit_reached = true;
                    break 'walk;
                }
                let child = walk.dirs.len() as u32;
                walk.dirs.push(DirRecord::new(index, depth, name, lossy));
                walk.dirs[index as usize].children += 1;
                stack.push((child, entry.path()));
            } else {
                if let Some(key) = platform::hard_link_key(&metadata) {
                    if !walk.hard_links.insert(key) {
                        walk.skipped.hard_links += 1;
                        continue;
                    }
                }
                let logical = metadata.len();
                let allocated = allocation.allocated_size(&entry, &metadata);
                let dir = &mut walk.dirs[index as usize];
                dir.logical += logical;
                dir.allocated += allocated;
                dir.file_count += 1;
                dir.children += 1;
                walk.files_seen += 1;
                walk.logical_seen += logical;
                walk.seq += 1;
                if walk.top.accepts(logical, allocated, depth, walk.seq) {
                    walk.top.push(FileRecord {
                        parent: index,
                        depth,
                        name,
                        lossy,
                        logical,
                        allocated,
                        seq: walk.seq,
                    });
                }
            }
        }
    }
    Ok(())
}

fn send_progress(walk: &Walk, path: &Path, progress: &mut impl FnMut(DirSizeProgress)) {
    progress(DirSizeProgress::Scanning {
        files: walk.files_seen,
        dirs: walk.dirs.len() as u64 - 1,
        logical_bytes: walk.logical_seen,
        current_dir: path.display().to_string(),
    });
}

/// 子の合計を親へ足す。深さ優先で見つけた順に並べたので、親は必ず子より前にある。
fn propagate_totals(dirs: &mut [DirRecord]) {
    for index in (1..dirs.len()).rev() {
        let child = &dirs[index];
        let (parent, logical, allocated, files, sub_dirs) = (
            child.parent as usize,
            child.logical,
            child.allocated,
            child.file_count,
            child.dir_count,
        );
        let parent = &mut dirs[parent];
        parent.logical += logical;
        parent.allocated += allocated;
        parent.file_count += files;
        parent.dir_count += sub_dirs + 1;
    }
}

#[derive(Clone, Copy)]
enum Candidate {
    Dir(usize),
    File(usize),
}

/// 返すノードを選び、親への参照と「ほか」の値を付ける。
fn select_nodes(dirs: &[DirRecord], files: &[FileRecord], top_k: usize) -> Vec<DirSizeNode> {
    let mut dir_included = vec![false; dirs.len()];
    let mut file_included = vec![false; files.len()];

    let mut candidates: Vec<Candidate> = (0..dirs.len())
        .map(Candidate::Dir)
        .chain((0..files.len()).map(Candidate::File))
        .collect();
    for metric in Metric::ALL {
        let key = |candidate: &Candidate| match *candidate {
            Candidate::Dir(i) => dirs[i].key(i, metric),
            Candidate::File(i) => files[i].key(metric),
        };
        let k = top_k.min(candidates.len());
        if k < candidates.len() {
            candidates.select_nth_unstable_by(k - 1, |a, b| key(a).cmp(&key(b)));
        }
        for candidate in &candidates[..k] {
            match *candidate {
                Candidate::Dir(i) => dir_included[i] = true,
                Candidate::File(i) => file_included[i] = true,
            }
        }
    }

    // 読めないフォルダは中身が 0 扱いで上位に入らないため、祖先ごと残す
    for index in dirs
        .iter()
        .enumerate()
        .filter(|(_, dir)| dir.unreadable)
        .map(|(index, _)| index)
        .take(MAX_UNREADABLE_NODES)
    {
        include_with_ancestors(dirs, &mut dir_included, index);
    }
    // 並べ方から祖先は上位に入っているはずだが、親の無いノードを作らないよう念のため補う
    for index in 1..dirs.len() {
        if dir_included[index] {
            include_with_ancestors(dirs, &mut dir_included, dirs[index].parent as usize);
        }
    }
    for (index, file) in files.iter().enumerate() {
        if file_included[index] {
            include_with_ancestors(dirs, &mut dir_included, file.parent as usize);
        }
    }

    let mut node_ids = vec![NO_PARENT; dirs.len()];
    let mut nodes: Vec<DirSizeNode> = Vec::new();
    for (index, dir) in dirs.iter().enumerate() {
        if !dir_included[index] {
            continue;
        }
        let id = nodes.len() as u32;
        node_ids[index] = id;
        let parent_id = (dir.parent != NO_PARENT).then(|| node_ids[dir.parent as usize]);
        nodes.push(DirSizeNode {
            id,
            parent_id,
            name: dir.name.to_string(),
            kind: DirSizeNodeKind::Dir,
            logical: dir.logical,
            allocated: dir.allocated,
            file_count: dir.file_count,
            dir_count: dir.dir_count,
            other_count: dir.children,
            other_logical: dir.logical,
            other_allocated: dir.allocated,
            unreadable: dir.unreadable,
            lossy_name: dir.lossy,
        });
        if let Some(parent_id) = parent_id {
            subtract_from_other(&mut nodes[parent_id as usize], dir.logical, dir.allocated);
        }
    }
    for (index, file) in files.iter().enumerate() {
        if !file_included[index] {
            continue;
        }
        let parent_id = node_ids[file.parent as usize];
        nodes.push(DirSizeNode {
            id: nodes.len() as u32,
            parent_id: Some(parent_id),
            name: file.name.to_string(),
            kind: DirSizeNodeKind::File,
            logical: file.logical,
            allocated: file.allocated,
            file_count: 1,
            dir_count: 0,
            other_count: 0,
            other_logical: 0,
            other_allocated: 0,
            unreadable: false,
            lossy_name: file.lossy,
        });
        subtract_from_other(&mut nodes[parent_id as usize], file.logical, file.allocated);
    }
    nodes
}

fn include_with_ancestors(dirs: &[DirRecord], included: &mut [bool], mut current: usize) {
    while !included[current] {
        included[current] = true;
        match dirs[current].parent {
            NO_PARENT => break,
            parent => current = parent as usize,
        }
    }
}

fn subtract_from_other(parent: &mut DirSizeNode, logical: u64, allocated: u64) {
    parent.other_count = parent.other_count.saturating_sub(1);
    parent.other_logical = parent.other_logical.saturating_sub(logical);
    parent.other_allocated = parent.other_allocated.saturating_sub(allocated);
}

fn display_name(name: &OsStr) -> (Box<str>, bool) {
    match name.to_str() {
        Some(text) => (text.into(), false),
        None => (name.to_string_lossy().into(), true),
    }
}

fn ensure_not_cancelled(token: &CancellationToken, operation_id: &str) -> Result<(), AppError> {
    if token.is_cancelled() {
        Err(AppError::Cancelled {
            operation_id: operation_id.to_string(),
        })
    } else {
        Ok(())
    }
}

fn validation(reason: impl Into<String>) -> AppError {
    AppError::Validation {
        module_id: MODULE_ID.into(),
        reason: reason.into(),
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    const KIB: u64 = 1024;

    fn token() -> CancellationToken {
        CancellationToken::new()
    }

    fn write_file(path: &Path, size: u64) {
        // 0 以外で埋め、スパースにならないようにする。4 KiB の倍数なら「ディスク上」もほぼ同じ値になる
        let mut file = File::create(path).unwrap();
        file.write_all(&vec![1u8; size as usize]).unwrap();
    }

    /// root/
    ///   a.bin (16 KiB)
    ///   big/
    ///     b.bin (64 KiB)
    ///     inner/c.bin (32 KiB)
    ///   small/d.bin (4 KiB)
    ///   empty/
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("a.bin"), 16 * KIB);
        fs::create_dir_all(root.join("big/inner")).unwrap();
        write_file(&root.join("big/b.bin"), 64 * KIB);
        write_file(&root.join("big/inner/c.bin"), 32 * KIB);
        fs::create_dir(root.join("small")).unwrap();
        write_file(&root.join("small/d.bin"), 4 * KIB);
        fs::create_dir(root.join("empty")).unwrap();
        dir
    }

    fn scan(root: &Path, limits: Limits) -> Result<DirSizeScanResult, AppError> {
        scan_inner(root.to_str().unwrap(), limits, &token(), "op", &mut |_| {})
    }

    fn node<'a>(result: &'a DirSizeScanResult, name: &str) -> &'a DirSizeNode {
        result
            .nodes
            .iter()
            .find(|node| node.name == name)
            .unwrap_or_else(|| panic!("missing node: {name}"))
    }

    fn has_node(result: &DirSizeScanResult, name: &str) -> bool {
        result.nodes.iter().any(|node| node.name == name)
    }

    /// ルート以外は親を持ち、親は先に並んだフォルダ
    fn assert_parents_are_included(result: &DirSizeScanResult) {
        for node in &result.nodes {
            match node.parent_id {
                None => assert_eq!(node.id, 0),
                Some(parent) => {
                    assert!(parent < node.id || node.kind == DirSizeNodeKind::File);
                    assert_eq!(
                        result.nodes[parent as usize].kind,
                        DirSizeNodeKind::Dir,
                        "{}",
                        node.name
                    );
                }
            }
        }
    }

    fn reason(error: AppError) -> String {
        match error {
            AppError::Validation { module_id, reason } => {
                assert_eq!(module_id, "dirsize");
                reason
            }
            other => panic!("expected validation error: {other:?}"),
        }
    }

    #[test]
    fn totals_are_aggregated_per_folder() {
        let dir = fixture();
        let result = scan(dir.path(), Limits::default()).unwrap();

        assert_eq!(result.nodes.len(), 9);
        let root = &result.nodes[0];
        assert_eq!(root.parent_id, None);
        assert_eq!(root.name, dir.path().to_str().unwrap());
        assert_eq!(root.logical, 116 * KIB);
        assert_eq!(root.file_count, 4);
        assert_eq!(root.dir_count, 4);
        assert_eq!(result.total_files, 4);
        assert_eq!(result.total_dirs, 4);
        let big = node(&result, "big");
        assert_eq!(big.logical, 96 * KIB);
        assert_eq!(big.file_count, 2);
        assert_eq!(big.dir_count, 1);
        assert_eq!(node(&result, "empty").logical, 0);
        assert_eq!(node(&result, "c.bin").kind, DirSizeNodeKind::File);
        // 「ディスク上」はファイルシステム次第だが、0 でなく内容の大きさ以上になる
        assert!(root.allocated >= 116 * KIB);
        for node in &result.nodes {
            assert_eq!(node.other_count, 0, "{}", node.name);
            assert_eq!(node.other_logical, 0, "{}", node.name);
        }
        assert_parents_are_included(&result);
        assert_eq!(result.separator, MAIN_SEPARATOR_STR);
        assert_eq!(result.unreadable, DirSizeUnreadable::default());
        assert!(!result.limit_reached);
        assert_eq!(result.top_limit, TOP_K as u32);
        assert_eq!(result.volume, None);
    }

    #[test]
    fn only_the_largest_items_are_returned_with_the_rest_summarized() {
        let dir = fixture();
        let result = scan(
            dir.path(),
            Limits {
                top_k: 3,
                ..Limits::default()
            },
        )
        .unwrap();

        // どちらの基準でも上位 3 件は root / big / b.bin
        let names: Vec<&str> = result.nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(has_node(&result, "big"));
        assert!(has_node(&result, "b.bin"));
        assert_parents_are_included(&result);

        let root = &result.nodes[0];
        assert_eq!(root.other_count, 3); // a.bin / small / empty
        assert_eq!(root.other_logical, 20 * KIB);
        assert_eq!(
            root.other_allocated,
            root.allocated - node(&result, "big").allocated
        );
        let big = node(&result, "big");
        assert_eq!(big.other_count, 1); // inner
        assert_eq!(big.other_logical, 32 * KIB);
    }

    #[test]
    fn ties_keep_the_shallower_item_so_parents_are_included() {
        let dir = tempfile::tempdir().unwrap();
        // 1 ファイルだけのフォルダが入れ子になると、ルートから末端まで同じ大きさになる
        fs::create_dir_all(dir.path().join("x/y/z")).unwrap();
        write_file(&dir.path().join("x/y/z/only.bin"), 8 * KIB);
        for k in 1..=5 {
            let result = scan(
                dir.path(),
                Limits {
                    top_k: k,
                    ..Limits::default()
                },
            )
            .unwrap();
            assert_eq!(result.nodes.len(), k.min(5), "top_k={k}");
            assert_parents_are_included(&result);
        }
    }

    #[test]
    fn top_files_keep_exactly_the_largest_per_metric() {
        let mut top = TopFiles::new(2);
        for seq in 0..100u64 {
            // 「サイズ」と「ディスク上」で順位が逆になる
            let (logical, allocated) = (seq, 1000 - seq);
            if top.accepts(logical, allocated, 1, seq) {
                top.push(FileRecord {
                    parent: 0,
                    depth: 1,
                    name: format!("f{seq}").into(),
                    lossy: false,
                    logical,
                    allocated,
                    seq,
                });
            }
        }
        top.prune();
        let mut names: Vec<&str> = top.files.iter().map(|f| &*f.name).collect();
        names.sort();
        assert_eq!(names, ["f0", "f1", "f98", "f99"]);
    }

    #[test]
    fn many_equal_files_do_not_grow_the_candidates() {
        let mut top = TopFiles::new(2);
        for seq in 0..10_000u64 {
            if top.accepts(0, 0, 1, seq) {
                top.push(FileRecord {
                    parent: 0,
                    depth: 1,
                    name: "empty".into(),
                    lossy: false,
                    logical: 0,
                    allocated: 0,
                    seq,
                });
            }
            assert!(top.files.len() <= 8);
        }
    }

    #[test]
    fn progress_starts_and_finishes() {
        let dir = fixture();
        let mut events = Vec::new();
        scan_inner(
            dir.path().to_str().unwrap(),
            Limits::default(),
            &token(),
            "op",
            &mut |event| events.push(event),
        )
        .unwrap();
        assert_eq!(events.first(), Some(&DirSizeProgress::Started));
        assert!(matches!(events.last(), Some(DirSizeProgress::Done { .. })));
        assert!(events
            .iter()
            .any(|event| matches!(event, DirSizeProgress::Scanning { .. })));
    }

    #[test]
    fn cancelled_before_start() {
        let dir = fixture();
        let token = token();
        token.cancel();
        let result = scan_inner(
            dir.path().to_str().unwrap(),
            Limits::default(),
            &token,
            "op",
            &mut |_| {},
        );
        assert!(matches!(result, Err(AppError::Cancelled { .. })));
    }

    #[test]
    fn cancelled_while_walking() {
        let dir = fixture();
        let token = token();
        let cancel = token.clone();
        let mut events = Vec::new();
        let result = scan_inner(
            dir.path().to_str().unwrap(),
            Limits::default(),
            &token,
            "op",
            &mut |event| {
                if matches!(event, DirSizeProgress::Scanning { .. }) {
                    cancel.cancel();
                }
                events.push(event);
            },
        );
        assert!(matches!(result, Err(AppError::Cancelled { .. })));
        assert!(!events
            .iter()
            .any(|event| matches!(event, DirSizeProgress::Done { .. })));
    }

    #[test]
    fn stops_at_the_folder_limit() {
        let dir = fixture();
        let result = scan(
            dir.path(),
            Limits {
                max_dirs: 2,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(result.limit_reached);
        assert_eq!(result.total_dirs, 1);
        assert_parents_are_included(&result);
    }

    #[test]
    fn rejects_invalid_roots() {
        let dir = fixture();
        assert_eq!(
            reason(scan_inner("", Limits::default(), &token(), "op", &mut |_| {}).unwrap_err()),
            "フォルダを指定してください。"
        );
        assert_eq!(
            reason(
                scan_inner(
                    r"\\nas\share",
                    Limits::default(),
                    &token(),
                    "op",
                    &mut |_| {}
                )
                .unwrap_err()
            ),
            "ネットワーク上の場所は対象外です。ローカルのフォルダを指定してください。"
        );
        assert_eq!(
            reason(
                scan_inner(
                    "//nas/share",
                    Limits::default(),
                    &token(),
                    "op",
                    &mut |_| {}
                )
                .unwrap_err()
            ),
            "ネットワーク上の場所は対象外です。ローカルのフォルダを指定してください。"
        );
        assert_eq!(
            reason(
                scan_inner("relative/x", Limits::default(), &token(), "op", &mut |_| {})
                    .unwrap_err()
            ),
            "フォルダは絶対パスで指定してください。"
        );
        assert_eq!(
            reason(scan(&dir.path().join("missing"), Limits::default()).unwrap_err()),
            "フォルダが見つかりません。"
        );
        assert_eq!(
            reason(scan(&dir.path().join("a.bin"), Limits::default()).unwrap_err()),
            "フォルダを指定してください。ファイルは対象外です。"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() {
        let dir = fixture();
        std::os::unix::fs::symlink(dir.path().join("big"), dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("a.bin"), dir.path().join("a.link")).unwrap();
        let result = scan(dir.path(), Limits::default()).unwrap();
        assert_eq!(result.skipped.links, 2);
        assert_eq!(result.nodes[0].logical, 116 * KIB);
        assert!(!has_node(&result, "link"));
    }

    #[cfg(unix)]
    #[test]
    fn hard_links_are_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        write_file(&dir.path().join("first.bin"), 8 * KIB);
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::hard_link(
            dir.path().join("first.bin"),
            dir.path().join("sub/second.bin"),
        )
        .unwrap();
        let result = scan(dir.path(), Limits::default()).unwrap();
        assert_eq!(result.total_files, 1);
        assert_eq!(result.nodes[0].logical, 8 * KIB);
        assert_eq!(result.skipped.hard_links, 1);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_folders_are_reported_and_kept_in_the_tree() {
        use std::os::unix::fs::PermissionsExt;

        let dir = fixture();
        let locked = dir.path().join("small/locked");
        fs::create_dir(&locked).unwrap();
        write_file(&locked.join("secret.bin"), 4 * KIB);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        // root で動いていると読めてしまうので確かめられない
        let readable = fs::read_dir(&locked).is_ok();
        let result = scan(
            dir.path(),
            Limits {
                top_k: 1,
                ..Limits::default()
            },
        );
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        if readable {
            return;
        }
        let result = result.unwrap();

        assert_eq!(result.unreadable.count, 1);
        assert_eq!(result.unreadable.paths, [locked.display().to_string()]);
        // 上位 1 件 (ルート) に入らなくても、祖先ごとツリーに残る
        let locked_node = node(&result, "locked");
        assert!(locked_node.unreadable);
        assert_eq!(locked_node.logical, 0);
        assert!(has_node(&result, "small"));
        assert_parents_are_included(&result);
        assert_eq!(result.nodes[0].logical, 116 * KIB);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_root_is_an_error() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let readable = fs::read_dir(&locked).is_ok();
        let result = scan(&locked, Limits::default());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        if readable {
            return;
        }
        assert!(matches!(result, Err(AppError::Io(_))));
    }
}
